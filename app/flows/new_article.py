"""new_article_flow: an approved calendar idea → Editorial Crew → validate → **draft awaiting review**.

    load_brief → draft (Editorial Crew) ─┬─ budget → paused
                   ▲                     └─ validate ─┬─ ok (or incomplete crew result) → save_draft (draft_ready)
                   └── errors, first try ─────────────┤
                                                      └─ errors after retry → failed

Starts when an admin creates a draft from an approved content-gap idea (the web app creates the CMS draft post and
reserves a `new_article` draft first). An incomplete crew result is still saved for the reviewer, marked incomplete,
with approval blocked by its error flags. Publishing happens only in publish_flow after a human approval.
"""

from __future__ import annotations

from typing import ClassVar

from crewai.flow import listen, or_, persist, router, start

from ..llm import BudgetExceeded
from ..runs import INSTANCE_ONLY
from ..state import NewArticleState
from .base import SeoFlow

PROMPT_VERSION = "seo-crew-v7"
MAX_ATTEMPTS = 2


@persist(INSTANCE_ONLY)
class NewArticleFlow(SeoFlow[NewArticleState]):
    FLOW: ClassVar[str] = "new_article_flow"

    @start()
    async def load_brief(self) -> None:
        async with self.step("load_brief"):
            s, web = self.state, self.deps.web
            if s.feedback:
                await self.retry(lambda: web.set_draft_status(s.draft_id, "generating", None))
            b = await self.retry(lambda: web.calendar_brief(s.calendar_id))
            s.brief = b
            s.article_id = b.get("postId") or s.article_id

    @listen(or_(load_brief, "to_retry"))
    async def draft(self) -> None:
        async with self.step("draft"):
            s = self.state
            s.attempts += 1
            crew = self.deps.editorial_crew() if self.deps.editorial_crew else None
            if crew is None:
                raise RuntimeError("editorial crew is not configured")
            try:
                r = await crew.run(s.brief, feedback=s.feedback, validator_feedback=s.validator_feedback, feedback_untrusted=s.triggered_by == "mcp", draft_id=s.draft_id)
            except BudgetExceeded as e:
                self.add_budget_cost(e)
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.document = r.draft.model_dump()
            s.crew = {"status": r.status, "tokens": r.tokens, "tool_calls": len(r.tool_calls), "fetched_sources": r.fetched_sources, "config": getattr(r, "config", None)}

    @router(draft)
    def after_draft(self) -> str:
        return "to_paused" if self.state.outcome == "paused_budget" else "to_validate"

    @listen("to_validate")
    async def validate_draft(self) -> None:
        async with self.step("validate_draft"):
            s = self.state
            doc = s.document or {}
            report = await self.retry(lambda: self.deps.web.validate(str(s.article_id), {"draftId": s.draft_id, "kind": "new_article", "document": doc}))
            s.validation_report = report
            if report.get("errors") and s.attempts < MAX_ATTEMPTS and not doc.get("incomplete"):
                # Kept apart from the reviewer's feedback, which the retry must still address.
                s.validator_feedback = "- " + "\n- ".join(list(report["errors"])[:20])

    @router(validate_draft)
    def after_validate(self) -> str:
        s = self.state
        errors = s.validation_report.get("errors")
        incomplete = bool((s.document or {}).get("incomplete"))
        if errors and not incomplete:
            return "to_retry" if s.attempts < MAX_ATTEMPTS else "to_fail"
        return "to_ok"

    @listen("to_ok")
    async def save_draft(self) -> None:
        async with self.step("save_draft"):
            s = self.state
            doc = s.document or {}
            r = s.validation_report
            await self.retry(lambda: self.deps.web.save_draft(s.draft_id, {"kind": "new_article", "document": doc, "changes": r.get("changes") or [], "flags": r.get("flags") or [], "summary": f"New article: {doc.get('title', '')}", "model": self._body_model(), "promptVersion": (s.crew.get("config") or {}).get("prompt_version") or PROMPT_VERSION, "threadId": s.draft_id, "runId": s.id}))
            s.feedback = s.validator_feedback = None
            s.outcome = "draft_ready"

    def _body_model(self) -> str:
        """The model recorded on the draft: the one that wrote the body (per-run override, SEO_CREW_MODELS, default)."""
        st = self.deps.settings
        return str(((self.state.brief or {}).get("models") or {}).get("writer") or st.crew_models.get("editorial.writer") or st.draft_model)

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
