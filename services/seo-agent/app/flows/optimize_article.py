"""optimize_article_flow: an existing article → Optimization Crew → v2 validators → **draft awaiting review**.

    fetch_context ─┬─ not published / nothing eligible ─────────────────────────────→ skip (no_changes)
                   └─ analyze ─┬─ links only ─────────────────┐
                               └─ draft (Optimization Crew) ──┼→ validate ─┬─ ok ───→ save_draft (draft_ready)
                                   ▲    └─ budget → paused     │           ├─ errors, first try → draft (retry once)
                                   └───────────────────────────┘           └─ errors after retry → failed

The flow ends here. It cannot publish: the only write is the draft (web app `/drafts/{id}/save`, every change
`pending`), and the web app refuses any publish without a human approval (publish_flow, started only by an
approval). Regenerate = a new run of this flow with the reviewer's feedback.
"""

from __future__ import annotations

from typing import Any, ClassVar

from crewai.flow import listen, or_, persist, router, start

from ..llm import BudgetExceeded
from ..runs import INSTANCE_ONLY
from ..state import OptimizeState
from .base import SeoFlow

PROMPT_VERSION = "seo-draft-v4-crew"
MAX_ATTEMPTS = 2  # the first try + exactly one automatic retry


@persist(INSTANCE_ONLY)
class OptimizeArticleFlow(SeoFlow[OptimizeState]):
    FLOW: ClassVar[str] = "optimize_article_flow"

    @start()
    async def fetch_context(self) -> None:
        async with self.step("fetch_context"):
            s, web = self.state, self.deps.web
            if s.feedback:
                await self.retry(lambda: web.set_draft_status(s.draft_id, "generating", None))
            ctx = await self.retry(lambda: web.article_context(s.article_id, {"recommendationIds": s.recommendation_ids, "extra": s.extra}))
            s.context = ctx
            if ctx.get("status") != "published":
                s.outcome, s.errors = "no_changes", [*s.errors, "article is not published"]
                return
            try:
                s.related = [{"article_id": a, "path": p, "similarity": round(sc, 3)} for a, p, sc in await self.deps.retriever.similar_articles(s.article_id, k=5)]
            except Exception as e:  # retrieval is an enrichment; drafting proceeds without it
                s.errors.append(f"related: {type(e).__name__}")

    @router(fetch_context)
    def after_fetch(self) -> str:
        return "to_skip" if self.state.outcome == "no_changes" else "to_analyze"

    @listen("to_analyze")
    async def analyze(self) -> None:
        async with self.step("analyze"):
            s = self.state
            ctx = s.context
            recs = [r for r in ctx.get("recommendations", []) if not s.recommendation_ids or r["id"] in s.recommendation_ids]
            model_cats = [c for c in ctx.get("modelCategories", []) if c not in ("internal_links", "new_article")]
            if not recs and not s.extra:
                s.outcome = "no_changes"
                return
            s.plan = {"model": (bool(model_cats) and ctx.get("draftingEnabled", True)) or bool(s.feedback), "links": bool(ctx.get("linksAllowed")), "categories": ctx.get("categories", []), "recommendation_ids": [r["id"] for r in recs]}

    @router(analyze)
    def after_analyze(self) -> str:
        if self.state.outcome == "no_changes":
            return "to_skip"
        return "to_draft" if self.state.plan.get("model") else "to_links_only"

    @listen(or_("to_draft", "to_retry"))
    async def draft(self) -> None:
        async with self.step("draft"):
            s = self.state
            s.attempts += 1
            crew = self.deps.optimization_crew() if self.deps.optimization_crew else None
            if crew is None:
                raise RuntimeError("optimization crew is not configured")
            try:
                r = await crew.run(s.context, article_id=s.article_id, related=s.related, feedback=s.feedback, draft_id=s.draft_id, recommendation_ids=s.plan.get("recommendation_ids"))
            except BudgetExceeded as e:
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.crew = {"status": r.status, "reason": r.reason, "tokens": r.tokens, "tool_calls": len(r.tool_calls)}
            if r.result is None:
                s.change_set = None
                s.validation_report = {"errors": [f"crew: {r.reason or 'no output'}"], "flags": []}
            else:
                s.change_set = r.result.change_set.model_dump()
                s.change_set["_fact_check"] = [f.model_dump() for f in r.result.needs_fact_check]
                s.change_set["_problem"] = r.result.problem_statement

    @router(draft)
    def after_draft(self) -> str:
        return "to_paused" if self.state.outcome == "paused_budget" else "to_validate"

    @listen(or_("to_validate", "to_links_only"))
    async def validate_draft(self) -> None:
        async with self.step("validate_draft"):
            s = self.state
            if s.plan.get("model") and s.change_set is None:
                report = s.validation_report or {"errors": ["no output"], "flags": []}
            else:
                cs = {k: v for k, v in (s.change_set or {"summary": "Internal links only.", "changes": []}).items() if not k.startswith("_")}
                report = await self.retry(lambda: self.deps.web.validate(s.article_id, {"draftId": s.draft_id, "output": cs, "recommendationIds": s.plan.get("recommendation_ids", []), "extra": s.extra, "includeLinks": s.plan.get("links", False)}))
                # The technical reviewer's needs_fact_check items become flags the human sees (never auto-resolved).
                fc = (s.change_set or {}).get("_fact_check") or []
                report = {**report, "flags": [*(report.get("flags") or []), *({"code": "needs_fact_check", "severity": f.get("severity", "warning"), "message": f"{f.get('claim')}: {f.get('reason')}"} for f in fc)]}
            s.validation_report = report
            if report.get("errors"):
                if s.attempts < MAX_ATTEMPTS and s.plan.get("model"):
                    s.feedback = "Your previous answer was rejected by the validator:\n- " + "\n- ".join(list(report["errors"])[:20])
            else:
                s.changes = report.get("changes") or []

    @router(validate_draft)
    def after_validate(self) -> str:
        s = self.state
        if not s.validation_report.get("errors"):
            return "to_ok" if s.changes else "to_nothing"
        return "to_retry" if s.attempts < MAX_ATTEMPTS and s.plan.get("model") else "to_fail"

    @listen("to_ok")
    async def save_draft(self) -> None:
        async with self.step("save_draft"):
            s = self.state
            body: dict[str, Any] = {
                "changes": s.changes,
                "flags": s.validation_report.get("flags") or [],
                "summary": (s.change_set or {}).get("summary") or "Internal link suggestions.",
                "recommendationIds": s.plan.get("recommendation_ids", []),
                "categories": s.plan.get("categories", []),
                "model": self.deps.settings.draft_model if s.change_set else None,
                "promptVersion": PROMPT_VERSION,
                "threadId": s.draft_id,
                "runId": s.id,
            }
            # The one write an automated step makes: the draft (never the article). Idempotent upsert by draft id;
            # the web app stores every change as `pending` and the draft as `ready_for_review`.
            await self.retry(lambda: self.deps.web.save_draft(s.draft_id, body))
            s.feedback = None
            s.outcome = "draft_ready"

    @listen("to_nothing")
    async def nothing_to_change(self) -> None:
        async with self.step("nothing_to_change"):
            await self.retry(lambda: self.deps.web.set_draft_status(self.state.draft_id, "superseded", "Nothing worth changing for these recommendations."))
            self.state.outcome = "no_changes"

    @listen("to_fail")
    async def failed(self) -> None:
        async with self.step("failed"):
            s = self.state
            reason = f"Validation failed: {'; '.join(list(s.validation_report.get('errors') or [])[:5])}"[:1000]
            await self.retry(lambda: self.deps.web.set_draft_status(s.draft_id, "generation_failed", reason))
            s.errors.append(reason)
            s.outcome = "generation_failed"

    @listen("to_paused")
    async def paused(self) -> None:
        async with self.step("paused"):
            s = self.state
            await self.retry(lambda: self.deps.web.set_draft_status(s.draft_id, "generation_failed", f"Paused: {s.errors[-1] if s.errors else 'LLM budget reached'}"))

    @listen("to_skip")
    async def skip(self) -> None:
        async with self.step("skip"):
            s = self.state
            s.outcome = "no_changes"
            if s.draft_id:
                await self.retry(lambda: self.deps.web.set_draft_status(s.draft_id, "superseded", (s.errors[-1] if s.errors else "No eligible recommendations.")[:500]))
