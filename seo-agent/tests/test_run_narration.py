"""Run logs a person can read (app/narrate.py and every flow's lines): the admin run page shows what a flow did, with
what, and where, in words; content and Search Console data stay in run-only fields, never in stderr → Loki."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app import narrate
from app.crews.optimization import OptimizationResult
from app.flows.jobs import job_result
from app.flows.ml import describe
from app.logs import JsonFormatter
from app.main import memory_container
from app.run_history import MemoryHistorySink, install, uninstall
from app.runs import CURRENT_RUN_ID
from app.webapp import HttpWebApp
from tests.conftest import ARTICLE, DRAFT, FakeOptimizationCrew, FakeWebApp, fact_flag, good_changeset, settings


@pytest.fixture(autouse=True)
def info_level() -> Any:
    root = logging.getLogger()
    before = root.level
    root.setLevel(logging.INFO)
    yield
    root.setLevel(before)


async def run_logged(c: Any, name: str, inputs: dict[str, Any], trigger: str = "manual") -> tuple[dict[str, Any], list[dict[str, Any]]]:
    install(c.history)
    try:
        r = await c.runner.kickoff(name, inputs, triggered_by=trigger)
        done = await c.runner.wait(r["run_id"], 30)
        await c.history.flush()
    finally:
        uninstall()
    sink: MemoryHistorySink = c.history.sink
    return done, [ln for ln in sink.logs if ln["run_id"] == str(done["run_id"]) and ln["level"] != "debug"]


def said(lines: list[dict[str, Any]], step: str | None = "*") -> list[str]:
    return [ln["message"] for ln in lines if step == "*" or ln["step"] == step]


# --- wording helpers -------------------------------------------------------------------------------------------------


def test_narrate_words() -> None:
    assert narrate.count(1, "document") == "1 document" and narrate.count(1234, "query", "queries") == "1,234 queries"
    assert narrate.label("performance_rows") == "performance rows" and narrate.label("errorCode") == "error code"
    assert narrate.seconds(4.21) == "4.2 s" and narrate.seconds(515) == "8m 35s"
    d = {"documents": 96, "full": True, "status": "synced", "title": "Some article text", "draft_id": str(uuid.uuid4()), "items": [1, 2], "by_type": {"gsc_performance": 39}}
    # numbers, yes/no and states; never free text or ids
    assert narrate.facts(d) == "documents 96, full yes, status synced, items 2 items, by type (gsc performance 39)"
    assert narrate.facts({"models": ["decay", "intent"], "extra": [], "queries": ["how to renew a cert"]}) == "models decay, intent, queries 1 item"
    assert narrate.shape([1, 2, 3]) == "3 items" and narrate.shape({"status": "succeeded", "rows": 1234}) == "status succeeded, rows 1,234"


def test_job_and_model_results_in_words() -> None:
    assert job_result("gsc_sync", {"status": "succeeded", "rows": 1234, "window": {"start": "2026-10-29", "end": "2026-11-25"}}) == "gsc_sync succeeded: 1,234 rows written for 2026-10-29 to 2026-11-25"
    assert job_result("gsc_sync", {"status": "skipped", "rows": 0, "skipped": "slot already ran", "previousStatus": "succeeded"}) == "gsc_sync skipped (slot already ran; that run succeeded)"
    assert job_result("ga4_sync", {"status": "failed", "rows": 0, "error": "token expired", "errorCode": "auth"}) == "ga4_sync failed: 0 rows written. Error (auth): token expired"
    r = {"queries": 221, "clusters": 45, "register": {"kind": "query_clusters", "version": 7, "run_status": "activated"}}
    assert describe("query_clusters", r) == "query_clusters (search queries that mean the same thing): queries 221, clusters 45; new version v7 activated: the web app uses it from now on"
    assert describe("rag_eval", {"skipped": "vector index unavailable"}).endswith(": skipped vector index unavailable")


# --- whole runs ----------------------------------------------------------------------------------------------------


async def test_a_job_run_says_what_it_asked_for_and_what_came_back(llm: Any, web: FakeWebApp) -> None:
    c = memory_container(settings(), llm=llm, web=web, history=True)
    done, lines = await run_logged(c, "gsc_sync_flow", {})
    assert done["status"] == "succeeded"
    text = said(lines)
    assert text[0] == "Started gsc_sync_flow (started by hand)"
    assert "Asking the web app to run the Search Console sync (clicks, impressions and positions per page and query, into seo_gsc_* tables), started by hand" in text
    assert "gsc_sync succeeded: 42 rows written" in text
    assert "run_job succeeded" in text and text[-1] == "Finished: succeeded, outcome done"


async def test_an_optimize_run_reads_as_a_story(llm: Any, web: FakeWebApp) -> None:
    crew = FakeOptimizationCrew([OptimizationResult(problem_statement="CTR gap", change_set=good_changeset(), needs_fact_check=[fact_flag()])])
    c = memory_container(settings(), llm=llm, web=web, history=True, optimization_crew=lambda: crew)
    done, lines = await run_logged(c, "optimize_article_flow", {"article_id": ARTICLE, "draft_id": DRAFT, "recommendation_ids": ["r1"]})
    assert done["outputs"]["outcome"] == "draft_ready"
    text = " | ".join(said(lines))
    for part in ("open recommendation", "Plan: the optimization crew drafts changes for 1 recommendation (low_ctr)", "Attempt 1 of 2: the optimization crew", "Change set: ", "1 claim to fact-check", "Validation passed", f"Saved for review: draft {DRAFT}"):
        assert part in text, part
    assert [ln["step"] for ln in lines if ln["message"].startswith("Plan:")] == ["analyze"]


async def test_failed_steps_and_runs_are_warnings_that_say_why(llm: Any, web: FakeWebApp) -> None:
    web.validate_errors = [["bad 1"], ["bad 2"]]
    c = memory_container(settings(), llm=llm, web=web, history=True, optimization_crew=lambda: FakeOptimizationCrew())
    done, lines = await run_logged(c, "optimize_article_flow", {"article_id": ARTICLE, "draft_id": DRAFT, "recommendation_ids": ["r1"]})
    assert done["outputs"]["outcome"] == "generation_failed"
    warn = [ln["message"] for ln in lines if ln["level"] == "warning"]
    assert "Validation: 1 error (bad 1). Trying once more with these errors" in warn
    assert any(m.startswith("Gave up after 2 attempts: Validation failed: bad 2") for m in warn)
    assert said(lines)[-1].startswith("Finished: failed, outcome generation_failed")


# --- calls to the web app ------------------------------------------------------------------------------------------


async def test_web_app_calls_are_info_in_a_run_and_debug_outside(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="seo_agent.webapp")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/jobs/run"):
            return httpx.Response(200, json={"id": "j1", "status": "succeeded", "rows": 1234, "title": "never in a line"})
        if request.url.path.endswith("/run-history/settings"):
            return httpx.Response(200, json={"logs": True})
        return httpx.Response(404, json={"error": "no such draft", "code": "not_found"})

    web = HttpWebApp("http://web", "t" * 40, transport=httpx.MockTransport(handler))
    token = CURRENT_RUN_ID.set(str(uuid.uuid4()))
    try:
        await web.run_job("gsc_sync", None, "manual")
        await web.run_history_settings()
        with pytest.raises(Exception):  # noqa: B017 - WebAppError
            await web.draft_summary("missing")
    finally:
        CURRENT_RUN_ID.reset(token)
    await web.run_job("gsc_sync", None, "manual")  # outside a run (an MCP tool, the API)
    lines = [(r.levelno, r.getMessage()) for r in caplog.records if r.name == "seo_agent.webapp"]
    assert lines == [
        (logging.INFO, "web app POST /jobs/run: status succeeded, rows 1,234"),
        (logging.WARNING, "web app GET /drafts/missing: 404 not_found: no such draft"),
        (logging.DEBUG, "web app POST /jobs/run: status succeeded, rows 1,234"),
    ]
    await web.close()


# --- crews ---------------------------------------------------------------------------------------------------------


def test_crew_task_lines_say_who_did_what_and_keep_the_text_out_of_stderr(caplog: pytest.LogCaptureFixture) -> None:
    from app.crews.common import CrewRun, _TaskWatch

    caplog.set_level(logging.INFO, logger="seo_agent.crews")

    def task(agent: str) -> Any:
        return SimpleNamespace(agent=SimpleNamespace(llm=SimpleNamespace(_agent=agent)), description="Analyse ARTICLE TEXT", expected_output="A list of findings", callback=None)

    watch = _TaskWatch("optimization", CrewRun(max_tokens=10_000, run_id=None, crew="optimization"), [task("analyst"), task("editor")])
    watch.start()
    watch.tasks[0].callback(SimpleNamespace(raw="FINDINGS " * 10))
    watch.close_unfinished("wall-clock limit 600s reached")
    msgs = [r.getMessage() for r in caplog.records]
    assert msgs == [
        "optimization crew, task 1 of 2: analyst started",
        "optimization crew, task 1 of 2: analyst finished, answer 90 characters",
        "optimization crew, task 2 of 2: editor started",
        "optimization crew, task 2 of 2: editor stopped: wall-clock limit 600s reached",
    ]
    stderr = " ".join(JsonFormatter().format(r) for r in caplog.records)
    assert "ARTICLE TEXT" not in stderr and "FINDINGS" not in stderr and "A list of findings" not in stderr


async def test_a_crew_tool_call_says_what_came_back() -> None:
    from app.crews.common import CrewRun, tool_class
    from app.tools import ToolSpec

    async def fn(_q: str) -> str:
        return "x" * 1234

    loop = asyncio.get_running_loop()
    tool = tool_class()(name="gsc_queries_for_topic", description="d").bind(ToolSpec("gsc_queries_for_topic", "d", fn), loop, CrewRun(max_tokens=1000, run_id=None, crew="editorial"))
    records: list[logging.LogRecord] = []
    h = logging.Handler()
    h.emit = records.append  # type: ignore[method-assign]
    logging.getLogger("seo_agent.crews").addHandler(h)
    try:
        await asyncio.to_thread(tool._run, "kubernetes ingress")
    finally:
        logging.getLogger("seo_agent.crews").removeHandler(h)
    (r,) = [r for r in records if getattr(r, "event", "") == "crew_tool_call"]
    assert r.getMessage() == "editorial crew used gsc_queries_for_topic: 1,234 characters back"
    assert "kubernetes ingress" not in json.dumps(json.loads(JsonFormatter().format(r)))  # the input stays in the run's log


# --- content flows -------------------------------------------------------------------------------------------------


async def test_a_content_flow_run_has_a_step_and_counted_lines(llm: Any) -> None:
    from tests.news_fixtures import JOB, NOW, FakeNewsCrew, NewsWeb, seed
    from tests.test_news_flows import SAFE, story_embed

    llm.queue("news.vision", SAFE)
    c = memory_container(settings(), llm=llm, web=NewsWeb(), history=True)
    store = c.deps.extra["news_store"]
    store.clock = c.deps.extra["clock"] = lambda: NOW
    c.deps.extra.update(env={"NEWS_DESK_ENABLED": "true"}, news_crew=lambda _llm: FakeNewsCrew(), news_embed=story_embed())
    seed(store, image_provider="template")
    done, lines = await run_logged(c, "news_job_flow", {"job_id": JOB})
    assert done["status"] == "succeeded"
    assert {ln["step"] for ln in lines} - {None} == {"run_job"}  # the run page groups the content flow's lines in its step
    text = said(lines)
    assert "fetch: fetching new items from the content flow's enabled sources" in text
    assert any(m.startswith("fetch: succeeded in") and m.endswith("2 items out (sources 3)") for m in text), text
    assert "selected 1 of 1: “Kubernetes 1.35 released with stable in-place pod resize” (score 0.67)" in text
