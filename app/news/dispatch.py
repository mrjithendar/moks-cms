"""Starting content flows when they are due, from the one dispatcher (2026-11-21, crew-jobs plan PR 2).

A content flow (a `news_jobs` row: AI & SEO → Flows → Content flows in the web app; called a crew job until
2026-11-23) has its own cron and time zone. Until 2026-11-21 the
schedule row `news-dispatch` started `news_dispatch_flow` every 15 minutes, and that flow started the jobs that were
due. Now `POST /schedules/dispatch` (called every minute by the one CronJob, app/schedules.py) also calls
`dispatch_jobs`: a job starts within a minute of its time, and after a pause it catches up within the same window as
the schedules (SCHEDULE_CATCHUP_MINUTES). `news_dispatch_flow` keeps the daily housekeeping and the gauges.

Once per time: a time slot is identified as before (`YYYYMMDDTHHMMZ` of the due time as the cron sees it in the job's
time zone, so a slot started by the old dispatcher is recognised) and runs once per job (news_runs_slot_uq, moks-cms
src/db/migrations/0017_news_desk.sql). A slot that already has a run is skipped here, before any flow run is created,
so a slot inside the catch-up window does not produce a "skipped" run every minute.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from ..runs import RunError
from .cron import Cron, CronError
from .desk import as_job

log = logging.getLogger("seo_agent.news.dispatch")

SLOT_FORMAT = "%Y%m%dT%H%MZ"


def job_slot(due: datetime) -> str:
    return due.strftime(SLOT_FORMAT)


async def dispatch_jobs(store: Any, runner: Any, *, enabled: bool, now: datetime, catchup: timedelta) -> dict[str, Any]:
    """One tick for the content flows: start every enabled job whose time has come and has not run for that time yet.
    Never raises for one job; each outcome is reported."""
    out: dict[str, Any] = {"checked": 0, "fired": [], "errors": []}
    if not enabled:
        out["skipped"] = "content flows are switched off (AI & SEO → Flows: \"Content flows on\", or NEWS_DESK_ENABLED=false in the deployment)"
        return out
    for row in await store.list_jobs(enabled_only=True):
        job = as_job(row)
        out["checked"] += 1
        try:
            cron = Cron(job.cron, job.timezone)
        except CronError as e:
            out["errors"].append({"job": job.id, "name": job.name, "error": str(e)})
            continue
        due = cron.last_due(now, catchup)
        await store.set_job_schedule(job.id, next_run_at=cron.next_after(now))
        if due is None:
            continue
        slot = job_slot(due)
        if await store.slot_ran(job.id, slot):
            continue
        fired: dict[str, Any] = {"job": job.id, "name": job.name, "slot": slot, "run_id": None, "existing": False, "error": None}
        try:
            r = await runner.kickoff("news_job_flow", {"job_id": job.id, "slot": slot, "trigger": "cron"}, triggered_by="flow", actor=f"job:{job.id}")
            fired["run_id"] = str(r.get("run_id") or "") or None
            fired["existing"] = bool(r.get("existing"))
        except RunError as e:
            fired["error"] = str(e)[:500]
        except Exception as e:  # the next job still runs; this one says why it did not
            fired["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        out["fired"].append(fired)
        log.info(f"content flow {job.name}: {'started' if not fired['error'] else 'not started'}", extra={"event": "job_fired", **fired})
    return out
