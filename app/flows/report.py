"""report_flow: aggregate → Report Crew narrative → number check → store → PDF to R2 → notify (if recipients configured).

    aggregate (web app v1 buildReport: every number, computed from synced data; stored as the report, no email yet)
      → narrate (Report Crew, one agent, cheap model; explains the numbers, cannot compute them)
      → check (every number in the text must equal a pre-computed fact; any mismatch fails the report: the narrative
               is not stored, the numbers-only report stays, the run is failed with outcome report_mismatch)
      → store (narrative into the report payload)
      → render_pdf (app/reports_pdf.py: designed A4 PDF with KPI cards, charts and tables; the narrative is included
               only when it passed the check) → saved to Cloudflare R2 through the web app's existing storage client
               (private key under jithendar/www/reports/seo/…; admins download it via a short-lived presigned link)
      → notify (the existing sendMail path, with the PDF link; a no-op unless email is enabled and recipients are
               configured; once per report). A failed number check still saves the numbers-only PDF, but does not
               notify, and the run is failed (alert).
"""

from __future__ import annotations

from typing import ClassVar

from crewai.flow import listen, or_, persist, router, start

from ..crews.report import check_numbers, facts
from ..llm import BudgetExceeded
from ..reports_pdf import render
from ..runs import INSTANCE_ONLY
from ..state import ReportState
from .base import SeoFlow


@persist(INSTANCE_ONLY)
class ReportFlow(SeoFlow[ReportState]):
    FLOW: ClassVar[str] = "report_flow"

    @start()
    async def aggregate(self) -> None:
        async with self.step("aggregate"):
            r = await self.retry(lambda: self.deps.web.report_generate(self.state.period))
            self.state.report_id = str(r["id"])
            self.state.numbers = r.get("report") or {}

    @listen(aggregate)
    async def narrate(self) -> None:
        async with self.step("narrate"):
            s = self.state
            crew = self.deps.report_crew() if self.deps.report_crew else None
            if crew is None:
                raise RuntimeError("report crew is not configured")
            try:
                r = await crew.run(s.numbers, facts(s.numbers))
            except BudgetExceeded as e:
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.crew = {"status": r.status, "reason": r.reason, "tokens": r.tokens}
            s.narrative = r.narrative

    @router(narrate)
    def check(self) -> str:
        s = self.state
        if s.outcome == "paused_budget":
            return "to_notify_only"
        if not s.narrative:
            s.check = {"ok": False, "mismatches": [], "reason": s.crew.get("reason") or "no narrative"}
            return "to_mismatch"
        s.check = check_numbers(s.narrative, facts(s.numbers))
        return "to_store" if s.check["ok"] else "to_mismatch"

    @listen("to_store")
    async def store(self) -> None:
        async with self.step("store"):
            s = self.state
            await self.retry(lambda: self.deps.web.report_narrative(str(s.report_id), s.narrative, s.check))

    @listen("to_mismatch")
    async def mismatch(self) -> None:
        async with self.step("mismatch"):
            s = self.state
            s.errors.append(f"report narrative failed the number check: {', '.join(s.check.get('mismatches') or []) or s.check.get('reason')}")
            s.outcome = "report_mismatch"

    @listen(or_(store, mismatch, "to_notify_only"))
    async def render_pdf(self) -> None:
        async with self.step("render_pdf"):
            s = self.state
            verified = bool(s.check.get("ok"))
            pdf = render(s.numbers, narrative=s.narrative if verified else "", verified=verified)
            r = await self.retry(lambda: self.deps.web.report_pdf(str(s.report_id), pdf))
            s.pdf = {"key": r.get("key"), "bytes": len(pdf), "with_narrative": verified}

    @listen(render_pdf)
    async def notify(self) -> None:
        async with self.step("notify"):
            s = self.state
            if s.outcome == "report_mismatch":
                return
            s.notified = await self.retry(lambda: self.deps.web.report_notify(str(s.report_id)))
            s.outcome = s.outcome or "done"
