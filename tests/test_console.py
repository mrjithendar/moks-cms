"""CrewAI console, phases 2 and 3 (D-98): schedules and their dispatcher, the flow catalogue and Run with parameters,
crew configuration versions, and the crew test run (app/schedules.py, app/crews/config.py, app/flows/crew_test.py)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.crews import config as crew_config
from app.crews.report import ReportCrew, facts
from app.flows import CRON_FLOWS, SPECS, check_kickoff
from app.index import MemoryRetriever
from app.llm import FakeLlm
from app.main import create_app, memory_container
from app.runs import RunError
from app.schedules import MemoryScheduleStore, SchedulesUnavailable, dispatch
from tests.conftest import FakeWebApp, sample_report, settings

AUTH = {"Authorization": "Bearer " + "t" * 40}
NOW = datetime(2026, 11, 23, 6, 10, 30, tzinfo=UTC)  # a Monday, 06:10:30 UTC
ANSWER = "Thought: I now know the final answer\nFinal Answer: Clicks rose 14.1% to 665."


@pytest.fixture
def web() -> FakeWebApp:
    return FakeWebWithConfigs()


class FakeWebWithConfigs(FakeWebApp):
    """FakeWebApp plus GET /crew-configs (the active versions)."""

    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self.crew_rows: list[dict[str, Any]] = []
        self.crew_error: Exception | None = None

    async def crew_configs(self) -> list[dict[str, Any]]:
        self.calls.append(("crew_configs", None))
        if self.crew_error:
            raise self.crew_error
        return self.crew_rows


class Runner:
    """Records kickoffs; answers like FlowRunner (or raises what it is given)."""

    def __init__(self, answer: Any = None) -> None:
        self.calls: list[tuple[str, dict[str, Any], str, str | None]] = []
        self.answer = answer

    async def kickoff(self, name: str, inputs: dict[str, Any], *, triggered_by: str, actor: str | None = None) -> dict[str, Any]:
        self.calls.append((name, inputs, triggered_by, actor))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer or {"run_id": str(uuid.uuid4()), "status": "queued", "existing": False}


# --- schedules ---------------------------------------------------------------------------------------------------------


async def test_a_due_schedule_starts_its_flow_once() -> None:
    store, runner = MemoryScheduleStore(), Runner()
    store.add(id="a", name="gsc-sync", flow_name="gsc_sync_flow", cron="10 6 * * *")
    store.add(id="b", name="report-weekly", flow_name="report_flow", cron="0 8 * * 1", inputs={"period": "weekly"})
    out = await dispatch(store, runner, schedulable=CRON_FLOWS, now=NOW)
    assert out["checked"] == 2 and [f["schedule"] for f in out["fired"]] == ["gsc-sync"]
    assert runner.calls == [("gsc_sync_flow", {}, "cron", "schedule:gsc-sync")]
    row = store.rows["a"]
    assert row["last_slot"] == "20261123T0610Z" and row["last_status"] == "started" and row["last_run_id"]
    # The next minute's call (or a retried CronJob) finds the slot taken: nothing starts twice.
    again = await dispatch(store, runner, schedulable=CRON_FLOWS, now=NOW + timedelta(minutes=1))
    assert again["fired"] == [] and len(runner.calls) == 1


async def test_missed_times_catch_up_once_and_only_inside_the_window() -> None:
    store, runner = MemoryScheduleStore(), Runner()
    store.add(id="a", name="news-dispatch", flow_name="news_dispatch_flow", cron="*/15 * * * *")
    # The agent was down from 05:20 to 06:10: of 05:30, 05:45 and 06:00 only the latest runs.
    out = await dispatch(store, runner, schedulable=CRON_FLOWS, now=datetime(2026, 11, 23, 6, 10, tzinfo=UTC))
    assert [f["slot"] for f in out["fired"]] == ["20261123T0600Z"]
    store.add(id="b", name="gsc-sync", flow_name="gsc_sync_flow", cron="10 6 * * *")
    late = await dispatch(store, runner, schedulable=CRON_FLOWS, now=NOW + timedelta(minutes=90), catchup=timedelta(minutes=60))
    assert "gsc-sync" not in [f["schedule"] for f in late["fired"]]  # 06:10 is more than an hour ago


async def test_a_new_or_edited_schedule_never_fires_a_time_that_has_passed() -> None:
    store, runner = MemoryScheduleStore(), Runner()
    store.add(id="a", name="gsc-sync", flow_name="gsc_sync_flow", cron="10 6 * * *", armed_at=NOW - timedelta(seconds=10))
    assert (await dispatch(store, runner, schedulable=CRON_FLOWS, now=NOW))["fired"] == []
    store.rows["a"]["armed_at"] = NOW - timedelta(minutes=5)
    assert len((await dispatch(store, runner, schedulable=CRON_FLOWS, now=NOW))["fired"]) == 1


async def test_disabled_broken_and_unschedulable_schedules() -> None:
    store, runner = MemoryScheduleStore(), Runner()
    store.add(id="a", name="off", flow_name="gsc_sync_flow", cron="* * * * *", enabled=False)
    store.add(id="b", name="bad-cron", flow_name="gsc_sync_flow", cron="61 * * * *")
    store.add(id="c", name="bad-zone", flow_name="gsc_sync_flow", cron="* * * * *", timezone="Mars/Olympus")
    store.add(id="d", name="publish", flow_name="publish_flow", cron="* * * * *")
    out = await dispatch(store, runner, schedulable=CRON_FLOWS, now=NOW)
    assert {e["schedule"] for e in out["errors"]} == {"bad-cron", "bad-zone"}
    assert out["fired"] == [{"schedule": "publish", "flow": "publish_flow", "slot": "20261123T0610Z", "status": "failed", "run_id": None, "error": "publish_flow cannot be scheduled"}]
    assert runner.calls == [] and store.rows["d"]["last_status"] == "failed"


async def test_a_run_still_going_or_refused_inputs_are_recorded_on_the_schedule() -> None:
    store = MemoryScheduleStore()
    store.add(id="a", name="gsc-sync", flow_name="gsc_sync_flow", cron="* * * * *")
    await dispatch(store, Runner({"run_id": "r-old", "status": "running", "existing": True}), schedulable=CRON_FLOWS, now=NOW)
    assert store.rows["a"]["last_status"] == "already_running" and store.rows["a"]["last_run_id"] == "r-old"
    await dispatch(store, Runner(RunError(422, "invalid inputs for gsc_sync_flow: extra")), schedulable=CRON_FLOWS, now=NOW + timedelta(minutes=1))
    assert store.rows["a"]["last_status"] == "failed" and "invalid inputs" in store.rows["a"]["last_error"]


def test_only_schedulable_flows_start_as_cron_and_the_test_flow_only_by_hand() -> None:
    check_kickoff("gsc_sync_flow", "cron")
    with pytest.raises(RunError) as e:
        check_kickoff("optimize_article_flow", "cron")
    assert e.value.status == 403
    for trigger in ("cron", "flow", "mcp"):
        with pytest.raises(RunError):
            check_kickoff("crew_test_flow", trigger)
    check_kickoff("crew_test_flow", "manual")
    assert "crew_test_flow" not in CRON_FLOWS


def test_the_dispatch_endpoint_and_the_trigger(web: FakeWebApp, llm: FakeLlm, monkeypatch) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    c.schedules.add(id="a", name="ask-gaps", flow_name="ask_gaps_flow", cron="10 6 * * *")
    c.clock = lambda: NOW
    with TestClient(create_app(c)) as client:
        assert client.post("/schedules/dispatch").status_code == 401
        r = client.post("/schedules/dispatch", headers=AUTH)
        assert r.status_code == 200 and r.json()["fired"][0]["status"] == "started"
        run = c.store.rows[r.json()["fired"][0]["run_id"]]
        assert run["triggered_by"] == "cron" and run["actor"] == "schedule:ask-gaps"

        class Missing(MemoryScheduleStore):
            async def enabled(self) -> list[dict[str, Any]]:
                raise SchedulesUnavailable("table seo_flow_schedules is missing")

        c.schedules = Missing()
        assert client.post("/schedules/dispatch", headers=AUTH).status_code == 503

    from app import trigger

    calls: list[str] = []

    def post(url: str, json: object = None, headers: object = None, timeout: float = 0) -> httpx.Response:
        calls.append(url)
        return httpx.Response(200, json={"fired": []}, request=httpx.Request("POST", url))

    monkeypatch.setattr(trigger.httpx, "post", post)
    assert trigger.main(["dispatch"]) == 0
    assert calls[0] == "http://seo-agent.jithendar:8080/schedules/dispatch" and calls[1].endswith("/quitquitquit")
    assert trigger.main(["dispatch", "{}"]) == 2


# --- flow catalogue and Run with parameters ----------------------------------------------------------------------------


def test_flow_catalogue_and_input_validation(web: FakeWebApp, llm: FakeLlm) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    with TestClient(create_app(c)) as client:
        items = {f["name"]: f for f in client.get("/flows", headers=AUTH).json()["items"]}
        assert set(items) == set(SPECS)
        assert items["report_flow"]["schedulable"] and items["report_flow"]["crews"] == ["report"]
        assert items["report_flow"]["inputs_schema"]["properties"]["period"]["enum"] == ["weekly", "monthly"]
        assert items["publish_flow"]["approval_only"] and not items["publish_flow"]["schedulable"]
        assert items["new_article_flow"]["crews"] == ["editorial"] and items["content_ideas_flow"]["crews"] == ["promotion"]
        ok = client.post("/flows/report_flow/validate", json={"inputs": {"period": "monthly"}}, headers=AUTH)
        assert ok.status_code == 200 and ok.json() == {"inputs": {"period": "monthly"}}
        bad = client.post("/flows/report_flow/validate", json={"inputs": {"period": "daily"}}, headers=AUTH)
        assert bad.status_code == 422 and "invalid inputs for report_flow" in bad.json()["error"]
        assert client.post("/flows/nope_flow/validate", json={"inputs": {}}, headers=AUTH).status_code == 404


# --- crew configuration ------------------------------------------------------------------------------------------------


def report() -> crew_config.CrewDef:
    return crew_config.registry()["report"]


def test_every_crew_has_a_definition_that_matches_its_code() -> None:
    reg = crew_config.registry()
    assert set(reg) == set(crew_config.CREW_IDS)
    for c in reg.values():
        assert {t.agent for t in c.tasks} <= {a.key for a in c.agents}, c.crew
        assert all(f in SPECS for f in c.replay), c.crew
        for t in c.tasks:  # the defaults pass their own validation
            assert set(crew_config.PLACEHOLDER.findall(t.instructions)) <= set(t.variables), (c.crew, t.key)
        assert len(crew_config.default_hash(c)) == 16


def test_overlay_validation_names_every_problem() -> None:
    with pytest.raises(crew_config.OverlayError) as e:
        crew_config.validate(
            crew_config.registry()["editorial"],
            {
                "agents": {"writer": {"tools": ["read_article", "gsc_queries_for_page"], "model": "claude-unknown-1"}, "ghost": {"role": "x"}},
                "tasks": {"review": {"expected_output": "anything"}, "write": {"instructions": "Write about {topic} for {kind}."}, "nope": {"instructions": "x"}},
            },
        )
    text = "\n".join(e.value.issues)
    for part in ("agents.writer.tools: not allowed for this crew: gsc_queries_for_page", "agents.writer.model: unknown model claude-unknown-1", "agents.ghost:", "tasks.review.expected_output: fixed by the code", "tasks.write.instructions: unknown placeholder {kind}, {topic}", "tasks.nope:"):
        assert part in text, part
    with pytest.raises(crew_config.OverlayError) as e2:
        crew_config.validate(report(), {"agents": {"analyst": {"max_tokens": 10, "surprise": 1}}})
    assert any("max_tokens" in i for i in e2.value.issues) and any("surprise" in i for i in e2.value.issues)


def test_normalize_keeps_only_what_differs_from_the_code() -> None:
    c = report()
    a = c.agent("analyst")
    ov = crew_config.validate(c, {"agents": {"analyst": {"role": a.role, "goal": "  " + a.goal + " ", "backstory": "Shorter.", "model": "claude-haiku-5-5"}}, "tasks": {"write": {"instructions": c.task("write").instructions}}})
    assert crew_config.normalize(c, ov) == {"agents": {"analyst": {"backstory": "Shorter.", "model": "claude-haiku-5-5"}}}
    assert crew_config.normalize(c, crew_config.validate(c, {})) == {}


def test_lenient_keeps_what_still_fits(caplog) -> None:
    kept = crew_config.lenient(report(), {"agents": {"analyst": {"backstory": "B"}, "gone": {"role": "x"}}, "tasks": {"write": {"instructions": "Use {nothing}."}}})
    assert kept == {"agents": {"analyst": {"backstory": "B"}}}
    assert crew_config.lenient(report(), "not a dict") == {}


def test_effective_applies_agents_tasks_and_placeholders() -> None:
    c = report()
    eff = crew_config.Effective(c, {"agents": {"analyst": {"role": "Writer", "model": "claude-opus-5-5", "max_iter": 2, "max_tokens": 2000}}, "tasks": {"write": {"instructions": "A {kind} note; keep {\"json\": 1} as is.", "expected_output": "Text."}}}, "version", 3)
    a = eff.agents()[0]
    assert (a.role, a.model, a.max_iter, a.max_tokens, a.goal) == ("Writer", "claude-opus-5-5", 2, 2000, c.agent("analyst").goal)
    assert eff.instructions("write", kind="monthly") == 'A monthly note; keep {"json": 1} as is.'
    assert eff.expected_output("write") == "Text." and eff.prompt_version == "seo-report-crew-v1+v3"
    assert crew_config.Effective(c, {}, "test", 4).prompt_version == "seo-report-crew-v1+test-v4"
    assert crew_config.Effective(c).prompt_version == "seo-report-crew-v1"
    fixed = crew_config.Effective(crew_config.registry()["editorial"], {"tasks": {"review": {"expected_output": "ignored"}}})
    assert "NEEDS_FACT_CHECK:" in fixed.expected_output("review")


async def test_a_crew_runs_its_active_version_and_falls_back_to_the_code(llm: FakeLlm, web: FakeWebWithConfigs) -> None:
    web.crew_rows = [{"crew": "report", "version": 7, "config": {"agents": {"analyst": {"model": "claude-opus-5-5"}}, "tasks": {"write": {"instructions": "Brief the owner on the {kind} numbers in three sentences."}}}}]
    llm.queue("report", ANSWER)
    r = await ReportCrew(settings(), llm, web, MemoryRetriever()).run(sample_report(), facts(sample_report()))
    assert r.status == "completed"
    call = llm.calls[-1]
    assert call.model == "claude-opus-5-5" and call.prompt_version == "seo-report-crew-v1+v7"
    assert "Brief the owner on the weekly numbers in three sentences." in call.user and "<data name=\"facts\">" in call.user
    # The web app cannot be reached: the code's defaults, never a failed run.
    web.crew_error = httpx.ConnectError("down")
    llm.queue("report", ANSWER)
    await ReportCrew(settings(), llm, web, MemoryRetriever()).run(sample_report(), facts(sample_report()))
    assert llm.calls[-1].prompt_version == "seo-report-crew-v1" and "Write the weekly SEO briefing in 120–250 words" in llm.calls[-1].user


def test_crew_endpoints(web: FakeWebApp, llm: FakeLlm) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    with TestClient(create_app(c)) as client:
        items = {x["crew"]: x for x in client.get("/crews", headers=AUTH).json()["items"]}
        assert set(items) == set(crew_config.CREW_IDS)
        ed = items["editorial"]
        assert [t["key"] for t in ed["tasks"]] == ["research", "write", "revise", "review", "seo"]
        assert ed["replay_flows"] == ["new_article_flow"] and "fetch_allowlisted_docs" in ed["tools"] and "claude-haiku-5-5" in ed["models"]
        assert next(t for t in ed["tasks"] if t["key"] == "review")["output_editable"] is False
        ok = client.post("/crews/report/validate", json={"config": {"agents": {"analyst": {"backstory": "Short."}}}}, headers=AUTH)
        assert ok.status_code == 200 and ok.json()["config"] == {"agents": {"analyst": {"backstory": "Short."}}} and ok.json()["default_hash"] == items["report"]["default_hash"]
        bad = client.post("/crews/report/validate", json={"config": {"tasks": {"write": {"instructions": "{x}"}}}}, headers=AUTH)
        assert bad.status_code == 422 and bad.json()["issues"][0].startswith("tasks.write.instructions")
        assert client.post("/crews/nope/validate", json={"config": {}}, headers=AUTH).status_code == 404


# --- crew test runs (Replay) -------------------------------------------------------------------------------------------


async def source_report_run(c: Any) -> str:
    rid = str(uuid.uuid4())
    await c.store.create({"run_id": rid, "flow_name": "report_flow", "target_id": "weekly", "status": "succeeded", "inputs": {"period": "weekly"}, "triggered_by": "cron"})
    c.store.rows[rid]["state_json"] = {"id": rid, "period": "weekly", "numbers": sample_report()}
    return rid


async def test_a_test_run_replays_the_crew_with_the_edited_prompts_and_saves_nothing(llm: FakeLlm, web: FakeWebWithConfigs) -> None:
    c = memory_container(settings(), llm=llm, web=web, history=True)
    web.crew_rows = [{"crew": "report", "version": 2, "config": {"tasks": {"write": {"instructions": "ACTIVE VERSION {kind}"}}}}]
    src = await source_report_run(c)
    llm.queue("report", ANSWER)
    edited = {"tasks": {"write": {"instructions": "Edited: the {kind} briefing in two sentences."}}}
    r = await c.runner.kickoff("crew_test_flow", {"crew": "report", "source_run_id": src, "config": edited, "version": 3}, triggered_by="manual", actor="admin@example.com")
    run = await c.runner.wait(r["run_id"], 30)
    assert run["status"] == "succeeded", run.get("error")
    st = run["state_json"]
    assert st["outcome"] == "done" and st["result"]["narrative"] == "Clicks rose 14.1% to 665." and st["result"]["check"]["ok"]
    assert st["crew_config"] == {"crew": "report", "source": "test", "version": 3, "prompt_version": "seo-report-crew-v1+test-v3"}
    assert st["source"]["flow"] == "report_flow" and run["outputs"]["result"]["narrative"]
    call = llm.calls[-1]
    assert "Edited: the weekly briefing in two sentences." in call.user and "ACTIVE VERSION" not in call.user
    assert call.prompt_version == "seo-report-crew-v1+test-v3" and call.run_id == r["run_id"]
    assert not [x for x in web.calls if x[0] not in ("crew_configs", "agent_skills", "run_history_settings")]  # nothing saved
    await c.history.flush()
    steps = [s["step"] for s in c.history.sink.steps if s.get("run_id") == r["run_id"]]
    assert steps == ["load_source", "crew_report"], steps
    # The override is gone after the run: the next ordinary crew run uses the active version again.
    llm.queue("report", ANSWER)
    await ReportCrew(settings(), llm, web, MemoryRetriever()).run(sample_report(), facts(sample_report()))
    assert "ACTIVE VERSION weekly" in llm.calls[-1].user


async def test_a_test_run_refuses_a_bad_config_a_wrong_source_and_other_triggers(llm: FakeLlm, web: FakeWebApp) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    src = await source_report_run(c)
    with pytest.raises(RunError) as e:
        await c.runner.kickoff("crew_test_flow", {"crew": "report", "source_run_id": src, "config": {"agents": {"analyst": {"tools": ["fetch_allowlisted_docs"]}}}})
    assert e.value.status == 422 and "not allowed for this crew" in str(e.value)
    with pytest.raises(RunError) as e:
        await c.runner.kickoff("crew_test_flow", {"crew": "report", "source_run_id": src}, triggered_by="mcp")
    assert e.value.status == 403
    r = await c.runner.kickoff("crew_test_flow", {"crew": "editorial", "source_run_id": src}, triggered_by="manual")
    run = await c.runner.wait(r["run_id"], 30)
    assert run["status"] == "failed" and "cannot be replayed by the editorial crew" in run["error"]
    r = await c.runner.kickoff("crew_test_flow", {"crew": "report", "source_run_id": str(uuid.uuid4())}, triggered_by="manual")
    run = await c.runner.wait(r["run_id"], 30)
    assert run["status"] == "failed" and "not found" in run["error"]


async def test_one_test_run_per_crew_at_a_time(llm: FakeLlm, web: FakeWebApp) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    src = await source_report_run(c)
    first = await c.runner.kickoff("crew_test_flow", {"crew": "report", "source_run_id": src}, triggered_by="manual")
    second = await c.runner.kickoff("crew_test_flow", {"crew": "report", "source_run_id": src}, triggered_by="manual")
    assert second["existing"] and second["run_id"] == first["run_id"]
    other = await c.runner.kickoff("crew_test_flow", {"crew": "news", "source_run_id": src}, triggered_by="manual")
    assert not other["existing"]  # another crew's test runs alongside
    for r in (first, other):
        await c.runner.cancel(r["run_id"])


# --- the dispatcher's SQL on a real PostgreSQL -------------------------------------------------------------------------


async def test_pg_schedule_store_claims_each_slot_once() -> None:
    """PgScheduleStore against moks-cms migration 0037 (needs SEO_AGENT_TEST_DATABASE_URL and a moks-cms checkout)."""
    import os

    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    from app.schedules import PgScheduleStore
    from tests.moks_cms import www

    url = os.environ.get("SEO_AGENT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("set SEO_AGENT_TEST_DATABASE_URL to run the schedules SQL on a real PostgreSQL")
    migration = www("src/db/migrations/0037_crewai_schedules_crews.sql").read_text()
    schema = f"sched_{uuid.uuid4().hex[:8]}"
    pool = AsyncConnectionPool(url, min_size=1, max_size=2, open=False, kwargs={"autocommit": True, "row_factory": dict_row, "options": f"-c search_path={schema}"})
    await pool.open()
    try:
        async with pool.connection() as c:
            await c.execute(f"create schema {schema}")
            for stmt in migration.split("--> statement-breakpoint"):
                if stmt.strip():
                    await c.execute(stmt)
            await c.execute("update seo_flow_schedules set armed_at = now() - interval '2 days'")
        store = PgScheduleStore(pool)
        rows = await store.enabled()
        assert len(rows) == 15 and {r["flow_name"] for r in rows} == CRON_FLOWS
        runner = Runner()
        now = datetime.now(UTC).replace(hour=6, minute=10, second=5, microsecond=0)
        out = await dispatch(store, runner, schedulable=CRON_FLOWS, now=now)
        fired = {f["schedule"] for f in out["fired"]}
        assert "gsc-sync" in fired and all(f["status"] == "started" for f in out["fired"])
        again = await dispatch(store, runner, schedulable=CRON_FLOWS, now=now + timedelta(seconds=30))
        assert again["fired"] == []  # the same minute's slots are taken
        async with pool.connection() as c:
            row = await (await c.execute("select last_slot, last_status, last_run_id::text as run, last_error from seo_flow_schedules where name = 'gsc-sync'")).fetchone()
        assert row["last_slot"] == now.strftime("%Y%m%dT%H%MZ") and row["last_status"] == "started" and row["run"] and row["last_error"] is None
        gsc = next(str(r["id"]) for r in rows if r["name"] == "gsc-sync")
        assert not await store.claim(gsc, "19990101T0000Z")  # never an older slot than the last one
        await store.record(gsc, "other-slot", "failed", None, "x")  # a record for another slot changes nothing
        async with pool.connection() as c:
            assert (await (await c.execute("select last_status from seo_flow_schedules where name = 'gsc-sync'")).fetchone())["last_status"] == "started"
    finally:
        async with pool.connection() as c:
            await c.execute(f"drop schema {schema} cascade")
        await pool.close()
