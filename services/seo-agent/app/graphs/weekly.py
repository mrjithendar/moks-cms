"""Graph weekly_recommendations: prepare (freshness + rules + scoring, in the web app) → fan_out → summarize.

`prepare` calls the web app, which checks Search Console/GA4 freshness (queues a sync if stale), refreshes the v1
rules and scores, picks the top N articles with auto-eligible recommendations and **no open draft**, and reserves one
draft per article (the partial unique index guarantees one open draft per article). `fan_out` starts one
optimize_article child run per draft (thread_id = draft id) with at most SEO_AGENT_FANOUT_CONCURRENCY in flight; each
child stops at its own human_review. Re-running this node after a restart is safe: starting an existing thread is a
no-op.

Message Batches: a graph node needs its model answer inline (validate → retry → review), so child runs use the
synchronous API with prompt caching; the legacy path (SEO_ORCHESTRATOR=legacy) keeps using Batches (D-46).
"""

from __future__ import annotations

import asyncio
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .common import RETRY, Cost, Deps, ErrorList, node

GRAPH = "weekly_recommendations"


class State(TypedDict, total=False):
    thread_id: str
    limit: int
    prepared: dict[str, Any]
    children: list[dict[str, Any]]
    status: str
    errors: ErrorList
    cost_usd: Cost


def build(deps: Deps, checkpointer: Any = None) -> Any:
    async def prepare(s: State) -> dict[str, Any]:
        r = await deps.web.weekly_candidates(int(s.get("limit") or deps.settings.weekly_max_articles))
        return {"prepared": r}

    async def fan_out(s: State) -> dict[str, Any]:
        items = (s.get("prepared") or {}).get("items", [])
        if not items:
            return {"children": [], "status": "done"}
        start_child, wait_child = deps.start_child, deps.wait_child
        assert start_child is not None and wait_child is not None, "fan-out needs a run manager"
        sem = asyncio.Semaphore(deps.settings.fanout_concurrency)

        async def one(it: dict[str, Any]) -> dict[str, Any]:
            async with sem:
                started = await start_child("optimize_article", {"article_id": it["articleId"], "draft_id": it["draftId"], "recommendation_ids": it.get("recommendationIds", []), "trigger": "weekly"}, it["draftId"])
                if not started.get("existing"):
                    done = await wait_child(it["draftId"])  # returns at interrupt (human_review) or end
                else:
                    done = started
                return {"article_id": it["articleId"], "draft_id": it["draftId"], "status": done.get("status"), "outcome": done.get("outcome")}

        results = await asyncio.gather(*(one(it) for it in items), return_exceptions=True)
        children, errors = [], []
        for it, r in zip(items, results, strict=True):
            if isinstance(r, BaseException):
                errors.append(f"{it['draftId']}: {type(r).__name__}")
                children.append({"article_id": it["articleId"], "draft_id": it["draftId"], "status": "failed"})
            else:
                children.append(r)
        return {"children": children, "status": "done", "errors": errors}

    g = StateGraph(State)
    g.add_node("prepare", node(GRAPH, "prepare", deps, prepare), retry_policy=RETRY)
    g.add_node("fan_out", node(GRAPH, "fan_out", deps, fan_out))
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "fan_out")
    g.add_edge("fan_out", END)
    return g.compile(checkpointer=checkpointer)
