"""backup_flow (D-108): the web app makes a complete site backup; the flow queues it, follows it and reports it.

Stand-in: BackupWeb below answers POST /backups/start, GET /backups/runs/{id} (a scripted sequence of states, as
moks-cms src/lib/backup/callbacks.ts reports them) and POST /backups/notify. The flow must never count a backup as made
unless the web app says it completed and its verification passed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from app.flows import CRON_FLOWS, FLOW_INFO, MCP_KICKOFF_ALLOWLIST, SPECS, check_kickoff
from app.flows.backup import STALL_POLLS, size
from app.main import memory_container
from app.runs import RunError
from app.webapp import QUIET_PATHS, WebAppError
from tests.conftest import FakeWebApp, settings

BID = "0b9f4c1e-6a2d-4c35-9a3e-1f2b3c4d5e6f"
NAME = "jithendar-com-backup-2026-11-28-203000-full.zip"


def state(status: str, phase: str | None = None, *, beat: str = "t0", **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": BID, "status": status, "type": "full", "label": "full site backup (CrewAI flow)", "phase": phase, "message": None,
        "done": None, "total": None, "heartbeatAt": beat, "startedAt": "2026-11-28T20:30:00.000Z", "finishedAt": None, "durationMs": None,
        "attempts": 1 if status != "pending" else 0, "filename": None, "sizeBytes": None, "sha256": None, "location": None, "components": [],
        "database": None, "uploads": None, "verification": None, "retention": None, "storage": None, "warnings": [], "error": None,
        "ref": None, "adminUrl": "https://jithendar.com/admin/backups",
    }
    out.update(extra)
    return out


DONE = state(
    "completed",
    "verifying",
    beat="t9",
    finishedAt="2026-11-28T20:33:10.000Z",
    durationMs=190_000,
    filename=NAME,
    sizeBytes=734_003_200,
    sha256="a" * 64,
    location=f"jithendar-backups/jithendar/backups/{NAME}",
    components=["database", "uploads", "application", "deployment"],
    database={"ok": True, "tables": 141, "rows": 52_318, "bytes": 81_000_000, "secretsRedacted": 9, "excludedTables": 11},
    uploads={"ok": True, "files": 1_204, "bytes": 640_000_000, "referencedMissing": 0},
    verification={"ok": True, "checkedAt": "2026-11-28T20:33:09.000Z", "files": 1_352, "signature": "valid"},
    retention={"removed": 1, "kept": 14, "error": None},
    storage={"backups": 14, "bytes": 9_800_000_000},
    adminUrl=f"https://jithendar.com/admin/backups/{NAME}",
)


@dataclass
class BackupWeb(FakeWebApp):
    start_answer: Any = None  # dict, or an exception
    states: list[dict[str, Any]] = field(default_factory=lambda: [state("pending"), state("running", "database", beat="t1", done=40, total=141), state("running", "uploads", beat="t2", done=600, total=1204), state("running", "verifying", beat="t3"), DONE])
    notify_answer: Any = None
    started: list[tuple[str, str | None]] = field(default_factory=list)
    polled: int = 0
    notified: list[str] = field(default_factory=list)

    async def backup_start(self, backup_type: str, flow_run_id: str | None) -> dict[str, Any]:
        self.started.append((backup_type, flow_run_id))
        a = self.start_answer
        if isinstance(a, Exception):
            raise a
        return a or {"started": True, "backup": state("pending")}

    async def backup_run(self, backup_id: str) -> dict[str, Any]:
        assert backup_id == BID
        i = min(self.polled, len(self.states) - 1)
        self.polled += 1
        return self.states[i]

    async def backup_notify(self, backup_id: str, flow_run_id: str | None) -> dict[str, Any]:
        self.notified.append(backup_id)
        if isinstance(self.notify_answer, Exception):
            raise self.notify_answer
        return self.notify_answer or {"sent": True, "subject": f"Backup completed: website-full-backup ({NAME})"}


async def run(web: BackupWeb, llm: Any, inputs: dict[str, Any] | None = None, trigger: str = "manual") -> dict[str, Any]:
    c = memory_container(settings(), llm=llm, web=web)
    r = await c.runner.kickoff("backup_flow", inputs or {}, triggered_by=trigger)
    return await c.runner.wait(r["run_id"], 30)


def test_registered_schedulable_manual_never_mcp_and_strict_inputs() -> None:
    assert "backup_flow" in SPECS and "backup_flow" in CRON_FLOWS and "backup_flow" not in MCP_KICKOFF_ALLOWLIST
    check_kickoff("backup_flow", "manual")
    check_kickoff("backup_flow", "cron")
    with pytest.raises(RunError):
        check_kickoff("backup_flow", "mcp")
    model = SPECS["backup_flow"].input_model
    assert model.model_validate({}).model_dump() == {"type": "full", "notify": "always"}
    assert model.model_validate({"type": "database", "notify": "failures"}).type == "database"
    for bad in ({"type": "everything"}, {"notify": "sometimes"}, {"sql": "drop table post"}):
        with pytest.raises(Exception):  # noqa: B017 - pydantic's ValidationError
            model.model_validate(bad)
    assert FLOW_INFO["backup_flow"]["label"] == "Website backup" and "no model is called" in FLOW_INFO["backup_flow"]["description"]
    assert any("/backups/runs/".startswith(p) or p == "/backups/runs/" for p in QUIET_PATHS)  # no log line per poll


async def test_queues_the_web_apps_backup_follows_it_and_reports_it(llm: Any) -> None:
    web = BackupWeb()
    r = await run(web, llm, trigger="cron")
    assert r["status"] == "succeeded", r
    out = r["outputs"]
    assert out["outcome"] == "completed" and out["result"]["backup_id"] == BID
    assert web.started and web.started[0][0] == "full" and web.started[0][1]  # the run's own id goes with it
    res = out["result"]
    assert res["status"] == "completed" and res["validated"] is True and res["signature"] == "valid"
    assert res["archive"] == NAME and res["size"] == "700 MB" and res["size_bytes"] == 734_003_200
    assert res["location"].endswith(f"jithendar/backups/{NAME}")
    assert res["database"] == {"status": "backed up", "tables": 141, "rows": 52_318}
    assert res["media"]["status"] == "backed up" and res["media"]["files"] == 1_204
    assert res["duration_s"] == 190.0 and res["retention_removed"] == 1 and res["backups_kept"] == 14
    assert web.notified == [BID]
    assert llm.calls == [] if hasattr(llm, "calls") else True  # orchestration only: no model call


async def test_another_backup_running_is_skipped_never_a_second_one(llm: Any) -> None:
    web = BackupWeb(start_answer={"started": False, "reason": "busy", "active": state("running", "uploads", label="restore of x.zip", ref="someone-else")})
    r = await run(web, llm)
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "skipped"
    assert web.polled == 0 and web.notified == []


async def test_a_retried_start_recognises_its_own_backup(llm: Any) -> None:
    # The first POST reached the web app but its answer was lost; the retry is told "busy" with this run's backup.
    web = BackupWeb()

    async def start(backup_type: str, flow_run_id: str | None) -> dict[str, Any]:
        web.started.append((backup_type, flow_run_id))
        return {"started": False, "reason": "busy", "active": state("pending", ref=flow_run_id)}

    web.backup_start = start  # type: ignore[method-assign]
    r = await run(web, llm)
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "completed"


async def test_no_destination_fails_and_says_which_setting(llm: Any) -> None:
    web = BackupWeb(start_answer=WebAppError(409, "Turn on the backup destination first (Settings → System → Backups).", "backup_not_configured"))
    r = await run(web, llm)
    assert r["status"] == "failed" and "Settings → System → Backups" in (r.get("error") or "")


async def test_a_failed_backup_fails_the_run_with_the_reason_and_is_reported(llm: Any) -> None:
    failed = state("failed", "uploads", beat="t5", error="Not started: the backup would be about 3.0 GB, more than the 1.0 GB allowed in Settings → System → Backups.", finishedAt="2026-11-28T20:31:00.000Z")
    web = BackupWeb(states=[state("pending"), failed])
    r = await run(web, llm)
    assert r["status"] == "failed" and "more than the 1.0 GB allowed" in (r.get("error") or "")
    assert r["outputs"]["result"]["status"] == "failed" and r["outputs"]["result"]["validated"] is False
    assert web.notified == [BID]


async def test_completed_but_not_verified_is_not_a_success(llm: Any) -> None:
    unverified = dict(DONE, verification={"ok": False, "checkedAt": "x", "files": 10, "signature": "invalid"})
    web = BackupWeb(states=[state("running", "verifying"), unverified])
    r = await run(web, llm, {"notify": "failures"})
    assert r["status"] == "failed" and r["outputs"]["result"]["status"] == "not_validated"
    assert web.notified == [BID]


async def test_a_backup_that_stops_reporting_is_failed_as_stalled(llm: Any) -> None:
    web = BackupWeb(states=[state("running", "uploads", beat="frozen")])
    r = await run(web, llm)
    assert r["status"] == "failed" and "stopped reporting progress" in (r.get("error") or "")
    assert web.polled == STALL_POLLS + 1


async def test_a_retry_in_the_web_app_keeps_the_flow_waiting(llm: Any) -> None:
    retrying = state("pending", beat="t4", attempts=1, error="Attempt 1 failed (Unexpected error: ECONNRESET); it will be tried again.")
    web = BackupWeb(states=[state("running", "database", beat="t1"), retrying, state("running", "database", beat="t6", attempts=2), dict(DONE, attempts=2)])
    r = await run(web, llm)
    assert r["status"] == "succeeded" and r["outputs"]["result"]["attempts"] == 2


async def test_notify_never_or_a_mail_failure_never_changes_the_outcome(llm: Any) -> None:
    web = BackupWeb()
    r = await run(web, llm, {"notify": "never"})
    assert r["status"] == "succeeded" and web.notified == []
    web2 = BackupWeb(notify_answer=WebAppError(500, "mail provider down"))
    r2 = await run(web2, llm)
    assert r2["status"] == "succeeded" and web2.notified == [BID]


def test_sizes_read_like_the_admin() -> None:
    assert size(None) == "—" and size(512) == "512 B" and size(1536) == "1.5 KB" and size(734_003_200) == "700 MB" and size(3 * 1024**3) == "3.0 GB"
