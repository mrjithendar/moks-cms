"""Hybrid retrieval (v5): vector + full-text candidates fused with Reciprocal Rank Fusion, an exact-identifier boost,
window de-duplication and per-article diversification (docs/seo/RAG.md "Hybrid retrieval").

The candidate lists come from Postgres in production (app/index.py: pgvector cosine top-N, `tsvector` full-text top-N,
`identifiers && …` exact matches); the fusion below is plain Python and shared with the in-memory index used by tests
and the CI smoke run of the evaluation, so both rank the same way.

RAG_MODE=vector keeps v4's ranking (cosine only) but still de-duplicates code windows and diversifies.

    fused(c) = Σ_lists 1 / (rrf_k + rank_list(c))  +  identifier_boost × min(matches(c), 2)

`Hit.score` stays the chunk's cosine similarity in every mode (Ask the Blog's floor, the news desk's novelty check and
the MCP `score` field all mean cosine); `Hit.fused` is the hybrid ranking score.
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from typing import Any, Literal

import numpy as np

Mode = Literal["vector", "hybrid"]


@dataclass(frozen=True)
class RetrievalConfig:
    mode: Mode = "hybrid"
    candidates: int = 20  # N per candidate list
    rrf_k: int = 60
    identifier_boost: float = 1 / 61  # one exact identifier match ≈ a rank-1 hit in one list
    max_per_article: int = 3  # 0 = no diversification. v5 eval: 2 cost 10.7 points of anchor hits, 3 cost 2.2 (RAG.md)
    min_vector_score: float = 0.0  # cosine pre-filter on every candidate (Ask the Blog passes its floor)
    # The reranker is not part of this config: its switch and limits are live Settings (app/reranker.py RerankGate).

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> RetrievalConfig:
        e = os.environ if env is None else env

        def num(name: str, default: float, lo: float, hi: float) -> float:
            try:
                return max(lo, min(hi, float(e.get(name, ""))))
            except ValueError:
                return default

        mode = e.get("RAG_MODE", "").strip().lower()
        return cls(
            mode="vector" if mode == "vector" else ("hybrid" if mode == "hybrid" else DEFAULT_MODE),
            candidates=int(num("RAG_CANDIDATES", 20, 5, 100)),
            rrf_k=int(num("RAG_RRF_K", 60, 1, 1000)),
            identifier_boost=num("RAG_IDENTIFIER_BOOST", 1 / 61, 0.0, 1.0),
            max_per_article=int(num("RAG_MAX_PER_ARTICLE", 3, 0, 20)),
        )


# The default is decided by the evaluation (docs/seo/rag-eval/, RAG.md "Defaults"): hybrid only if it beats vector on
# Recall@3 and MRR without a worse no-answer rate. 2026-11-10 (bge-small, 55 questions): Recall@3 100 % for both, MRR
# vector 0.968 vs hybrid 0.961 (k=60) / 0.972 (k=20, a single question) → vector. RAG_MODE=hybrid switches it on.
DEFAULT_MODE: Mode = "vector"


@dataclass
class Candidate:
    key: str  # de-duplication key: one logical chunk (all windows of a code block share it)
    article_id: str
    title: str
    path: str
    heading_path: str
    anchor: str | None
    content: str
    vector_score: float  # cosine similarity of this chunk (best window)
    category: str = ""
    vector_rank: int | None = None
    text_rank: int | None = None
    id_matches: int = 0
    fused: float = 0.0
    extra: dict[str, Any] = field(default_factory=dict)


def _best(a: int | None, b: int | None) -> int | None:
    return b if a is None else a if b is None else min(a, b)


def dedupe(cands: Iterable[Candidate]) -> list[Candidate]:
    """Merge windows of the same logical chunk: best rank per list, best cosine, most identifier matches."""
    out: dict[str, Candidate] = {}
    for c in cands:
        o = out.get(c.key)
        if o is None:
            out[c.key] = replace(c)
            continue
        o.vector_score = max(o.vector_score, c.vector_score)
        o.vector_rank = _best(o.vector_rank, c.vector_rank)
        o.text_rank = _best(o.text_rank, c.text_rank)
        o.id_matches = max(o.id_matches, c.id_matches)
    return list(out.values())


def _rerank_lists(cands: list[Candidate]) -> None:
    """After de-duplication, ranks are re-numbered densely per list (a window pair must not leave a gap)."""
    for attr in ("vector_rank", "text_rank"):
        ranked = sorted((c for c in cands if getattr(c, attr) is not None), key=lambda c: getattr(c, attr))
        for i, c in enumerate(ranked, start=1):
            setattr(c, attr, i)


def fuse(cands: list[Candidate], cfg: RetrievalConfig) -> list[Candidate]:
    """Score and order de-duplicated candidates. Vector mode: cosine order. Hybrid: RRF + identifier boost."""
    cands = [c for c in dedupe(cands) if c.vector_score >= cfg.min_vector_score]
    _rerank_lists(cands)
    for c in cands:
        if cfg.mode == "vector":
            c.fused = c.vector_score
        else:
            s = 0.0
            for r in (c.vector_rank, c.text_rank):
                if r is not None:
                    s += 1.0 / (cfg.rrf_k + r)
            c.fused = s + cfg.identifier_boost * min(c.id_matches, 2)
    if cfg.mode == "vector":
        cands = [c for c in cands if c.vector_rank is not None]
    return sorted(cands, key=lambda c: (-c.fused, -c.vector_score, c.key))


def diversify(cands: list[Candidate], k: int, max_per_article: int) -> list[Candidate]:
    """Top k with at most `max_per_article` chunks per article (0 = no limit). If the limit leaves fewer than k
    results, it is not relaxed: k distinct-enough answers beat k slices of one long article."""
    if max_per_article <= 0:
        return cands[:k]
    out: list[Candidate] = []
    per: dict[str, int] = {}
    for c in cands:
        if per.get(c.article_id, 0) >= max_per_article:
            continue
        per[c.article_id] = per.get(c.article_id, 0) + 1
        out.append(c)
        if len(out) >= k:
            break
    return out


# --- In-memory hybrid index (tests, CI smoke evaluation) -----------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset(
    "a an and are as at be by can do does for from how i in is it my of on or should the this to what when where which why with you your "
    "vs versus".split()
)


def _stem(w: str) -> str:
    for suf in ("ing", "ed", "es", "s"):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def text_terms(text: str) -> list[str]:
    return [_stem(w) for w in _WORD.findall(text.lower()) if w not in _STOP]


@dataclass
class MemoryRow:
    key: str
    article_id: str
    title: str
    path: str
    heading_path: str
    anchor: str | None
    content: str
    embedding: np.ndarray
    identifiers: list[str]
    category: str = ""
    terms: list[str] = field(default_factory=list)


class Bm25:
    """Small Okapi BM25 over title + heading path + content (a stand-in for Postgres full-text search when there is
    no database: tests and the CI smoke evaluation only; production and the real evaluation use Postgres)."""

    def __init__(self, docs: list[list[str]], k1: float = 1.2, b: float = 0.75):
        self.docs, self.k1, self.b = docs, k1, b
        self.avg = sum(len(d) for d in docs) / max(1, len(docs))
        df: dict[str, int] = {}
        for d in docs:
            for t in set(d):
                df[t] = df.get(t, 0) + 1
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
        self.tf = [self._tf(d) for d in docs]

    @staticmethod
    def _tf(d: list[str]) -> dict[str, int]:
        out: dict[str, int] = {}
        for t in d:
            out[t] = out.get(t, 0) + 1
        return out

    def scores(self, q: list[str]) -> np.ndarray:
        s = np.zeros(len(self.docs))
        for i, tf in enumerate(self.tf):
            dl = len(self.docs[i])
            for t in set(q):
                f = tf.get(t)
                if f:
                    s[i] += self.idf[t] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * dl / self.avg))
        return s


def candidates_from_lists(
    rows: list[MemoryRow], qvec: np.ndarray, text_scores: np.ndarray | None, qids: set[str], n: int, exclude_article: str | None = None
) -> list[Candidate]:
    """The three candidate lists of the SQL version, computed in memory (exact cosine)."""
    idx = [i for i, r in enumerate(rows) if r.article_id != exclude_article]
    if not idx:
        return []
    mat = np.stack([rows[i].embedding for i in idx])
    cos = mat @ qvec
    out: list[Candidate] = []

    def cand(j: int) -> Candidate:
        r = rows[idx[j]]
        return Candidate(r.key, r.article_id, r.title, r.path, r.heading_path, r.anchor, r.content, float(cos[j]), r.category, id_matches=len(qids & set(r.identifiers)))

    for rank, j in enumerate(np.argsort(-cos)[:n], start=1):
        c = cand(int(j))
        c.vector_rank = rank
        out.append(c)
    if text_scores is not None:
        ts = text_scores[idx]
        for rank, j in enumerate([int(j) for j in np.argsort(-ts) if ts[j] > 0][:n], start=1):
            c = cand(j)
            c.text_rank = rank
            out.append(c)
    if qids:
        matched = sorted((j for j in range(len(idx)) if qids & set(rows[idx[j]].identifiers)), key=lambda j: -len(qids & set(rows[idx[j]].identifiers)))[:n]
        out.extend(cand(j) for j in matched)
    return out
