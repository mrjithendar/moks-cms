"""Retrieval evaluation (docs/seo/RAG.md "Evaluation"): the fixed question set in tests/fixtures/rag_eval.yaml run
against a retriever configuration.

Metrics (k = 6, the Ask-the-Blog top-k):
- Recall@1/3/6: an expected article among the top 1/3/6 results (article level).
- MRR: 1 / rank of the first expected article within k (0 if absent).
- Section-anchor hit rate: an expected article's acceptable section anchor among the top k.
- No-answer false-positive rate at a floor f: share of "no-answer" questions whose top k contain a chunk with cosine ≥ f
  (it would reach the grader). Reported at the configured floor and at the calibrated one.
- Calibrated floor: the highest cosine floor that loses no expected answer = the lowest "best expected-article cosine"
  over answerable questions that were found at all (rounded down to 0.01).
- Latency p50/p95 of the search call.

Used by scripts/rag_eval.py (local indexes over the MDX files: exact cosine + Postgres or BM25 full text) and by
seo_ml_flow's `rag_eval` step against the live index (seo_rag_eval_recall_at_3).
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import statistics
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import yaml

from .embeddings import Chunk, chunk_markdown, chunk_markdown_v4, embed_input, extract_identifiers, question_identifiers, token_counter
from .index import HYBRID_DDL, TEXT_QUERY_CTE, Hit, to_hit
from .retrieval import Bm25, Candidate, MemoryRow, RetrievalConfig, candidates_from_lists, diversify, fuse, text_terms

K = 6
EVAL_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "rag_eval.yaml"
TYPES = ("concept", "how-to", "exact-term", "troubleshooting", "no-answer")


@dataclass
class Question:
    id: str
    question: str
    type: str
    slugs: list[str]
    anchors: list[str]


def load_eval_set(path: Path | str = EVAL_PATH) -> list[Question]:
    doc = yaml.safe_load(Path(path).read_text())
    qs = [Question(q["id"], q["question"], q["type"], list(q.get("slugs") or []), list(q.get("anchors") or [])) for q in doc["questions"]]
    bad = [q.id for q in qs if q.type not in TYPES or (q.type != "no-answer" and not q.slugs)]
    if bad:
        raise ValueError(f"malformed eval questions: {bad}")
    return qs


def slug_of(path: str) -> str:
    return path.rstrip("/").rsplit("/", 1)[-1]


@dataclass
class QResult:
    q: Question
    hits: list[Hit]
    latency_ms: float
    rank: int | None = None  # first expected article, 1-based within k
    anchor_hit: bool = False
    best_expected_cosine: float | None = None
    best_cosine: float = 0.0


@dataclass
class EvalResult:
    config: str
    n: int
    metrics: dict[str, float]
    by_type: dict[str, dict[str, float]]
    floor: float
    calibrated_floor: float | None
    floor_table: list[dict[str, float]]
    latency_ms: dict[str, float]
    rows: list[QResult] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def score_question(q: Question, hits: list[Hit], latency_ms: float) -> QResult:
    r = QResult(q, hits, latency_ms, best_cosine=max((h.score for h in hits), default=0.0))
    if q.type == "no-answer":
        return r
    for i, h in enumerate(hits, start=1):
        if slug_of(h.path) in q.slugs:
            if r.rank is None:
                r.rank = i
            r.best_expected_cosine = max(r.best_expected_cosine or -1.0, h.score)
            if h.anchor and h.anchor in q.anchors:
                r.anchor_hit = True
    return r


def summarize(config: str, rows: list[QResult], floor: float, notes: list[str] | None = None) -> EvalResult:
    ans = [r for r in rows if r.q.type != "no-answer"]
    neg = [r for r in rows if r.q.type == "no-answer"]

    def recall(rs: list[QResult], k: int) -> float:
        return round(sum(1 for r in rs if r.rank is not None and r.rank <= k) / max(1, len(rs)), 4)

    def mrr(rs: list[QResult]) -> float:
        return round(sum(1 / r.rank for r in rs if r.rank) / max(1, len(rs)), 4)

    def fp(f: float) -> float:
        return round(sum(1 for r in neg if r.best_cosine >= f) / max(1, len(neg)), 4)

    found = [r.best_expected_cosine for r in ans if r.best_expected_cosine is not None]
    cal = float(np.floor(min(found) * 100) / 100) if found else None
    floors = sorted({0.0, 0.15, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, *([cal] if cal is not None else []), floor})
    table = [{"floor": f, "answers_lost": sum(1 for r in ans if r.best_expected_cosine is not None and r.best_expected_cosine < f), "no_answer_fp_rate": fp(f)} for f in floors]
    lat = [r.latency_ms for r in rows]
    by_type = {t: {"n": len([r for r in rows if r.q.type == t]), "recall@3": recall([r for r in rows if r.q.type == t], 3), "mrr": mrr([r for r in rows if r.q.type == t])} for t in TYPES if t != "no-answer"}
    return EvalResult(
        config=config,
        n=len(rows),
        metrics={
            "recall@1": recall(ans, 1),
            "recall@3": recall(ans, 3),
            "recall@6": recall(ans, 6),
            "mrr": mrr(ans),
            "anchor_hit_rate": round(sum(1 for r in ans if r.anchor_hit) / max(1, len(ans)), 4),
            "no_answer_fp_rate": fp(floor),
            "no_answer_fp_rate_at_calibrated": fp(cal) if cal is not None else 1.0,
        },
        by_type=by_type,
        floor=floor,
        calibrated_floor=cal,
        floor_table=table,
        latency_ms={"p50": round(statistics.median(lat), 2) if lat else 0.0, "p95": round(float(np.percentile(lat, 95)), 2) if lat else 0.0},
        rows=rows,
        notes=notes or [],
    )


SearchFn = Callable[[str, int], Awaitable[list[Hit]]]


async def evaluate(config: str, search: SearchFn, questions: list[Question], *, floor: float = 0.15, k: int = K, notes: list[str] | None = None) -> EvalResult:
    """Runs every question (min_score = 0 inside `search`: floors are applied afterwards, so one run gives the whole
    floor table)."""
    rows = []
    for q in questions:
        t0 = time.perf_counter()
        hits = await search(q.question, k)
        rows.append(score_question(q, hits, (time.perf_counter() - t0) * 1000))
    return summarize(config, rows, floor, notes)


# --- Local corpus and indexes (scripts/rag_eval.py, CI smoke) ---------------------------------------------------------

_FM = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.S)


def load_articles(blog_dir: Path | str) -> list[dict[str, Any]]:
    """Published-or-in-review MDX articles (drafts skipped), shaped like the web app's published_articles()."""
    out = []
    for f in sorted(Path(blog_dir).glob("*.mdx")):
        m = _FM.match(f.read_text())
        if not m:
            continue
        fm = yaml.safe_load(m.group(1)) or {}
        if str(fm.get("status", "")).lower() == "draft" or fm.get("draft") is True:
            continue
        slug = str(fm.get("slug") or f.stem)
        out.append({"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"blog/{slug}")), "title": str(fm.get("title", slug)), "slug": slug, "collection": "blog", "category": str(fm.get("category", "")), "body": m.group(2)})
    return out


@dataclass
class LocalIndex:
    """Exact-cosine vector list + full-text list (Postgres when `dsn` is set, BM25 otherwise) + identifier matches,
    fused by the production code (app/retrieval.py). `chunker`: "token" (v5) or "v4" (baseline)."""

    embeddings: Any
    config: RetrievalConfig
    chunker: str = "token"
    dsn: str | None = None
    rows: list[MemoryRow] = field(default_factory=list)
    chunks: list[tuple[dict[str, Any], Chunk]] = field(default_factory=list)
    bm25: Bm25 | None = None
    table: str = ""

    async def build(self, articles: list[dict[str, Any]]) -> dict[str, Any]:
        counter = token_counter(self.embeddings)
        inputs: list[str] = []
        for a in articles:
            chs = chunk_markdown_v4(a["body"], a["title"]) if self.chunker == "v4" else chunk_markdown(a["body"], a["title"], counter)
            for ch in chs:
                if self.chunker == "v4":
                    ch.identifiers = extract_identifiers(ch.content)
                self.chunks.append((a, ch))
                inputs.append(embed_input(a["title"], ch))
        vecs = await self.embeddings.embed(inputs)
        for (a, ch), v in zip(self.chunks, vecs, strict=True):
            key = f"{a['id']}:{hashlib.sha256(ch.content.encode()).hexdigest()[:16]}"
            self.rows.append(MemoryRow(key, a["id"], a["title"], f"/blog/{a['slug']}", ch.heading_path, ch.anchor, ch.content, np.asarray(v, dtype=np.float32), ch.identifiers, a["category"], text_terms(f"{a['title']} {ch.heading_path} {ch.content}")))
        tokens = [counter.count(t) for t in inputs]
        if self.dsn:
            await self._load_pg()
        else:
            self.bm25 = Bm25([r.terms for r in self.rows])
        return {"chunks": len(self.rows), "max_tokens": max(tokens) if tokens else 0, "over_512": sum(1 for t in tokens if t + 2 > 512), "counter": counter.name, "tokens": tokens}

    async def _load_pg(self) -> None:
        """Minimal copy of the production table in a scratch database (no pgvector needed: the vector list is exact
        cosine in numpy). The tsvector column and its index come from the production DDL (HYBRID_DDL)."""
        import psycopg

        self.table = "seo_article_chunks"
        assert self.dsn
        async with await psycopg.AsyncConnection.connect(self.dsn, autocommit=True) as c:
            await c.execute("drop table if exists seo_article_chunks")
            await c.execute("create table seo_article_chunks (id bigserial primary key, row_no integer not null, heading_path text not null default '', content text not null)")
            for ddl in HYBRID_DDL:
                await c.execute(ddl)
            async with c.cursor() as cur:
                await cur.executemany(
                    "insert into seo_article_chunks (row_no, title, heading_path, content, identifiers) values (%s, %s, %s, %s, %s)",
                    [(i, r.title, r.heading_path, r.content, r.identifiers) for i, r in enumerate(self.rows)],
                )

    async def _text_ranks(self, query: str, n: int) -> np.ndarray:
        scores = np.zeros(len(self.rows))
        if self.dsn:
            import psycopg

            async with await psycopg.AsyncConnection.connect(str(self.dsn), autocommit=True) as c:
                cur = await c.execute(
                    f"""{TEXT_QUERY_CTE} select ch.row_no, ts_rank(ch.tsv, tq.q, 1) as r from tq, seo_article_chunks ch
                          where tq.q is not null and ch.tsv @@ tq.q order by r desc, ch.id limit %(n)s""",  # noqa: S608 - constant CTE; values are bound
                    {"q": query, "n": n},
                )
                for rank, (row_no, _r) in enumerate(await cur.fetchall()):
                    scores[row_no] = n - rank  # only the order matters (RRF)
        elif self.bm25 is not None:
            scores = self.bm25.scores(text_terms(query))
        return scores

    async def search(self, query: str, k: int = K, *, exclude_article: str | None = None, min_score: float = 0.0) -> list[Hit]:
        cfg = self.config
        [v] = await self.embeddings.embed([query], query=True)
        qvec = np.asarray(v, dtype=np.float32)
        hybrid = cfg.mode == "hybrid"
        ts = await self._text_ranks(query, cfg.candidates) if hybrid else None
        qids = set(question_identifiers(query)) if hybrid else set()
        cands: list[Candidate] = candidates_from_lists(self.rows, qvec, ts, qids, cfg.candidates, exclude_article)
        from dataclasses import replace

        fused = fuse(cands, replace(cfg, min_vector_score=max(cfg.min_vector_score, min_score)))
        return [to_hit(c) for c in diversify(fused, k, cfg.max_per_article)]

    def article_vectors(self) -> dict[str, np.ndarray]:
        by: dict[str, list[np.ndarray]] = {}
        for r in self.rows:
            by.setdefault(r.path, []).append(r.embedding)
        return {p: np.mean(v, axis=0) for p, v in by.items()}


def similar_overlap(a: LocalIndex, b: LocalIndex, k: int = 5) -> float:
    """Internal-linking check: mean Jaccard overlap of each article's top-k most similar articles (mean chunk
    embedding vs the other articles' best chunk, like PgVectorIndex.similar_articles) under two indexes."""

    def top(ix: LocalIndex) -> dict[str, set[str]]:
        means = ix.article_vectors()
        out: dict[str, set[str]] = {}
        for p, m in means.items():
            best: dict[str, float] = {}
            for r in ix.rows:
                if r.path != p:
                    s = float(r.embedding @ m / (np.linalg.norm(m) or 1))
                    best[r.path] = max(best.get(r.path, -1), s)
            out[p] = {q for q, _ in sorted(best.items(), key=lambda kv: -kv[1])[:k]}
        return out

    ta, tb = top(a), top(b)
    js = [len(ta[p] & tb[p]) / len(ta[p] | tb[p]) for p in ta if p in tb and (ta[p] | tb[p])]
    return round(float(np.mean(js)), 4) if js else 0.0


# --- Report ---------------------------------------------------------------------------------------------------------


def pct(v: float | None) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}"


def render_markdown(r: EvalResult, meta: dict[str, Any]) -> str:
    m = r.metrics
    lines = [
        f"# RAG eval: {r.config}",
        "",
        f"- Date: {meta.get('date')} · commit `{meta.get('commit', 'working tree')}` · embeddings `{meta.get('embeddings')}` · full text: {meta.get('text_backend')}",
        f"- Corpus: {meta.get('articles')} articles, {meta.get('chunks')} chunks (chunker `{meta.get('chunker')}`, token counter `{meta.get('counter')}`, longest embedded input {meta.get('max_tokens')} tokens, {meta.get('over_512')} over 512)",
        f"- Questions: {r.n} ({sum(1 for x in r.rows if x.q.type == 'no-answer')} no-answer), k = {K}, configured floor {r.floor}",
        f"- Retrieval config: `{meta.get('retrieval')}`",
        "",
        "| Recall@1 | Recall@3 | Recall@6 | MRR | Anchor hit | No-answer FP @ floor | Calibrated floor | No-answer FP @ calibrated | p50 ms | p95 ms |",
        "|---|---|---|---|---|---|---|---|---|---|",
        f"| {pct(m['recall@1'])} | {pct(m['recall@3'])} | {pct(m['recall@6'])} | {m['mrr']:.3f} | {pct(m['anchor_hit_rate'])} | {pct(m['no_answer_fp_rate'])} | {r.calibrated_floor} | {pct(m['no_answer_fp_rate_at_calibrated'])} | {r.latency_ms['p50']} | {r.latency_ms['p95']} |",
        "",
        "## By question type",
        "",
        "| Type | n | Recall@3 | MRR |",
        "|---|---|---|---|",
        *[f"| {t} | {v['n']} | {pct(v['recall@3'])} | {v['mrr']:.3f} |" for t, v in r.by_type.items()],
        "",
        "## Floor table (cosine pre-filter)",
        "",
        "| Floor | Expected answers lost | No-answer FP rate |",
        "|---|---|---|",
        *[f"| {f['floor']:.2f} | {int(f['answers_lost'])} | {pct(f['no_answer_fp_rate'])} |" for f in r.floor_table],
        "",
        "## Per question",
        "",
        "| id | type | rank | anchor | best cos | top results |",
        "|---|---|---|---|---|---|",
    ]
    for x in r.rows:
        tops = "; ".join(f"{slug_of(h.path)}#{h.anchor or ''} ({h.score:.2f})" for h in x.hits[:3])
        lines.append(f"| {x.q.id} | {x.q.type} | {x.rank or '—'} | {'✓' if x.anchor_hit else ''} | {x.best_cosine:.3f} | {tops} |")
    if r.notes:
        lines += ["", "## Notes", "", *[f"- {n}" for n in r.notes]]
    return "\n".join(lines) + "\n"


def run_sync(coro: Awaitable[Any]) -> Any:
    return asyncio.run(coro)  # type: ignore[arg-type]
