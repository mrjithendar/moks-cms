"""SEO v5 RAG quality: token-budget chunking (no embedded input over the limit, code windows, anchors kept), identifier
extraction, RRF fusion and diversification, grader-selected excerpts, and the evaluation harness (smoke)."""

from __future__ import annotations

import itertools
import os
import re
from pathlib import Path

import pytest
import yaml

from app.embeddings import (
    HARD_MAX_TOKENS,
    CharTokenCounter,
    Chunk,
    ModelTokenCounter,
    chunk_markdown,
    chunk_markdown_v4,
    code_windows,
    embed_input,
    extract_identifiers,
    norm_identifier,
    question_identifiers,
)
from app.index import Hit, MemoryRetriever
from app.llm import BudgetGuard, FakeLlm, MemorySpendStore
from app.main import memory_container
from app.rag_eval import EVAL_PATH, LocalIndex, evaluate, load_articles, load_eval_set, render_markdown, slug_of
from app.retrieval import Candidate, RetrievalConfig, diversify, fuse
from app.schemas import Relevance
from app.services.ask_pipeline import select_excerpts
from tests.conftest import FakeWebApp, settings

BLOG = Path(__file__).resolve().parents[3] / "sites" / "jithendar.com" / "content" / "blog"
MODEL_DIR = os.environ.get("RAG_TEST_MODEL_DIR") or os.environ.get("EMBEDDINGS_MODEL_DIR") or "/models/bge-small-en-v1.5"


def _articles() -> list[dict]:
    return load_articles(BLOG)


class WordCounter:
    """Deterministic stand-in tokenizer: one token per whitespace-separated word."""

    name = "words"

    def count(self, text: str) -> int:
        return len(text.split())


# --- token-budget chunking -------------------------------------------------------------------------------------------


def test_no_embedded_input_exceeds_the_limit_on_the_real_articles() -> None:
    counter = CharTokenCounter()
    n = 0
    for a in _articles():
        for ch in chunk_markdown(a["body"], a["title"], counter):
            assert counter.count(embed_input(a["title"], ch)) <= HARD_MAX_TOKENS, (a["slug"], ch.heading_path, ch.part)
            n += 1
    assert n > 500


@pytest.mark.skipif(not Path(MODEL_DIR, "tokenizer.json").exists(), reason="bge tokenizer not available (set RAG_TEST_MODEL_DIR)")
def test_no_embedded_input_exceeds_the_limit_with_the_model_tokenizer() -> None:
    from tokenizers import Tokenizer

    counter = ModelTokenCounter(Tokenizer.from_file(str(Path(MODEL_DIR, "tokenizer.json"))))
    worst = 0
    for a in _articles():
        for ch in chunk_markdown(a["body"], a["title"], counter):
            worst = max(worst, counter.count(embed_input(a["title"], ch)))
    assert worst <= HARD_MAX_TOKENS
    # the v4 chunker did not hold this (≈ 16 % of its inputs were over 512 tokens on 2026-11-10)
    over = sum(1 for a in _articles() for ch in chunk_markdown_v4(a["body"], a["title"]) if counter.count(embed_input(a["title"], ch)) + 2 > 512)
    assert over > 0


def test_anchors_are_the_same_as_v4() -> None:
    for a in _articles():
        new = {c.anchor for c in chunk_markdown(a["body"], a["title"], CharTokenCounter())}
        old = {c.anchor for c in chunk_markdown_v4(a["body"], a["title"])}
        assert new == old, a["slug"]


def _big_code(funcs: int = 40) -> str:
    body = "\n\n".join(f"def handler_{i}(event):\n    value = compute_{i}(event)\n    log.info('handled %s', value)\n    return value" for i in range(funcs))
    return f"```python\n{body}\n```"


def test_oversized_code_block_is_stored_whole_and_embedded_in_windows() -> None:
    block = _big_code()
    md = f"## Handlers\n\nSome intro text.\n\n{block}\n\n## Next\n\nShort."
    counter = WordCounter()
    chunks = chunk_markdown(md, "Title", counter, target=120, hard_max=160)
    code = [c for c in chunks if c.embed_text is not None]
    assert len(code) >= 3
    assert {c.content for c in code} == {block}  # whole block for display and citations
    assert {c.anchor for c in code} == {"handlers"} and {c.heading_path for c in code} == {"Handlers"}
    assert [c.part for c in code] == list(range(len(code))) and {c.parts for c in code} == {len(code)}
    for c in chunks:
        assert counter.count(embed_input("Title", c)) <= 160
    # small overlap: each window after the first starts with the previous window's last lines
    for prev, cur in itertools.pairwise(code):
        assert prev.embed_text.split("\n")[-1] in cur.embed_text
    # every line of the block is embedded somewhere
    joined = "\n".join(c.embed_text for c in code)
    assert all(line in joined for line in block.split("\n") if line.strip())


def test_code_without_blank_lines_and_one_giant_line_still_fit() -> None:
    counter = WordCounter()
    long_lines = "\n".join(f"echo step {i} " + "x " * 30 for i in range(30))
    wins = code_windows(f"```bash\n{long_lines}\n```", counter, limit=50, window=40)
    assert len(wins) > 3 and all(counter.count(w) <= 50 for w in wins)
    giant = "```\n" + " ".join(f"tok{i}" for i in range(500)) + "\n```"
    assert all(counter.count(w) <= 50 for w in code_windows(giant, counter, limit=50, window=40))


def test_a_long_prose_paragraph_is_split() -> None:
    para = " ".join(f"Sentence number {i} explains one more detail about the system." for i in range(60))
    chunks = chunk_markdown(f"## Long\n\n{para}", "T", WordCounter(), target=80, hard_max=100)
    assert len(chunks) > 3 and all(c.embed_text is None for c in chunks)
    assert all(WordCounter().count(embed_input("T", c)) <= 100 for c in chunks)


def test_content_hash_changes_with_the_chunker_version_and_window() -> None:
    a = Chunk(0, "H", "h", "text")
    b = Chunk(0, "H", "h", "text", part=1, parts=2, embed_text="text")
    assert a.content_hash != b.content_hash
    assert len(a.content_hash) == 64


# --- identifiers -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Run `kubectl rollout undo deploy/web` now", {"kubectl rollout", "kubectl rollout undo deploy/web"}),
        ("patched CVE-2024-3094 in xz 5.6.1", {"cve-2024-3094", "5.6.1"}),
        ("pass --dry-run=server and --context", {"--dry-run", "--context"}),
        ("always set -euo pipefail first", {"set -euo pipefail"}),
        ("export SEO_LLM_MONTHLY_BUDGET_USD=15", {"seo_llm_monthly_budget_usd"}),
        ("a PodDisruptionBudget and a StatefulSet", {"poddisruptionbudget", "statefulset"}),
        ("maxMemoryPolicy controls eviction", {"maxmemorypolicy"}),
        ("set `versioning-strategy: increase`", {"versioning-strategy increase"}),
        ("python v3.13 and Node 24", {"v3.13"}),
    ],
)
def test_identifier_extraction(text: str, expected: set[str]) -> None:
    assert expected <= set(extract_identifiers(text))


def test_plain_words_are_not_identifiers() -> None:
    ids = set(extract_identifiers("The `latest` tag and the `service` are plain words; version 1.5 too."))
    assert not ids & {"latest", "service", "1.5"}


def test_question_identifiers_match_unformatted_spelling() -> None:
    chunk_ids = set(extract_identifiers("Use `versioning-strategy: increase` in dependabot.yml"))
    q = set(question_identifiers("What does versioning-strategy increase do?"))
    assert "versioning-strategy increase" in chunk_ids & q
    assert norm_identifier(' "maxMemoryPolicy": ') == "maxmemorypolicy"


# --- fusion and diversification --------------------------------------------------------------------------------------


def _c(key: str, art: str, cos: float, vr: int | None = None, tr: int | None = None, ids: int = 0) -> Candidate:
    return Candidate(key, art, f"T{art}", f"/blog/{art}", "H", key, f"content {key}", cos, vector_rank=vr, text_rank=tr, id_matches=ids)


def test_rrf_fuses_ranks_and_rewards_agreement() -> None:
    cfg = RetrievalConfig(mode="hybrid", rrf_k=60, identifier_boost=0.0, max_per_article=0)
    out = fuse([_c("a", "A", 0.9, vr=1), _c("b", "B", 0.8, vr=2), _c("b", "B", 0.8, tr=1), _c("c", "C", 0.5, tr=2)], cfg)
    assert [c.key for c in out] == ["b", "a", "c"]  # b: 1/62 + 1/61 beats a: 1/61
    assert out[0].fused == pytest.approx(1 / 62 + 1 / 61)


def test_identifier_boost_lifts_an_exact_match() -> None:
    cfg = RetrievalConfig(mode="hybrid", identifier_boost=1 / 61, max_per_article=0)
    out = fuse([_c("a", "A", 0.9, vr=1), _c("z", "Z", 0.4, tr=3, ids=1)], cfg)
    assert out[0].key == "z"


def test_vector_mode_is_cosine_order_and_ignores_text_only_candidates() -> None:
    cfg = RetrievalConfig(mode="vector", max_per_article=0)
    out = fuse([_c("a", "A", 0.7, vr=2), _c("b", "B", 0.9, vr=1), _c("t", "T", 0.95, tr=1)], cfg)
    assert [c.key for c in out] == ["b", "a"]


def test_windows_of_one_block_are_merged_and_ranks_renumbered() -> None:
    cfg = RetrievalConfig(mode="hybrid", identifier_boost=0.0, max_per_article=0)
    out = fuse([_c("w", "A", 0.8, vr=1), _c("w", "A", 0.85, vr=2), _c("x", "B", 0.7, vr=3)], cfg)
    assert [c.key for c in out] == ["w", "x"]
    assert out[0].vector_score == 0.85 and out[1].vector_rank == 2


def test_cosine_prefilter_applies_to_every_candidate() -> None:
    cfg = RetrievalConfig(mode="hybrid", min_vector_score=0.6, max_per_article=0)
    out = fuse([_c("a", "A", 0.9, vr=1), _c("t", "T", 0.3, tr=1, ids=2)], cfg)
    assert [c.key for c in out] == ["a"]


def test_diversify_caps_chunks_per_article() -> None:
    cands = [_c(f"a{i}", "A", 0.9 - i / 100) for i in range(5)] + [_c("b0", "B", 0.5), _c("c0", "C", 0.4)]
    assert [c.key for c in diversify(cands, 4, 2)] == ["a0", "a1", "b0", "c0"]
    assert len(diversify(cands, 4, 0)) == 4 and all(c.article_id == "A" for c in diversify(cands, 4, 0))


def test_retrieval_config_from_env() -> None:
    cfg = RetrievalConfig.from_env({"RAG_MODE": "hybrid", "RAG_RRF_K": "20", "RAG_MAX_PER_ARTICLE": "2", "RAG_CANDIDATES": "500"})
    assert (cfg.mode, cfg.rrf_k, cfg.max_per_article, cfg.candidates) == ("hybrid", 20, 2, 100)
    assert RetrievalConfig.from_env({}).mode == "vector"  # the eval-decided default (RAG.md)
    assert RetrievalConfig.from_env({"RAG_RERANKER_DIR": "/m"}).reranker_dir == ""  # needs RAG_RERANKER_ENABLED too


# --- grader-selected excerpts ----------------------------------------------------------------------------------------


def _hitdicts() -> list[dict]:
    return [{"url": f"/blog/x#{i}", "title": f"T{i}", "section": f"S{i}", "content": f"text {i}"} for i in range(1, 5)]


def test_select_excerpts_keeps_the_graders_order_and_ignores_bad_numbers() -> None:
    hs = _hitdicts()
    picked = select_excerpts(hs, Relevance(relevant=True, reason="r", relevant_excerpts=[3, 9, 1, 3, 0]))
    assert [h["url"] for h in picked] == ["/blog/x#3", "/blog/x#1"]
    assert select_excerpts(hs, Relevance(relevant=True, reason="old grader")) == hs  # no list → all (v4 behaviour)


async def test_answer_prompt_gets_only_the_graded_excerpts_and_citations_map_back(web: FakeWebApp) -> None:
    hits = [
        Hit("a1", "Ingress and TLS", "/blog/ingress-tls", "Ingress › cert-manager", "cert-manager", "cert-manager renews certificates 30 days before expiry.", 0.9),
        Hit("a2", "Istio on minikube", "/blog/istio", "Istio › mTLS", "mtls", "STRICT mTLS between sidecars renews workload certificates daily.", 0.8),
        Hit("a3", "Terraform state", "/blog/tf", "State › Locking", "locking", "Use S3 native locking to renew nothing.", 0.7),
    ]
    llm = FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1))
    llm.queue("ask_grade", Relevance(relevant=True, reason="2 is about mesh certs", relevant_excerpts=[2]))
    llm.queue("ask_answer", "Istio rotates workload certificates daily under STRICT mTLS [1].")
    c = memory_container(settings(), llm=llm, web=web, retriever=MemoryRetriever(hits))
    r = await c.ask.ask("How often are certificates renewed (renews)?")
    answer_prompt = next(s for s in llm.calls if s.purpose == "ask_answer").user
    assert "STRICT mTLS between sidecars" in answer_prompt and "cert-manager renews" not in answer_prompt and "S3 native locking" not in answer_prompt
    assert r["outcome"] == "answered" and r["citations"] == [{"title": "Istio on minikube › mTLS", "url": "/blog/istio#mtls", "refs": [1]}]
    rows = c.ask.log.rows
    assert rows[-1]["prompt_version"] == "ask-blog-v3"
    graded = [x for x in rows[-1]["retrieval"] if x["graded"]]
    assert [x["url"] for x in graded] == ["/blog/istio#mtls"] and graded[0]["cited"] is True


# --- evaluation harness ------------------------------------------------------------------------------------------------


def test_eval_set_shape() -> None:
    qs = load_eval_set(EVAL_PATH)
    assert len(qs) >= 40 and sum(1 for q in qs if q.type == "no-answer") >= 6
    slugs = {a["slug"] for a in _articles()}
    for q in qs:
        assert set(q.slugs) <= slugs, q.id
    raw = yaml.safe_load(EVAL_PATH.read_text())
    assert len({q["id"] for q in raw["questions"]}) == len(raw["questions"])


async def test_eval_smoke_with_hash_embeddings() -> None:
    """CI smoke: the harness runs end to end (hashed embeddings, in-memory BM25); the numbers are not meaningful."""
    from app.embeddings import HashEmbeddings

    ix = LocalIndex(HashEmbeddings(), RetrievalConfig(mode="hybrid"))
    info = await ix.build(_articles())
    assert info["over_512"] == 0 and info["chunks"] > 500
    res = await evaluate("smoke", ix.search, load_eval_set(), floor=0.15)
    assert res.n >= 40 and 0 <= res.metrics["recall@3"] <= 1 and res.calibrated_floor is not None
    md = render_markdown(res, {"date": "test", "embeddings": "hash", "chunker": "token"})
    assert "| Recall@1 |" in md and re.search(r"\| c01 \| concept \|", md)
    assert slug_of("/blog/a-b-c") == "a-b-c"


def test_calibrate_suggestion_is_read_only_logic() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("rag_calibrate", Path(__file__).resolve().parents[1] / "scripts" / "rag_calibrate.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    rows = [{"outcome": "answered", "retrieval": [{"score": 0.71 + i / 100, "cited": True}, {"score": 0.5, "cited": False}]} for i in range(25)]
    rows += [{"outcome": "fallback", "retrieval": [{"score": 0.6}]}, {"outcome": "fallback", "retrieval": [{"score": 0.8}]}]
    s = mod.suggest(rows, min_answered=20)
    assert s["recommendation"] == 0.71 and s["fallbacks_cut"] == 1
    assert mod.suggest(rows[:5], min_answered=20)["recommendation"] is None
