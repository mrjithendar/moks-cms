"""Graph optimize_article (docs/seo/AGENTS.md has the Mermaid diagram).

fetch_context → analyze → draft_changes → validate ─┬─ ok ─────────────→ human_review ⏸
                              ▲                     └─ fail, retry < 1 ─┘      │
                              └──────── regenerate (edit) ◄────────────────────┤
                                                                               ├─ reject → close
                                                                               └─ approve → publish → verify_live
                                                                                   ├─ fail → (alert + rollback offer) end
                                                                                   └─ ok → submit_search → schedule_measure

thread_id = draft id. The draft row is reserved by the web app before the run starts (one open draft per article).
"""

from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from ..llm import BudgetExceeded, CallSpec, InvalidOutput
from ..schemas import ModelChangeSet
from ..tools import data_block
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

GRAPH = "optimize_article"
PROMPT_VERSION = "seo-draft-v3"
MAX_ATTEMPTS = 2  # the first try + exactly one automatic retry


class State(TypedDict, total=False):
    thread_id: str
    draft_id: str
    article_id: str
    recommendation_ids: list[str]
    extra: list[dict[str, Any]]
    trigger: str
    context: dict[str, Any]
    metrics_snapshot: dict[str, Any]
    related: list[dict[str, Any]]
    plan: dict[str, Any]
    change_set: dict[str, Any] | None
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
    async def fetch_context(s: State) -> dict[str, Any]:
        ctx = await deps.web.article_context(s["article_id"], {"recommendationIds": s.get("recommendation_ids") or [], "extra": s.get("extra") or []})
        if ctx.get("status") != "published":
            return {"status": "no_changes", "context": ctx, "errors": ["article is not published"]}
        related = []
        try:
            for aid, path, score in await deps.retriever.similar_articles(s["article_id"], k=5):
                related.append({"article_id": aid, "path": path, "similarity": round(score, 3)})
        except Exception as e:  # retrieval is an enrichment; drafting proceeds without it
            return {"context": ctx, "related": [], "metrics_snapshot": ctx.get("metrics") or {}, "errors": [f"related: {type(e).__name__}"]}
        return {"context": ctx, "related": related, "metrics_snapshot": ctx.get("metrics") or {}, "attempts": 0}

    async def analyze(s: State) -> dict[str, Any]:
        ctx = s["context"]
        recs = [r for r in ctx.get("recommendations", []) if not s.get("recommendation_ids") or r["id"] in s["recommendation_ids"]]
        model_cats = [c for c in ctx.get("modelCategories", []) if c not in ("internal_links", "new_article")]
        if not recs and not s.get("extra"):
            return {"status": "no_changes", "plan": {"model": False, "links": False}}
        return {"plan": {"model": bool(model_cats) and ctx.get("draftingEnabled", True), "links": bool(ctx.get("linksAllowed")), "categories": ctx.get("categories", []), "recommendation_ids": [r["id"] for r in recs]}}

    def after_fetch(s: State) -> str:
        return "end" if s.get("status") == "no_changes" else "analyze"

    def after_analyze(s: State) -> str:
        if s.get("status") == "no_changes":
            return "end"
        return "draft_changes" if s["plan"]["model"] else "validate"

    async def draft_changes(s: State) -> dict[str, Any]:
        ctx = s["context"]
        user = ctx["prompt"]["user"]
        if s.get("related"):
            user += "\n\n" + data_block("related_site_articles", s["related"])
        if ctx.get("ga4"):
            user += "\n\n" + data_block("ga4_engagement_28d", ctx["ga4"])
        feedback = s.get("feedback")
        if feedback:
            user += f"\n\n<feedback>{feedback[:4000]}\nAnswer again with the complete JSON object, fixing every problem.</feedback>"
        spec = CallSpec(model=deps.settings.draft_model, purpose="draft" if not s.get("review_decision") else "regenerate", prompt_version=PROMPT_VERSION, cached_system=[ctx["prompt"]["rules"], ctx["prompt"]["styleGuide"]], user=user, max_tokens=int(ctx["prompt"].get("maxTokens", 4096)), draft_id=s.get("draft_id"))
        attempts = int(s.get("attempts", 0)) + 1
        try:
            cs, usage = await deps.llm.structured(spec, ModelChangeSet)
        except BudgetExceeded as e:
            await deps.web.set_draft_status(s["draft_id"], "generation_failed", f"Paused: {e.detail}")
            return budget_paused(e)
        except InvalidOutput as e:
            cost = e.usage.cost_usd() if e.usage else 0.0
            return {"attempts": attempts, "change_set": None, "validation_report": {"errors": [f"schema: {str(e)[:500]}"], "flags": []}, "cost_usd": cost}
        return {"attempts": attempts, "change_set": cs.model_dump(), "cost_usd": usage.cost_usd()}

    def after_draft(s: State) -> str:
        return "end" if s.get("status") == "paused_budget" else "validate"

    async def validate(s: State) -> dict[str, Any]:
        if s.get("plan", {}).get("model") and s.get("change_set") is None:
            report = s.get("validation_report") or {"errors": ["no output"], "flags": []}
        else:
            report = await deps.web.validate(
                s["article_id"],
                {
                    "draftId": s["draft_id"],
                    "output": s.get("change_set") or {"summary": "Internal links only.", "changes": []},
                    "recommendationIds": s["plan"].get("recommendation_ids", []),
                    "extra": s.get("extra") or [],
                    "includeLinks": s["plan"].get("links", False),
                },
            )
        errors = list(report.get("errors") or [])
        if errors:
            if int(s.get("attempts", 0)) < MAX_ATTEMPTS and s.get("plan", {}).get("model"):
                return {"validation_report": report, "feedback": "Your previous answer was rejected by the validator:\n- " + "\n- ".join(errors[:20])}
            reason = f"Validation failed: {'; '.join(errors[:5])}"[:1000]
            await deps.web.set_draft_status(s["draft_id"], "generation_failed", reason)
            return {"validation_report": report, "status": "generation_failed", "errors": [reason]}
        changes = report.get("changes") or []
        if not changes:
            await deps.web.set_draft_status(s["draft_id"], "superseded", "Nothing worth changing for these recommendations.")
            return {"validation_report": report, "status": "no_changes", "changes": []}
        # The one write an automated step makes: the draft (never the article). Idempotent upsert by draft id.
        await deps.web.save_draft(
            s["draft_id"],
            {
                "changes": changes,
                "flags": report.get("flags") or [],
                "summary": (s.get("change_set") or {}).get("summary") or "Internal link suggestions.",
                "recommendationIds": s["plan"].get("recommendation_ids", []),
                "categories": s["plan"].get("categories", []),
                "model": deps.settings.draft_model if s.get("change_set") else None,
                "promptVersion": PROMPT_VERSION,
                "threadId": s["thread_id"],
            },
        )
        return {"validation_report": report, "changes": changes, "feedback": None}

    def after_validate(s: State) -> str:
        if s.get("status") in ("generation_failed", "no_changes"):
            return "end"
        if (s.get("validation_report") or {}).get("errors"):
            return "draft_changes"  # the one automatic retry
        return "human_review"

    async def regenerate(s: State) -> dict[str, Any]:
        d = s.get("review_decision") or {}
        fb = d.get("feedback") or "The reviewer asked for a fresh set of changes."
        await deps.web.set_draft_status(s["draft_id"], "generating", None)
        return {"attempts": 0, "feedback": f"Reviewer feedback on the previous draft: {fb}", "change_set": None, "validation_report": {}, "plan": {**s["plan"], "model": True}}

    g = StateGraph(State)
    g.add_node("fetch_context", node(GRAPH, "fetch_context", deps, fetch_context), retry_policy=RETRY)
    g.add_node("analyze", node(GRAPH, "analyze", deps, analyze))
    g.add_node("draft_changes", node(GRAPH, "draft_changes", deps, draft_changes), retry_policy=RETRY)
    g.add_node("validate", node(GRAPH, "validate", deps, validate), retry_policy=RETRY)
    g.add_node("human_review", node(GRAPH, "human_review", deps, review_node(deps)))
    g.add_node("regenerate", node(GRAPH, "regenerate", deps, regenerate), retry_policy=RETRY)
    g.add_node("close", node(GRAPH, "close", deps, close_node(deps)))
    g.add_node("publish", node(GRAPH, "publish", deps, publish_node(deps)), retry_policy=RETRY)
    g.add_node("verify_live", node(GRAPH, "verify_live", deps, verify_node(deps)), retry_policy=RETRY)
    g.add_node("submit_search", node(GRAPH, "submit_search", deps, submit_node(deps)), retry_policy=RETRY)
    g.add_node("schedule_measure", node(GRAPH, "schedule_measure", deps, measure_node(deps)))
    g.add_edge(START, "fetch_context")
    g.add_conditional_edges("fetch_context", after_fetch, {"analyze": "analyze", "end": END})
    g.add_conditional_edges("analyze", after_analyze, {"draft_changes": "draft_changes", "validate": "validate", "end": END})
    g.add_conditional_edges("draft_changes", after_draft, {"validate": "validate", "end": END})
    g.add_conditional_edges("validate", after_validate, {"draft_changes": "draft_changes", "human_review": "human_review", "end": END})
    g.add_conditional_edges("human_review", after_review, {"publish": "publish", "regenerate": "regenerate", "close": "close"})
    g.add_edge("regenerate", "draft_changes")
    g.add_edge("close", END)
    g.add_conditional_edges("publish", after_publish, {"verify_live": "verify_live", "end": END})
    g.add_conditional_edges("verify_live", after_verify, {"submit_search": "submit_search", "end": END})
    g.add_edge("submit_search", "schedule_measure")
    g.add_edge("schedule_measure", END)
    return g.compile(checkpointer=checkpointer)
