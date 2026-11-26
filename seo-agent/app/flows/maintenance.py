"""Smaller flows: internal_linking_flow, reindex_flow, ask_gaps_flow.

internal_linking_flow: vector candidates (pgvector similarity 0.65 + Jaccard overlap of shared Search Console queries
0.35) → the web app's deterministic v2 planner, which enforces every hard limit in code (≤ 3 new links per article per
draft, ≤ 1 internal link per 250 words, one link per target, nothing in headings/code/captions/first sentence, ≥ 100
words between new links, ≤ 5 new inbound per target per weekly run, anchors from existing text and varied, never a
redirect/noindex/404 target) → merged into the article's open draft as internal_link changes. No model involved.

reindex_flow: incremental chunk + embed by content_hash (full only on demand or when the model changes).

ask_gaps_flow: cluster unanswered Ask-the-Blog questions (seo_ask_gaps) → Keyword opportunities › Content gaps,
labelled "Asked on site" (the web app's clusterAskGaps, the same token-set clustering as Search Console queries).
"""

from __future__ import annotations

from functools import partial
from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from ..runs import INSTANCE_ONLY
from ..state import AskGapsState, LinkingState, ReindexState
from ..tools import safe_queries
from .base import SeoFlow

W_VECTOR, W_QUERIES = 0.65, 0.35


W_RELATED = 0.25  # v5: share of the related-articles model's score, only while that model is in use


def combine(similar: list[tuple[str, str, float]], source_queries: set[str], target_queries: dict[str, set[str]], related: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """Relevance per target path: weighted cosine similarity + Jaccard overlap of the queries both pages rank for.
    v5: when the related-articles model is in use (active or forced; `related` = its scores by article id), it takes
    W_RELATED of the score and the rule's two parts share the rest. Only the ORDER of candidates changes: the web
    app's planner still enforces every v2 internal-link limit."""
    out = []
    use = bool(related)
    for aid, path, sim in similar:
        tq = target_queries.get(path, set())
        overlap = len(source_queries & tq) / len(source_queries | tq) if (source_queries or tq) else 0.0
        base = W_VECTOR * max(0.0, sim) + W_QUERIES * overlap
        rel = (related or {}).get(aid, 0.0)
        score = (1 - W_RELATED) * base + W_RELATED * rel if use else base
        c = {"path": path, "score": round(score, 4), "similarity": round(sim, 4), "sharedQueries": sorted(source_queries & tq)[:5]}
        if use:
            c["related"] = round(rel, 4)
        out.append(c)
    return sorted(out, key=lambda c: -c["score"])


@persist(INSTANCE_ONLY)
class InternalLinkingFlow(SeoFlow[LinkingState]):
    FLOW: ClassVar[str] = "internal_linking_flow"

    @start()
    async def candidates(self) -> None:
        async with self.step("candidates"):
            s, web, ret = self.state, self.deps.web, self.deps.retriever
            if not s.article_ids:
                # Weekly run: the articles that have an open draft (links merge into it; none is created here).
                s.article_ids = await self.retry(lambda: web.open_draft_articles(50))
            out: dict[str, list[dict[str, Any]]] = {}
            for aid in s.article_ids:
                similar = await ret.similar_articles(aid, k=12)
                src_q = set(safe_queries([r["query"] for r in await self.retry(partial(web.gsc_queries, article_id=aid, limit=50))]))
                tq: dict[str, set[str]] = {}
                for tid, path, _ in similar:
                    rows = await self.retry(partial(web.gsc_queries, article_id=tid, limit=50))
                    tq[path] = set(safe_queries([r["query"] for r in rows]))
                ml = self.deps.extra.get("ml_store")
                related = await ml.related_scores(aid) if ml is not None else {}
                out[aid] = combine(similar, src_q, tq, related)
            s.candidates = out

    @listen(candidates)
    async def plan_and_merge(self) -> None:
        async with self.step("plan_and_merge"):
            results = []
            for aid, cands in self.state.candidates.items():
                r = await self.retry(partial(self.deps.web.plan_links, aid, cands))  # limits enforced by the planner
                results.append({"article_id": aid, **r})
            self.state.results = results
            self.state.outcome = "links_added" if sum(int(r.get("added", 0)) for r in results) else "done"


@persist(INSTANCE_ONLY)
class ReindexFlow(SeoFlow[ReindexState]):
    FLOW: ClassVar[str] = "reindex_flow"

    @start()
    async def chunk_and_embed(self) -> None:
        async with self.step("chunk_and_embed"):
            if self.deps.reindex is None:
                raise RuntimeError("reindex is not configured")
            self.state.result = await self.deps.reindex(self.state.article_ids, self.state.full, self.state.force)
            self.state.outcome = "done"


@persist(INSTANCE_ONLY)
class AskGapsFlow(SeoFlow[AskGapsState]):
    FLOW: ClassVar[str] = "ask_gaps_flow"

    @start()
    async def cluster(self) -> None:
        async with self.step("cluster"):
            self.state.result = await self.retry(lambda: self.deps.web.cluster_ask_gaps())
            self.state.outcome = "done"
