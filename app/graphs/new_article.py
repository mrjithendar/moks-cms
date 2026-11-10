"""Graph new_article: load_brief → draft_new_article (CrewAI) → validate → human_review ⏸ → publish → verify_live →
submit_search. Starts when an admin approves a content-gap idea on the editorial calendar (the web app reserves a
draft against the idea's CMS draft post first; thread_id = that draft id).

validate is the web app's new-article validator (MDX parses, title/meta length, duplicate titles, internal links only
to existing published paths, external links only to cited sources, no H1, fact-check flags surfaced). One automatic
retry with the validator's messages as feedback, then generation_failed. Approving publishes the CMS draft post
through the CMS's own publish path, only with a recorded admin approval.
"""

from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from ..llm import BudgetExceeded
from .common import (
    RETRY,
    Cost,
    Deps,
    ErrorList,
    after_publish,
    after_review,
    after_verify,
    budget_paused,
    close_node,
    measure_node,
    node,
    publish_node,
    review_node,
    submit_node,
    verify_node,
)

GRAPH = "new_article"
MAX_ATTEMPTS = 2


class State(TypedDict, total=False):
    thread_id: str
    draft_id: str
    article_id: str
    calendar_id: str
    brief: dict[str, Any]
    document: dict[str, Any] | None
    crew: dict[str, Any]
    changes: list[dict[str, Any]]
    validation_report: dict[str, Any]
    attempts: int
    feedback: str | None
    review_decision: dict[str, Any]
    publish_result: dict[str, Any]
    verification: dict[str, Any]
    submission_results: dict[str, Any]
    measurement: dict[str, Any]
    status: str
    errors: ErrorList
    cost_usd: Cost


def build(deps: Deps, checkpointer: Any = None) -> Any:
    async def load_brief(s: State) -> dict[str, Any]:
        b = await deps.web.calendar_brief(s["calendar_id"])
        return {"brief": b, "article_id": b.get("postId") or s.get("article_id"), "attempts": 0}

    async def draft_new_article(s: State) -> dict[str, Any]:
        attempts = int(s.get("attempts", 0)) + 1
        try:
            r = await deps.crew_factory().run(s["brief"], feedback=s.get("feedback"), draft_id=s.get("draft_id"))
        except BudgetExceeded as e:
            await deps.web.set_draft_status(s["draft_id"], "generation_failed", f"Paused: {e.detail}")
            return budget_paused(e)
        return {"attempts": attempts, "document": r.draft.model_dump(), "crew": {"status": r.status, "tokens": r.tokens, "tool_calls": len(r.tool_calls), "fetched_sources": r.fetched_sources}, "cost_usd": r.cost_usd}

    def after_draft(s: State) -> str:
        return "end" if s.get("status") == "paused_budget" else "validate"

    async def validate(s: State) -> dict[str, Any]:
        doc = s.get("document") or {}
        report = await deps.web.validate(s["article_id"], {"draftId": s["draft_id"], "kind": "new_article", "document": doc})
        errors = list(report.get("errors") or [])
        if errors and int(s.get("attempts", 0)) < MAX_ATTEMPTS and not doc.get("incomplete"):
            return {"validation_report": report, "feedback": "- " + "\n- ".join(errors[:20])}
        if errors and not doc.get("incomplete"):
            reason = f"Validation failed: {'; '.join(errors[:5])}"[:1000]
            await deps.web.set_draft_status(s["draft_id"], "generation_failed", reason)
            return {"validation_report": report, "status": "generation_failed", "errors": [reason]}
        # An incomplete crew result is still shown to the reviewer (marked incomplete, with its errors as flags):
        # a partial draft is more useful than nothing, and approval stays blocked by the error flags.
        await deps.web.save_draft(s["draft_id"], {"kind": "new_article", "document": doc, "changes": report.get("changes") or [], "flags": report.get("flags") or [], "summary": f"New article: {doc.get('title', '')}", "model": deps.settings.draft_model, "promptVersion": "seo-crew-v1", "threadId": s["thread_id"]})
        return {"validation_report": report, "changes": report.get("changes") or [], "feedback": None}

    def after_validate(s: State) -> str:
        if s.get("status") == "generation_failed":
            return "end"
        return "draft_new_article" if s.get("feedback") else "human_review"

    async def regenerate(s: State) -> dict[str, Any]:
        fb = (s.get("review_decision") or {}).get("feedback") or "Write a fresh draft."
        await deps.web.set_draft_status(s["draft_id"], "generating", None)
        return {"attempts": 0, "feedback": f"Reviewer feedback: {fb}"}

    g = StateGraph(State)
    g.add_node("load_brief", node(GRAPH, "load_brief", deps, load_brief), retry_policy=RETRY)
    g.add_node("draft_new_article", node(GRAPH, "draft_new_article", deps, draft_new_article))
    g.add_node("validate", node(GRAPH, "validate", deps, validate), retry_policy=RETRY)
    g.add_node("human_review", node(GRAPH, "human_review", deps, review_node(deps)))
    g.add_node("regenerate", node(GRAPH, "regenerate", deps, regenerate), retry_policy=RETRY)
    g.add_node("close", node(GRAPH, "close", deps, close_node(deps)))
    g.add_node("publish", node(GRAPH, "publish", deps, publish_node(deps)), retry_policy=RETRY)
    g.add_node("verify_live", node(GRAPH, "verify_live", deps, verify_node(deps)), retry_policy=RETRY)
    g.add_node("submit_search", node(GRAPH, "submit_search", deps, submit_node(deps)), retry_policy=RETRY)
    g.add_node("schedule_measure", node(GRAPH, "schedule_measure", deps, measure_node(deps)))
    g.add_edge(START, "load_brief")
    g.add_edge("load_brief", "draft_new_article")
    g.add_conditional_edges("draft_new_article", after_draft, {"validate": "validate", "end": END})
    g.add_conditional_edges("validate", after_validate, {"draft_new_article": "draft_new_article", "human_review": "human_review", "end": END})
    g.add_conditional_edges("human_review", after_review, {"publish": "publish", "regenerate": "regenerate", "close": "close"})
    g.add_edge("regenerate", "draft_new_article")
    g.add_edge("close", END)
    g.add_conditional_edges("publish", after_publish, {"verify_live": "verify_live", "end": END})
    g.add_conditional_edges("verify_live", after_verify, {"submit_search": "submit_search", "end": END})
    g.add_edge("submit_search", "schedule_measure")
    g.add_edge("schedule_measure", END)
    return g.compile(checkpointer=checkpointer)
