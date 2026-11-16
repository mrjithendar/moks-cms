#!/usr/bin/env python3
"""Run the retrieval evaluation (tests/fixtures/rag_eval.yaml) against one or more retriever configurations over the
blog's MDX files, and write docs/seo/rag-eval/<date>-<config>.md (+ <date>-summary.md comparing them).

  # real run (ONNX bge-small; Postgres full text in a scratch database; no pgvector needed: exact cosine in numpy)
  uv run python scripts/rag_eval.py --embeddings onnx --model-dir /models/bge-small-en-v1.5 \
      --dsn postgresql://postgres@127.0.0.1:54329/rag --configs baseline-v4,token-vector,token-hybrid
  # CI smoke (only that it runs): hashed embeddings, BM25 instead of Postgres, output to a temp dir
  uv run python scripts/rag_eval.py --embeddings hash --configs token-hybrid --out "$RUNNER_TEMP/rag-eval"

Configurations (RetrievalConfig in app/retrieval.py; chunker in app/embeddings.py):
  baseline-v4          v4: character chunker, cosine only, no diversification (production before v5)
  token-vector         token chunker, cosine only, no diversification
  token-vector-div     token chunker, cosine only, ≤ 3 chunks per article  (the v5 default: RAG_MODE=vector)
  token-hybrid-noid    token chunker, RRF (vector + full text), no identifier boost, ≤ 3 per article
  token-hybrid         token chunker, RRF + identifier boost, ≤ 3 per article  (RAG_MODE=hybrid)
  (--max-per-article N overrides the diversification of every config except the baseline)
  token-hybrid-rerank  token-hybrid + the optional cross-encoder reranker (needs --reranker-dir)

Opt-in end-to-end generation eval (real Anthropic calls, ANTHROPIC_API_KEY; capped by --generation-max-usd): Ask the
Blog's own pipeline over the eval set on the --generation-config index, answers scored for citation precision and
faithfulness by an LLM judge (app/rag_eval.py generation_eval). Writes <date>-generation.md.
  ANTHROPIC_API_KEY=… uv run python scripts/rag_eval.py --configs token-hybrid --generation --generation-max-usd 2
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.embeddings import HashEmbeddings, OnnxEmbeddings  # noqa: E402
from app.rag_eval import BLOG_DIR, EVAL_PATH, LocalIndex, evaluate, load_articles, load_eval_set, pct, render_markdown, similar_overlap  # noqa: E402
from app.retrieval import RetrievalConfig  # noqa: E402

BLOG = BLOG_DIR  # tests/fixtures/rag_corpus, or RAG_EVAL_BLOG_DIR (app/rag_eval.py)
OUT = ROOT.parent / "www" / "docs" / "seo" / "rag-eval"

CONFIGS: dict[str, tuple[str, RetrievalConfig]] = {
    "baseline-v4": ("v4", RetrievalConfig(mode="vector", max_per_article=0)),
    "token-vector": ("token", RetrievalConfig(mode="vector", max_per_article=0)),
    "token-vector-div": ("token", RetrievalConfig(mode="vector")),
    "token-hybrid-noid": ("token", RetrievalConfig(mode="hybrid", identifier_boost=0.0)),
    "token-hybrid": ("token", RetrievalConfig(mode="hybrid")),
    "token-hybrid-rerank": ("token", RetrievalConfig(mode="hybrid")),
}


class CachedEmbeddings:
    """Same inputs across configurations (both chunkers share many chunks; every config embeds the same questions):
    embed each distinct text once per run."""

    def __init__(self, inner: object):
        self.inner = inner
        self.name = inner.name  # type: ignore[attr-defined]
        self.dim = inner.dim  # type: ignore[attr-defined]
        self.counter_tokenizer = getattr(inner, "counter_tokenizer", None)
        self.cache: dict[tuple[bool, str], list[float]] = {}

    async def embed(self, texts: list[str], *, query: bool = False) -> list[list[float]]:
        todo = list(dict.fromkeys(t for t in texts if (query, t) not in self.cache))
        if todo:
            for t, v in zip(todo, await self.inner.embed(todo, query=query), strict=True):  # type: ignore[attr-defined]
                self.cache[(query, t)] = v
        return [self.cache[(query, t)] for t in texts]


def commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True, cwd=ROOT).stdout.strip()  # noqa: S607
    except Exception:
        return "unknown"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--embeddings", choices=["onnx", "hash"], default="onnx")
    ap.add_argument("--model-dir", default="/models/bge-small-en-v1.5")
    ap.add_argument("--dsn", default=None, help="scratch Postgres for full-text search (tables are dropped and recreated)")
    ap.add_argument("--configs", default="baseline-v4,token-vector,token-vector-div,token-hybrid-noid,token-hybrid")
    ap.add_argument("--floor", type=float, default=0.15)
    ap.add_argument("--rrf-k", type=int, default=None)
    ap.add_argument("--identifier-boost", type=float, default=None)
    ap.add_argument("--max-per-article", type=int, default=None, help="override diversification (0 = off)")
    ap.add_argument("--suffix", default="", help="appended to each config name in the output files")
    ap.add_argument("--reranker-dir", default=None)
    ap.add_argument("--eval", default=str(EVAL_PATH))
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--json", action="store_true", help="also print the metrics as JSON")
    ap.add_argument("--generation", action="store_true", help="opt-in: also run the end-to-end generation eval (real model calls)")
    ap.add_argument("--generation-config", default="token-hybrid")
    ap.add_argument("--generation-max-usd", type=float, default=2.0)
    ap.add_argument("--judge-model", default="claude-opus-5-5")
    a = ap.parse_args()

    emb = CachedEmbeddings(OnnxEmbeddings(a.model_dir) if a.embeddings == "onnx" else HashEmbeddings())
    articles = load_articles(BLOG)
    questions = load_eval_set(a.eval)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)  # noqa: ASYNC240 - a CLI: blocking file I/O is fine
    results = []
    built: dict[str, LocalIndex] = {}
    for name in [c.strip() for c in a.configs.split(",") if c.strip()]:
        chunker, cfg = CONFIGS[name]
        if a.rrf_k is not None:
            cfg = replace(cfg, rrf_k=a.rrf_k)
        if a.identifier_boost is not None and cfg.identifier_boost:
            cfg = replace(cfg, identifier_boost=a.identifier_boost)
        if a.max_per_article is not None and name != "baseline-v4":
            cfg = replace(cfg, max_per_article=a.max_per_article)
        label = f"{name}{a.suffix}"
        ix = LocalIndex(emb, cfg, chunker=chunker, dsn=a.dsn if cfg.mode == "hybrid" else None)
        info = await ix.build(articles)
        built.setdefault(chunker, ix)
        search = ix.search
        notes = []
        if name.endswith("-rerank"):
            from app.reranker import CrossEncoderReranker

            if not a.reranker_dir:
                print("token-hybrid-rerank needs --reranker-dir", file=sys.stderr)
                return 2
            rr = CrossEncoderReranker(a.reranker_dir)

            async def search(q: str, k: int, ix: LocalIndex = ix, rr: CrossEncoderReranker = rr) -> list:  # type: ignore[no-redef]
                cands = await ix.search(q, 20)
                return await rr.rerank(q, cands, k)

            notes.append(f"reranker: {rr.name}, top 20 fused → top {6}")
        res = await evaluate(label, search, questions, floor=a.floor, notes=notes)
        meta = {
            "date": a.date,
            "commit": commit(),
            "embeddings": emb.name,
            "text_backend": ("Postgres " + "ts_rank (english)") if (a.dsn and cfg.mode == "hybrid") else ("BM25 (in memory)" if cfg.mode == "hybrid" else "none (vector only)"),
            "articles": len(articles),
            "chunker": chunker,
            "retrieval": f"mode={cfg.mode} candidates={cfg.candidates} rrf_k={cfg.rrf_k} identifier_boost={cfg.identifier_boost:.4f} max_per_article={cfg.max_per_article}",
            **{k: v for k, v in info.items() if k != "tokens"},
        }
        (out / f"{a.date}-{label}.md").write_text(render_markdown(res, meta))
        results.append((label, res, meta))
        m = res.metrics
        print(f"{label:26s} R@1 {pct(m['recall@1']):>5} R@3 {pct(m['recall@3']):>5} R@6 {pct(m['recall@6']):>5} MRR {m['mrr']:.3f} anchor {pct(m['anchor_hit_rate']):>5} "
              f"FP@{a.floor} {pct(m['no_answer_fp_rate']):>5} cal {res.calibrated_floor} FP@cal {pct(m['no_answer_fp_rate_at_calibrated']):>5} p95 {res.latency_ms['p95']} ms  chunks {info['chunks']} max_tok {info['max_tokens']} >512 {info['over_512']}")
    overlap = similar_overlap(built["v4"], built["token"]) if "v4" in built and "token" in built else None
    lines = [f"# RAG eval summary {a.date}", "", f"Embeddings `{emb.name}`, {len(articles)} articles, {len(questions)} questions, floor {a.floor}. One file per configuration next to this one.", "",
             "| Config | Chunks | Max tokens | > 512 | Recall@1 | Recall@3 | Recall@6 | MRR | Anchor hit | No-answer FP @ floor | Calibrated floor | FP @ calibrated | p95 ms |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, r, meta in results:
        m = r.metrics
        lines.append(f"| {name} | {meta['chunks']} | {meta['max_tokens']} | {meta['over_512']} | {pct(m['recall@1'])} | {pct(m['recall@3'])} | {pct(m['recall@6'])} | {m['mrr']:.3f} | {pct(m['anchor_hit_rate'])} | {pct(m['no_answer_fp_rate'])} | {r.calibrated_floor} | {pct(m['no_answer_fp_rate_at_calibrated'])} | {r.latency_ms['p95']} |")
    if overlap is not None:
        lines += ["", f"Internal linking check: mean Jaccard overlap of each article's top-5 similar articles, v4 vs token chunking: **{overlap}**."]
    (out / f"{a.date}-summary{a.suffix}.md").write_text("\n".join(lines) + "\n")
    if a.json:
        print(json.dumps({n: {**r.metrics, "calibrated_floor": r.calibrated_floor, "p95_ms": r.latency_ms["p95"]} for n, r, _ in results}, indent=2))
    if overlap is not None:
        print(f"similar-articles overlap v4 vs token: {overlap}")
    if a.generation:
        return await run_generation(a, emb, articles, questions, out)
    return 0


async def run_generation(a: argparse.Namespace, emb: object, articles: list, questions: list, out: Path) -> int:
    import os
    from types import SimpleNamespace

    from app.config import Settings
    from app.llm import AnthropicLlm, BudgetGuard, MemorySpendStore
    from app.rag_eval import generation_eval, render_generation_markdown
    from app.services.ask_pipeline import AskPipeline

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("--generation needs ANTHROPIC_API_KEY (real model calls)", file=sys.stderr)
        return 2
    chunker, cfg = CONFIGS[a.generation_config]
    ix = LocalIndex(emb, cfg, chunker=chunker, dsn=a.dsn if cfg.mode == "hybrid" else None)
    await ix.build(articles)
    s = Settings()
    # A local guard: the run's own cap (the estimate is checked before every call), nothing written to the shared table.
    guard = BudgetGuard(MemorySpendStore(), monthly_usd=a.generation_max_usd, ask_daily_usd=a.generation_max_usd)
    llm = AnthropicLlm(os.environ["ANTHROPIC_API_KEY"], guard)
    deps = SimpleNamespace(settings=s, llm=llm, retriever=ix)
    res = await generation_eval(AskPipeline(deps), llm, a.judge_model, questions, max_usd=a.generation_max_usd)
    meta = {"date": a.date, "answer_model": s.draft_model, "grade_model": s.classify_model, "judge_model": a.judge_model}
    (out / f"{a.date}-generation.md").write_text(render_generation_markdown(res, meta))
    m = res.metrics
    print(f"generation: answered {pct(m['answered_rate'])} abstain {pct(m['abstain_rate'])} cite-label {pct(m['label_citation_precision'])} "
          f"cite-judge {pct(m['judge_citation_precision'])} faithful {pct(m['faithfulness'])} cost ${res.cost_usd:.4f} ({res.n} questions)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
