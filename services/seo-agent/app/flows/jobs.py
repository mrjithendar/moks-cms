"""gsc_sync_flow, ga4_sync_flow, tech_audit_flow: data-only flows (no LLM) around the existing v1 job runner.

lock (the run manager's advisory lock) → run the existing job in the web app (`runSeoJob`: Search Console sync,
GA4 sync, or the SSRF-safe crawler + audit; it keeps its own per-type lease, seo_sync_jobs row and metrics) →
record its stats on the run. The slot (e.g. the date) makes a scheduled run idempotent: the web app skips a job
type whose scheduled run for that slot already exists, so the CronJob and the legacy scheduler can never both run it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from ..runs import INSTANCE_ONLY
from ..state import JobState
from .base import SeoFlow


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
                r = await self.retry(lambda: self.deps.web.run_job(self.JOB, slot, trigger))
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
# Topic discovery (docs/seo/TOPICS.md): the web app collects trend items and Search Console demand and scores topics.
TopicDiscoveryFlow = _job_flow("topic_discovery_flow", "topic_discovery")
# Automatic editorial planning: the web app puts the best candidates on the calendar on the configured cadence.
CalendarPlanFlow = _job_flow("calendar_plan_flow", "calendar_plan")
# Automatic drafting: the web app starts new_article_flow for planned items whose date is near (a separate run each).
CalendarAutodraftFlow = _job_flow("calendar_autodraft_flow", "calendar_autodraft")
