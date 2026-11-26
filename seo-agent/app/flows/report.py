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

A report from the CrewAI console (input `report_id`, D-102) takes the same steps on its own data:

    aggregate (the web app's report: any date range, the selected categories, crews, flows and sources, each source
               with its status, the findings it computed, the figures the analysis may cite, and error text marked
               untrusted)
      → narrate (the Report crew's site analyst: executive summary, achievements and risks, root causes, fixes,
               recommendations, action plan, each citing evidence ids)
      → check (check_analysis: an item with a number that is not a figure of the report, or without evidence from
               it, is left out; a "confirmed" cause without direct evidence is shown as probable). A budget refusal or
               a crew failure is not a failed report: it is rendered without the AI part, and says why
      → store → render_pdf (reports_site_pdf.py) → notify (the web app emails it when the report asked for it).
"""

from __future__ import annotations

import logging
from typing import ClassVar

from crewai.flow import listen, or_, persist, router, start

from ..crews.report import SiteAnalysis, check_analysis, check_numbers, data_numbers, evidence_ids, facts, site_facts
from ..llm import BudgetExceeded
from ..logs import RUN_ONLY
from ..narrate import count
from ..narrate import facts as fmt_facts
from ..reports_pdf import render
from ..reports_site_pdf import render_site
from ..runs import INSTANCE_ONLY
from ..state import ReportState
from .base import SeoFlow

log = logging.getLogger("seo_agent.flows.report")
ANALYSIS_PARTS = ("achievements", "risks", "root_causes", "fixes", "recommendations", "action_plan")


def _parts(analysis: dict[str, object]) -> str:
    """ "3 achievements, 2 risks, …": what the site analyst's analysis holds."""
    return ", ".join(f"{len(v)} {k.replace('_', ' ')}" for k in ANALYSIS_PARTS if isinstance(v := analysis.get(k), list))


@persist(INSTANCE_ONLY)
class ReportFlow(SeoFlow[ReportState]):
    FLOW: ClassVar[str] = "report_flow"

    @start()
    async def aggregate(self) -> None:
        async with self.step("aggregate"):
            s = self.state
            if s.report_id:  # a console report: its id is the input (the briefing gets its id from the web app below)
                s.site = True
                r = await self.retry(lambda: self.deps.web.site_report_data(str(s.report_id)))
                s.numbers = r.get("report") or {}
                if not s.numbers.get("categories"):
                    raise RuntimeError("the web app returned no report data")
                cats = s.numbers.get("categories")
                names = list(cats) if isinstance(cats, dict) else [str(c.get("key") or c.get("name") or "") if isinstance(c, dict) else str(c) for c in cats] if isinstance(cats, list) else []
                log.info(f"Report {s.report_id}: the web app gathered the figures for {count(len(names), 'category', 'categories')} ({', '.join(n for n in names[:10] if n)})", extra={"event": "report_data", "categories": len(names)})
                return
            log.info(f"Asking the web app to build the {self.state.period} SEO briefing's figures", extra={"event": "report_generate", "period": self.state.period})
            r = await self.retry(lambda: self.deps.web.report_generate(self.state.period))
            self.state.report_id = str(r["id"])
            self.state.numbers = r.get("report") or {}
            log.info(f"Briefing {self.state.report_id}: {count(len(facts(self.state.numbers)), 'figure')} to write about", extra={"event": "report_data"})

    @listen(aggregate)
    async def narrate(self) -> None:
        async with self.step("narrate"):
            s = self.state
            crew = self.deps.report_crew() if self.deps.report_crew else None
            if s.site:
                await self._analyse(crew)
                return
            if crew is None:
                raise RuntimeError("report crew is not configured")
            log.info("The report crew writes the briefing's narrative from these figures only", extra={"event": "report_narrate"})
            try:
                r = await crew.run(s.numbers, facts(s.numbers))
            except BudgetExceeded as e:
                self.add_budget_cost(e)
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                log.warning(f"No narrative: the LLM budget is reached ({e.detail}); the briefing is sent with its figures only", extra={"event": "report_budget"})
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.crew = {"status": r.status, "reason": r.reason, "tokens": r.tokens}
            s.narrative = r.narrative
            log.info(f"Narrative: {len(r.narrative or ''):,} characters" if r.narrative else f"No narrative: {r.reason or 'the crew gave none'}", extra={"event": "report_narrative", RUN_ONLY: {"narrative": (r.narrative or "")[:3000]}})

    async def _analyse(self, crew: object) -> None:
        """The site analyst; anything that stops it leaves the report without its AI part, with the reason."""
        s = self.state
        if crew is None or not hasattr(crew, "analyse"):
            s.crew = {"status": "skipped", "reason": "the report crew is not configured"}
            log.warning("No AI analysis: the report crew is not configured; the report has its figures only", extra={"event": "report_analysis_skipped"})
            return
        log.info("The site analyst reads the figures: summary, achievements and risks, root causes, fixes, recommendations and an action plan, each citing its evidence", extra={"event": "report_analyse"})
        try:
            r = await crew.analyse(s.numbers)
        except BudgetExceeded as e:
            self.add_budget_cost(e)
            s.crew = {"status": "skipped", "reason": f"the LLM budget refused the analysis: {e.detail}"}
            log.warning(f"No AI analysis: {s.crew['reason']}; the report has its figures only", extra={"event": "report_budget"})
            return
        except Exception as e:  # a provider error or a crew failure: the figures are still worth a report
            log.warning("site report analysis failed", extra={"event": "site_report_analysis_failed", "error": f"{type(e).__name__}: {str(e)[:200]}"})
            s.crew = {"status": "failed", "reason": f"{type(e).__name__}: {str(e)[:300]}"}
            return
        s.add_cost(r.cost_usd, r.tokens)
        s.crew = {"status": r.status, "reason": r.reason, "tokens": r.tokens, "cost_usd": r.cost_usd}
        s.analysis = r.analysis.model_dump() if r.analysis is not None else {}
        log.info(f"Analysis: {_parts(s.analysis)}" if s.analysis else f"No analysis: {r.reason or 'the crew gave none'}", extra={"event": "report_analysis", RUN_ONLY: {"executive_summary": str(s.analysis.get("executive_summary") or "")[:2000]}})

    @router(narrate)
    def check(self) -> str:
        s = self.state
        if s.site:
            if s.analysis:
                ids, confirmed = evidence_ids(s.numbers)
                s.analysis, s.check = check_analysis(SiteAnalysis.model_validate(s.analysis), site_facts(s.numbers) + data_numbers(s.numbers), ids, confirmed)
                c = s.check
                removed = c.get("removed") or []
                log.log(
                    logging.WARNING if removed else logging.INFO,
                    f"Evidence check: {c.get('kept', 0)} items kept, {len(removed)} left out (a number that is not in the report, or no evidence)"
                    + (f", {c['downgraded']} confirmed causes shown as probable (their evidence is not direct)" if c.get("downgraded") else ""),
                    extra={"event": "report_check", "kept": c.get("kept"), "removed": len(removed), RUN_ONLY: {"removed_items": removed[:20]}},
                )
            else:
                s.check = {"ok": False, "kept": 0, "removed": [], "reason": s.crew.get("reason") or "no analysis"}
            return "to_store"
        if s.outcome == "paused_budget":
            return "to_notify_only"
        if not s.narrative:
            s.check = {"ok": False, "mismatches": [], "reason": s.crew.get("reason") or "no narrative"}
            return "to_mismatch"
        s.check = check_numbers(s.narrative, facts(s.numbers))
        mism = s.check.get("mismatches") or []
        log.log(
            logging.INFO if s.check["ok"] else logging.WARNING,
            f"Number check: all {s.check.get('checked', 0)} numbers in the narrative match the figures" if s.check["ok"] else f"Number check failed: {count(len(mism), 'number')} not in the figures ({', '.join(map(str, mism[:5]))}); the narrative is not used",
            extra={"event": "report_check", "checked": s.check.get("checked"), "mismatches": len(mism)},
        )
        return "to_store" if s.check["ok"] else "to_mismatch"

    @listen("to_store")
    async def store(self) -> None:
        async with self.step("store"):
            s = self.state
            if s.site:
                await self.retry(lambda: self.deps.web.site_report_analysis(str(s.report_id), s.analysis, s.check, s.crew))
                log.info(f"Analysis saved on report {s.report_id}", extra={"event": "report_stored"})
                return
            await self.retry(lambda: self.deps.web.report_narrative(str(s.report_id), s.narrative, s.check))
            log.info(f"Narrative saved on briefing {s.report_id}", extra={"event": "report_stored"})

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
            if s.site:
                pdf = render_site(s.numbers, s.analysis, {**s.check, "reason": s.crew.get("reason")})
                r = await self.retry(lambda: self.deps.web.site_report_pdf(str(s.report_id), pdf))
                s.pdf = {"key": r.get("key"), "bytes": len(pdf), "with_analysis": bool(s.analysis)}
                log.info(f"PDF rendered ({len(pdf) // 1024:,} KB, " + ("with the AI analysis" if s.analysis else "figures only") + ") and stored", extra={"event": "report_pdf", "bytes": len(pdf)})
                return
            verified = bool(s.check.get("ok"))
            pdf = render(s.numbers, narrative=s.narrative if verified else "", verified=verified)
            r = await self.retry(lambda: self.deps.web.report_pdf(str(s.report_id), pdf))
            s.pdf = {"key": r.get("key"), "bytes": len(pdf), "with_narrative": verified}
            log.info(f"PDF rendered ({len(pdf) // 1024:,} KB, " + ("with the narrative" if verified else "figures only") + ") and stored", extra={"event": "report_pdf", "bytes": len(pdf)})

    @listen(render_pdf)
    async def notify(self) -> None:
        async with self.step("notify"):
            s = self.state
            if s.site:
                s.notified = await self.retry(lambda: self.deps.web.site_report_notify(str(s.report_id)))
                s.outcome = "done"
                log.info(f"Notification: {fmt_facts(s.notified) or 'done'}", extra={"event": "report_notified"})
                return
            if s.outcome == "report_mismatch":
                log.info("Not sent: the narrative failed the number check (the PDF has the figures only)", extra={"event": "report_not_sent"})
                return
            s.notified = await self.retry(lambda: self.deps.web.report_notify(str(s.report_id)))
            s.outcome = s.outcome or "done"
            log.info(f"Notification: {fmt_facts(s.notified) or 'done'}", extra={"event": "report_notified"})
