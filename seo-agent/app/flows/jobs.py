"""gsc_sync_flow, ga4_sync_flow, tech_audit_flow: data-only flows (no LLM) around the existing v1 job runner.

lock (the run manager's advisory lock) → run the existing job in the web app (`runSeoJob`: Search Console sync,
GA4 sync, or the SSRF-safe crawler + audit; it keeps its own per-type lease, seo_sync_jobs row and metrics) →
record its stats on the run. The slot (e.g. the date) makes a scheduled run idempotent: the web app skips a job
type whose scheduled run for that slot already exists, so the CronJob and the legacy scheduler can never both run it.

The run log says which job it asked for and what came back: rows written, the date range, a partial or skipped run
and why, the error.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from .. import narrate
from ..runs import INSTANCE_ONLY
from ..state import JobState
from .base import SeoFlow

log = logging.getLogger("seo_agent.flows.jobs")

JOB_WORDS = {
    "gsc_sync": "the Search Console sync (clicks, impressions and positions per page and query, into seo_gsc_* tables)",
    "ga4_sync": "the Google Analytics 4 sync (sessions and engagement per page, into seo_ga4_* tables)",
    "technical_scan": "the technical audit (crawls the site's pages and records their issues)",
}
STATUS_WORDS = {"succeeded": "succeeded", "partial": "partly done (the next run carries on)", "failed": "failed", "skipped": "skipped"}


def job_result(job: str, r: dict[str, Any]) -> str:
    """The web app's answer in words: "gsc_sync succeeded: 1,234 rows written for 2026-10-29 to 2026-11-25"."""
    st = str(r.get("status") or "unknown")
    out = f"{job} {STATUS_WORDS.get(st, st)}"
    if st != "skipped":
        out += f": {narrate.count(int(r.get('rows') or 0), 'row')} written"
    w = r.get("window")
    if isinstance(w, dict) and w.get("start"):
        out += f" for {w.get('start')} to {w.get('end')}"
    if r.get("skipped"):
        out += f" ({r['skipped']}" + (f"; that run {r['previousStatus']}" if r.get("previousStatus") else "") + ")"
    if r.get("error"):
        out += f". {'Error' if st == 'failed' else 'Note'}" + (f" ({r['errorCode']})" if r.get("errorCode") else "") + f": {str(r['error'])[:300]}"
    return out


def _job_flow(flow: str, job: str) -> type[SeoFlow[JobState]]:
    """CrewAI 1.15 registers @start/@listen methods defined on the concrete class only (inherited ones are ignored),
    so each job flow is built here with its own methods."""

    @persist(INSTANCE_ONLY)
    class JobFlow(SeoFlow[JobState]):
        FLOW: ClassVar[str] = flow
        JOB: ClassVar[str] = job

        @start()
        async def run_job(self) -> dict[str, Any]:
            async with self.step("run_job"):
                slot = self.state.slot or (datetime.now(UTC).strftime("%Y-%m-%d") if self.state.triggered_by == "cron" else None)
                self.state.job_type, self.state.slot = self.JOB, slot
                trigger = "schedule" if self.state.triggered_by == "cron" else "manual"
                log.info(
                    f"Asking the web app to run {JOB_WORDS.get(self.JOB, self.JOB)}" + (f", scheduled for {slot}" if trigger == "schedule" and slot else ", started by hand"),
                    extra={"event": "job_requested", "job": self.JOB, "slot": slot, "trigger": trigger},
                )
                r = await self.retry(lambda: self.deps.web.run_job(self.JOB, slot, trigger))
                st = str(r.get("status") or "")
                log.log(logging.WARNING if st == "failed" else logging.INFO, job_result(self.JOB, r), extra={"event": "job_result", "job": self.JOB, "status": st, "rows": r.get("rows")})
                self.state.result = {k: r.get(k) for k in ("id", "status", "rows", "error", "errorCode", "window", "correlationId", "skipped")}
                return r

        @listen(run_job)
        async def record_stats(self) -> None:
            async with self.step("record_stats"):
                st = str(self.state.result.get("status") or "")
                # The web job's own statuses: succeeded | partial | failed | skipped (skipped = slot already done,
                # locked, or not configured; none of those is a failure of the flow).
                self.state.outcome = {"failed": "failed", "skipped": "skipped", "partial": "partial"}.get(st, "done")
                if st == "failed":
                    self.state.errors.append(f"{self.JOB}: {self.state.result.get('error') or 'failed'}")

    JobFlow.__name__ = JobFlow.__qualname__ = "".join(w.capitalize() for w in flow.split("_"))
    return JobFlow


GscSyncFlow = _job_flow("gsc_sync_flow", "gsc_sync")
Ga4SyncFlow = _job_flow("ga4_sync_flow", "ga4_sync")
TechAuditFlow = _job_flow("tech_audit_flow", "technical_scan")
