"""backup_flow (D-108): a complete backup of the site, made by the web app, followed and reported here.

    start  (POST /backups/start: the web app queues a full site backup, exactly as Admin → Backups → Back up now does)
    → wait (GET /backups/runs/{id} every 15 s until it is completed, failed or cancelled; one line per phase)
    → report (archive, size, what it holds, its validation, where it is stored, retention; emailed when set up)

The flow never builds an archive and no model is called: the web app's backup service (moks-cms src/lib/backup/)
exports the database from one snapshot, collects every file of the bucket, writes the manifest and checksums, streams
the zip to storage and reads it back to verify it before it counts. Its job queue runs one backup operation at a time
across all replicas, retries transient storage failures and aborts the upload of an interrupted attempt. This flow is
the orchestration, the monitoring and the report; AI & SEO → Schedules starts it (jithendar.com: website-full-backup,
daily at 02:00 Asia/Kolkata), and Run starts it by hand.

What ends the run:
- another backup operation is waiting or running: skipped (outcome "skipped"), never a second backup at once;
- no backup destination (409 backup_not_configured): failed, naming the setting to turn on;
- the backup failed or was cancelled: failed, with the web app's reason;
- the backup stopped reporting (its heartbeat comes every 30 s while it runs) for 10 minutes, or did not start within
  30 minutes: failed as stalled (the web app's queue gives a dead attempt to another replica on its own).
Success only when the web app says the backup completed AND its verification passed. The report holds names, counts,
sizes and states: never database contents or a credential (the web app builds it from its own record).
"""

from __future__ import annotations

import logging
from typing import Any, ClassVar

from crewai.flow import listen, persist, start
from pydantic import PrivateAttr

from ..narrate import count
from ..runs import INSTANCE_ONLY
from ..state import BackupState
from ..webapp import WebAppError
from .base import SeoFlow

log = logging.getLogger("seo_agent.flows.backup")

POLL_S = 15.0
STALL_POLLS = 40  # 10 minutes without a new heartbeat from a running backup
START_POLLS = 120  # 30 minutes waiting to start
DONE = frozenset({"completed", "failed", "cancelled"})
PHASES = {
    "preparing": "preparing (listing the files, measuring the database)",
    "database": "exporting the database",
    "uploads": "adding the files",
    "application": "adding configuration and deployment metadata",
    "finalizing": "writing checksums and the manifest",
    "verifying": "reading the archive back and checking every file",
}


def size(n: int | None) -> str:
    """1536 → "1.5 KB" (binary units, like the admin)."""
    if n is None:
        return "—"
    if n < 1024:
        return f"{n} B"
    v = float(n) / 1024
    for unit in ("KB", "MB", "GB", "TB"):
        if v < 1024 or unit == "TB":
            return f"{v:.0f} {unit}" if v >= 100 else f"{v:.1f} {unit}"
        v /= 1024
    return f"{n} B"


class Stalled(Exception):
    """The web app's backup stopped reporting progress (or never started)."""


@persist(INSTANCE_ONLY)
class BackupFlow(SeoFlow[BackupState]):
    FLOW: ClassVar[str] = "backup_flow"
    _backup: dict[str, Any] = PrivateAttr(default_factory=dict)

    @start()
    async def queue(self) -> None:
        async with self.step("start") as rec:
            s = self.state
            what = "full site backup (database, files, configuration)" if s.type == "full" else "database backup (with configuration, no files)"
            log.info(f"Asking the web app for a {what} (POST /backups/start)", extra={"event": "backup_start", "type": s.type})
            try:
                r = await self.retry(lambda: self.deps.web.backup_start(s.type, s.id or None))
            except WebAppError as e:
                if e.code == "backup_not_configured":
                    s.outcome = "not_configured"
                    raise RuntimeError(f"No backup destination: {e.message}") from e
                raise
            active = r.get("active") or {}
            if not r.get("started") and active.get("ref") == s.id and s.id:
                r = {"started": True, "backup": active}  # this run's own request, answered on a retry
            if not r.get("started"):
                s.outcome = "skipped"
                rec.detail.update(reason="another backup operation is running", active=active.get("id"))
                log.info(
                    f"Skipped: {active.get('label') or 'another backup operation'} is {active.get('status') or 'running'} (since {active.get('startedAt') or '?'}); the web app runs one backup operation at a time",
                    extra={"event": "backup_skipped", "active_id": active.get("id"), "active_status": active.get("status")},
                )
                return
            b = r["backup"]
            s.backup_id = str(b["id"])
            rec.detail.update(backup_id=s.backup_id, type=s.type)
            log.info(f"Queued as backup {s.backup_id}: the web app's backup worker starts it within 15 seconds", extra={"event": "backup_queued", "backup_id": s.backup_id})

    @listen(queue)
    async def wait(self) -> None:
        async with self.step("wait") as rec:
            s = self.state
            if s.outcome == "skipped" or not s.backup_id:
                return
            last_key: tuple[Any, ...] | None = None
            last_beat: Any = None
            quiet = 0
            polls = 0
            while True:
                b = await self.retry(lambda: self.deps.web.backup_run(str(s.backup_id)))
                polls += 1
                beat = b.get("heartbeatAt") or b.get("startedAt")
                quiet = 0 if beat != last_beat else quiet + 1
                last_beat = beat
                key = (b.get("status"), b.get("phase"), b.get("attempts"))
                if key != last_key:
                    last_key = key
                    self._said(b)
                if b.get("status") in DONE:
                    self._backup = b
                    rec.detail.update(status=b.get("status"), polls=polls)
                    return
                if b.get("status") == "pending" and polls >= START_POLLS:
                    s.outcome = "stalled"
                    raise Stalled(f"The backup did not start within {START_POLLS * POLL_S / 60:.0f} minutes: is the web app's backup worker running? (Admin → Backups)")
                if b.get("status") == "running" and quiet >= STALL_POLLS:
                    s.outcome = "stalled"
                    raise Stalled(f"The backup stopped reporting progress {STALL_POLLS * POLL_S / 60:.0f} minutes ago ({PHASES.get(str(b.get('phase')), b.get('phase'))}); the web app hands an interrupted attempt to another replica")
                await self.deps.sleep(POLL_S)

    def _said(self, b: dict[str, Any]) -> None:
        st = b.get("status")
        if st == "pending":
            msg = "Waiting to start" + (f" (attempt {b['attempts'] + 1}: {b['error']})" if b.get("error") and b.get("attempts") else "")
        elif st == "running":
            phase = PHASES.get(str(b.get("phase")), str(b.get("phase") or "working"))
            n = f" ({b['done']:,} of {b['total']:,})" if isinstance(b.get("done"), int) and isinstance(b.get("total"), int) and b["total"] else ""
            msg = f"Running: {phase}{n}" + (f", attempt {b['attempts']}" if (b.get("attempts") or 1) > 1 else "")
        elif st == "completed":
            msg = f"Completed: {b.get('filename')}, {size(b.get('sizeBytes'))}"
        else:
            msg = f"{str(st).capitalize()}: {b.get('error') or 'no reason given'}"
        log.info(msg, extra={"event": "backup_progress", "status": st, "phase": b.get("phase"), "done": b.get("done"), "total": b.get("total"), "attempts": b.get("attempts")})

    @listen(wait)
    async def report(self) -> None:
        async with self.step("report") as rec:
            s = self.state
            if s.outcome == "skipped":
                return
            b = self._backup
            v = b.get("verification") or {}
            db = b.get("database") or None
            up = b.get("uploads") or None
            ok = b.get("status") == "completed" and v.get("ok") is True
            s.result = {
                "status": "completed" if ok else (b.get("status") if b.get("status") != "completed" else "not_validated"),
                "executed_at": b.get("startedAt"),
                "finished_at": b.get("finishedAt"),
                "duration_s": round(float(b["durationMs"]) / 1000, 1) if b.get("durationMs") else None,
                "attempts": b.get("attempts"),
                "backup_id": b.get("id"),
                "archive": b.get("filename"),
                "size_bytes": b.get("sizeBytes"),
                "size": size(b.get("sizeBytes")),
                "sha256": b.get("sha256"),
                "location": b.get("location"),
                "database": {"status": "backed up", "tables": db.get("tables"), "rows": db.get("rows")} if db else {"status": "not backed up"},
                "media": {"status": "backed up" if up.get("ok") else "backed up with missing files", "files": up.get("files"), "bytes": up.get("bytes"), "missing": up.get("referencedMissing")} if up else {"status": "not part of this backup" if s.type == "database" else "not backed up"},
                "validated": bool(v.get("ok")),
                "signature": v.get("signature"),
                "retention_removed": (b.get("retention") or {}).get("removed"),
                "backups_kept": (b.get("storage") or {}).get("backups"),
                "storage_bytes": (b.get("storage") or {}).get("bytes"),
                "warnings": list(b.get("warnings") or [])[:10],
                "error": b.get("error"),
                "details": b.get("adminUrl"),
            }
            rec.detail.update({k: s.result[k] for k in ("status", "archive", "size", "validated") if s.result.get(k) is not None})
            if ok:
                log.info(
                    f"Backup report: {b.get('filename')}, {size(b.get('sizeBytes'))}, "
                    + (f"database {count(int(db.get('tables') or 0), 'table')} / {count(int(db.get('rows') or 0), 'row')}, " if db else "")
                    + (f"{count(int(up.get('files') or 0), 'file')} ({size(up.get('bytes'))}), " if up else "")
                    + f"verified ({count(int(v.get('files') or 0), 'file')} checked), stored at {b.get('location')}"
                    + (f"; retention removed {count(int(s.result['retention_removed']), 'old backup')}" if s.result.get("retention_removed") else "")
                    + (f"; {s.result['backups_kept']} backups kept, {size(s.result['storage_bytes'])}" if s.result.get("backups_kept") is not None else ""),
                    extra={"event": "backup_report", "archive": b.get("filename"), "size_bytes": b.get("sizeBytes"), "validated": True},
                )
                for w in s.result["warnings"]:
                    log.warning(f"Warning from the backup: {w}", extra={"event": "backup_warning"})
            await self._notify(ok)
            if not ok:
                s.outcome = str(s.result["status"])
                raise RuntimeError(f"The backup {s.result['status'].replace('_', ' ')}: {b.get('error') or 'its verification did not pass'}")
            s.outcome = "completed"

    async def _notify(self, ok: bool) -> None:
        s = self.state
        if s.notify == "never" or (s.notify == "failures" and ok) or not s.backup_id:
            return
        try:
            r = await self.deps.web.backup_notify(str(s.backup_id), s.id or None)
            if r.get("sent"):
                log.info(f"Report emailed: {r.get('subject')}", extra={"event": "backup_notified"})
            else:
                log.info(f"Report not emailed: {r.get('reason') or 'email is not set up'}", extra={"event": "backup_not_notified"})
        except WebAppError as e:  # the report is in this run either way
            log.warning(f"Report not emailed: {e.message}", extra={"event": "backup_notify_failed"})
