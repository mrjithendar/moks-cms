"""Graph internal_linking: candidates (pgvector similarity + shared Search Console queries) → plan (v2 hard limits,
in the web app) → merged into the article's open draft as internal_link changes.

The limits are enforced by v2's deterministic planner (services/www/src/lib/seo-intel/internal-links.ts), which this
graph feeds with relevance scores; it never writes links itself: ≤ 3 new per article, density cap, one per target,
nothing in headings/code/first sentence/existing links, ≤ 5 new inbound per target per rolling week. Claude is not
involved (v2 D-25).
"""

from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from ..tools import safe_queries
from .common import RETRY, Cost, Deps, ErrorList, node

GRAPH = "internal_linking"
W_VECTOR, W_QUERIES = 0.65, 0.35


class State(TypedDict, total=False):
    thread_id: str
    article_ids: list[str]
    candidates: dict[str, list[dict[str, Any]]]
    results: list[dict[str, Any]]
    status: str
    errors: ErrorList
    cost_usd: Cost


def combine(similar: list[tuple[str, str, float]], source_queries: set[str], target_queries: dict[str, set[str]]) -> list[dict[str, Any]]:
    """Relevance per target path: weighted cosine similarity + Jaccard overlap of the queries both pages rank for."""
    out = []
    for _aid, path, sim in similar:
        tq = target_queries.get(path, set())
        overlap = len(source_queries & tq) / len(source_queries | tq) if (source_queries or tq) else 0.0
        out.append({"path": path, "score": round(W_VECTOR * max(0.0, sim) + W_QUERIES * overlap, 4), "similarity": round(sim, 4), "sharedQueries": sorted(source_queries & tq)[:5]})
    return sorted(out, key=lambda c: -c["score"])


def build(deps: Deps, checkpointer: Any = None) -> Any:
    async def candidates(s: State) -> dict[str, Any]:
        out: dict[str, list[dict[str, Any]]] = {}
        for aid in s.get("article_ids", []):
            similar = await deps.retriever.similar_articles(aid, k=12)
            src_q = set(safe_queries([r["query"] for r in await deps.web.gsc_queries(article_id=aid, limit=50)]))
            tq: dict[str, set[str]] = {}
            for _tid, path, _ in similar:
                rows = await deps.web.gsc_queries(topic=None, article_id=_tid, limit=50)
                tq[path] = set(safe_queries([r["query"] for r in rows]))
            out[aid] = combine(similar, src_q, tq)
        return {"candidates": out}

    async def plan(s: State) -> dict[str, Any]:
        results = []
        for aid, cands in (s.get("candidates") or {}).items():
            r = await deps.web.plan_links(aid, cands)
            results.append({"article_id": aid, **r})
        added = sum(int(r.get("added", 0)) for r in results)
        return {"results": results, "status": "links_added" if added else "done"}

    g = StateGraph(State)
    g.add_node("candidates", node(GRAPH, "candidates", deps, candidates), retry_policy=RETRY)
    g.add_node("plan", node(GRAPH, "plan", deps, plan), retry_policy=RETRY)
    g.add_edge(START, "candidates")
    g.add_edge("candidates", "plan")
    g.add_edge("plan", END)
    return g.compile(checkpointer=checkpointer)
