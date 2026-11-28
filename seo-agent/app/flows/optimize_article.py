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

import logging
from typing import Any, ClassVar

from crewai.flow import listen, or_, persist, router, start

from ..llm import BudgetExceeded
from ..logs import RUN_ONLY
from ..narrate import count
from ..runs import INSTANCE_ONLY
from ..state import OptimizeState
from .base import SeoFlow, log_validation

log = logging.getLogger("seo_agent.flows.optimize_article")

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
            if s.feedback:
                log.info(f"Drafting again with the reviewer's feedback ({len(s.feedback):,} characters)", extra={"event": "draft_feedback", RUN_ONLY: {"feedback": s.feedback[:2000]}})
            ctx = await self.retry(lambda: web.article_context(s.article_id, {"recommendationIds": s.recommendation_ids, "extra": s.extra}))
            s.context = ctx
            if ctx.get("status") != "published":
                s.outcome, s.errors = "no_changes", [*s.errors, "article is not published"]
                log.info(f"Nothing to do: the article is {ctx.get('status') or 'not published'}, only published articles are optimized", extra={"event": "article_not_published"})
                return
            m = ctx.get("metrics") if isinstance(ctx.get("metrics"), dict) else {}
            log.info(
                f"Article {ctx.get('path') or s.article_id}: {count(len(ctx.get('recommendations') or []), 'open recommendation')}"
                + (f"; Search Console, last 28 days: {count(int(m.get('impressions') or 0), 'impression')}, {count(int(m.get('clicks') or 0), 'click')}" if m else ""),
                extra={"event": "article_context", RUN_ONLY: {"recommendations": [{k: r.get(k) for k in ("category", "problem")} for r in (ctx.get("recommendations") or [])][:20]}},
            )
            try:
                s.related = [{"article_id": a, "path": p, "similarity": round(sc, 3)} for a, p, sc in await self.deps.retriever.similar_articles(s.article_id, k=5)]
                log.info(f"Related articles from the article index: {', '.join(r['path'] for r in s.related) or 'none'}", extra={"event": "related_articles", "related": len(s.related)})
            except Exception as e:  # retrieval is an enrichment; drafting proceeds without it
                s.errors.append(f"related: {type(e).__name__}")
                log.warning(f"Related articles not found ({type(e).__name__}); drafting goes on without them", extra={"event": "related_failed"})

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
                log.info("Nothing to do: none of the asked-for recommendations is open for this article", extra={"event": "plan_nothing"})
                return
            s.plan = {"model": (bool(model_cats) and ctx.get("draftingEnabled", True)) or bool(s.feedback), "links": bool(ctx.get("linksAllowed")), "categories": ctx.get("categories", []), "recommendation_ids": [r["id"] for r in recs]}
            cats = sorted({str(r.get("category")) for r in recs if r.get("category")})
            if s.plan["model"]:
                plan = f"the optimization crew drafts changes for {count(len(recs), 'recommendation')} ({', '.join(cats) or 'any category'})"
            else:
                plan = "no model drafting (these categories are not drafted by the crew, or drafting is off): internal links only"
            log.info(f"Plan: {plan}" + ("; internal links are suggested too" if s.plan["links"] and s.plan["model"] else ""), extra={"event": "plan", "model": s.plan["model"], "links": s.plan["links"]})

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
            log.info(
                f"Attempt {s.attempts} of {MAX_ATTEMPTS}: the optimization crew analyses the article, edits it and reviews the change set"
                + (" (fixing the validator's errors from the last attempt)" if s.validator_feedback else ""),
                extra={"event": "draft_attempt", "attempt": s.attempts},
            )
            try:
                r = await crew.run(s.context, article_id=s.article_id, related=s.related, feedback=s.feedback, validator_feedback=s.validator_feedback, feedback_untrusted=s.triggered_by == "mcp", draft_id=s.draft_id, recommendation_ids=s.plan.get("recommendation_ids"))
            except BudgetExceeded as e:
                self.add_budget_cost(e)
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                log.warning(f"Paused: the LLM budget is reached ({e.detail}). The draft is marked failed; run it again when there is budget", extra={"event": "draft_budget"})
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.crew = {"status": r.status, "reason": r.reason, "tokens": r.tokens, "tool_calls": len(r.tool_calls), "config": getattr(r, "config", None)}
            if r.result is None:
                s.change_set = None
                s.validation_report = {"errors": [f"crew: {r.reason or 'no output'}"], "flags": []}
            else:
                s.change_set = r.result.change_set.model_dump()
                s.change_set["_fact_check"] = [f.model_dump() for f in r.result.needs_fact_check]
                s.change_set["_problem"] = r.result.problem_statement
            if r.result is None:
                log.warning(f"The crew gave no change set: {r.reason or 'no output'}", extra={"event": "change_set_missing"})
            else:
                ch = list(r.result.change_set.changes)
                kinds = sorted({str(getattr(c, "type", "") or getattr(c, "field", "") or "change") for c in ch})
                log.info(
                    f"Change set: {count(len(ch), 'change')} ({', '.join(kinds) or 'none'}), {count(len(r.result.needs_fact_check), 'claim')} to fact-check",
                    extra={"event": "change_set", "changes": len(ch), RUN_ONLY: {"summary": r.result.change_set.summary, "problem": r.result.problem_statement}},
                )

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
            log_validation(log, report, retry=bool(report.get("errors")) and s.attempts < MAX_ATTEMPTS and bool(s.plan.get("model")))
            if report.get("errors"):
                if s.attempts < MAX_ATTEMPTS and s.plan.get("model"):
                    # Kept apart from the reviewer's feedback, which the retry must still address.
                    s.validator_feedback = "- " + "\n- ".join(list(report["errors"])[:20])
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
            ran = (s.crew or {}).get("config") or {}  # the crew configuration version an admin activated, if one ran
            body: dict[str, Any] = {
                "changes": s.changes,
                "flags": s.validation_report.get("flags") or [],
                "summary": (s.change_set or {}).get("summary") or "Internal link suggestions.",
                "recommendationIds": s.plan.get("recommendation_ids", []),
                "categories": s.plan.get("categories", []),
                "model": self.deps.settings.llm_model if s.change_set else None,
                "promptVersion": PROMPT_VERSION + (f"+v{ran['version']}" if ran.get("source") == "version" and ran.get("version") else ""),
                "threadId": s.draft_id,
                "runId": s.id,
            }
            # The one write an automated step makes: the draft (never the article). Idempotent upsert by draft id;
            # the web app stores every change as `pending` and the draft as `ready_for_review`.
            await self.retry(lambda: self.deps.web.save_draft(s.draft_id, body))
            s.feedback = s.validator_feedback = None
            s.outcome = "draft_ready"
            log.info(f"Saved for review: draft {s.draft_id} with {count(len(s.changes), 'change')} waits in the review queue (the article changes only after a person approves)", extra={"event": "draft_saved", "draft_id": s.draft_id})

    @listen("to_nothing")
    async def nothing_to_change(self) -> None:
        async with self.step("nothing_to_change"):
            await self.retry(lambda: self.deps.web.set_draft_status(self.state.draft_id, "superseded", "Nothing worth changing for these recommendations."))
            self.state.outcome = "no_changes"
            log.info("Nothing worth changing for these recommendations: the draft is closed (superseded)", extra={"event": "draft_superseded"})

    @listen("to_fail")
    async def failed(self) -> None:
        async with self.step("failed"):
            s = self.state
            reason = f"Validation failed: {'; '.join(list(s.validation_report.get('errors') or [])[:5])}"[:1000]
            await self.retry(lambda: self.deps.web.set_draft_status(s.draft_id, "generation_failed", reason))
            s.errors.append(reason)
            s.outcome = "generation_failed"
            log.warning(f"Gave up after {count(s.attempts, 'attempt')}: {reason}. The draft is marked failed in the review queue", extra={"event": "draft_failed"})

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
                log.info(f"Draft {s.draft_id} closed (superseded): {(s.errors[-1] if s.errors else 'no eligible recommendations')}", extra={"event": "draft_superseded"})
