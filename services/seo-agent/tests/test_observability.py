"""CrewAI observability (docs/seo/OPERATIONS.md "Observability"): spans per flow run, crew, task and tool call; log lines
that carry the trace and run ids; seo_crew_* metrics; traceparent on calls to the web app. Real CrewAI, scripted model."""

from __future__ import annotations

import json
import logging

import httpx
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app import metrics
from app.llm import BudgetGuard, FakeLlm, MemorySpendStore
from app.logs import JsonFormatter
from app.main import memory_container
from app.tracing import span
from app.webapp import HttpWebApp
from tests.conftest import ARTICLE, DRAFT, FakeWebApp, settings
from tests.test_crews import BRIEF, DOC_URL, crew_with, final_json, scripted

EXPORTER = InMemorySpanExporter()


@pytest.fixture(autouse=True)
def spans():
    if not isinstance(trace.get_tracer_provider(), TracerProvider):
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(EXPORTER))
        trace.set_tracer_provider(provider)
    EXPORTER.clear()
    yield EXPORTER
    EXPORTER.clear()


def by_name(exporter: InMemorySpanExporter) -> dict[str, list]:
    out: dict[str, list] = {}
    for s in exporter.get_finished_spans():
        out.setdefault(s.name, []).append(s)
    return out


def sample(name: str, **labels: str) -> float:
    return metrics.REGISTRY.get_sample_value(name, labels) or 0.0


async def test_crew_task_and_tool_spans_nest_under_the_crew(llm: FakeLlm, web: FakeWebApp, spans, caplog) -> None:
    web.docs[DOC_URL] = "<p>An Ingress gives Services externally-reachable URLs.</p>"
    llm.queue("crew", *scripted(final_json([DOC_URL]), with_tool=True))
    tools_before = sample("seo_crew_tool_calls_total", crew="editorial", tool="fetch_allowlisted_docs", status="ok")
    caplog.set_level(logging.INFO)

    r = await crew_with(llm, web).run(BRIEF)
    assert r.status == "completed"

    s = by_name(spans)
    crew = s["crew.editorial"][0]
    assert crew.attributes["crew.status"] == "completed" and crew.attributes["crew.tasks_done"] == 4 and crew.attributes["crew.tool_calls"] == 1
    assert crew.attributes["crew.tokens"] > 0
    tasks = [n for n in s if n.startswith("crew.editorial.task.")]
    assert sorted(tasks) == ["crew.editorial.task.researcher", "crew.editorial.task.reviewer", "crew.editorial.task.seo_editor", "crew.editorial.task.writer"]
    tool = s["tool.fetch_allowlisted_docs"][0]
    for child in [tool, *(s[n][0] for n in tasks), s["crew.editorial.researcher"][0]]:
        assert child.context.trace_id == crew.context.trace_id and child.parent.span_id == crew.context.span_id, child.name
    assert tool.attributes["tool.output_chars"] > 0 and tool.status.is_ok

    events = [rec.__dict__.get("event") for rec in caplog.records]
    assert events.count("crew_task") == 4 and events.count("crew_tool_call") == 1 and events.count("crew_finished") == 1
    finished = next(rec for rec in caplog.records if rec.__dict__.get("event") == "crew_finished")
    assert finished.status == "completed" and finished.tasks_done == 4 and finished.tool_calls == 1
    assert sample("seo_crew_tool_calls_total", crew="editorial", tool="fetch_allowlisted_docs", status="ok") == tools_before + 1
    assert sample("seo_crew_task_duration_seconds_count", crew="editorial", agent="writer") >= 1


async def test_a_stopped_crew_marks_its_running_task_failed(web: FakeWebApp, spans) -> None:
    llm = FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1), tokens=(1500, 500))  # 2,000 tokens per call
    llm.queue("crew", *scripted(final_json([])))
    r = await crew_with(llm, web, crew_max_tokens_per_run=3000).run(BRIEF)
    assert r.status == "incomplete"
    s = by_name(spans)
    crew = s["crew.editorial"][0]
    assert crew.attributes["crew.status"] == "incomplete" and not crew.status.is_ok and "token cap" in crew.attributes["crew.reason"]
    done = [n for n in s if n.startswith("crew.editorial.task.")]
    failed = [x for n in done for x in s[n] if not x.status.is_ok]
    assert len(failed) == 1 and crew.attributes["crew.tasks_done"] == len(done) - 1


async def test_a_flow_run_is_one_trace_with_its_result_on_the_root(llm, web, spans, caplog) -> None:
    from tests.conftest import FakeOptimizationCrew

    caplog.set_level(logging.INFO)
    c = memory_container(settings(), llm=llm, web=web, optimization_crew=lambda: FakeOptimizationCrew())
    r = await c.runner.kickoff("optimize_article_flow", {"article_id": ARTICLE, "draft_id": DRAFT})
    await c.runner.wait(r["run_id"], 10)
    s = by_name(spans)
    root = s["flow.optimize_article_flow"][0]
    assert root.attributes["run_id"] == r["run_id"] and root.attributes["flow.status"] == "succeeded" and root.attributes["flow.outcome"] == "draft_ready"
    steps = [x for n, xs in s.items() if n.startswith("flow.optimize_article_flow.") for x in xs]
    assert steps and all(x.parent.span_id == root.context.span_id for x in steps)
    events = {rec.__dict__.get("event") for rec in caplog.records}
    assert {"flow_started", "flow_step", "flow_finished"} <= events


def test_log_lines_carry_trace_and_run_ids() -> None:
    from app.runs import CURRENT_RUN_ID

    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "hello", None, None)
    assert "trace_id" not in json.loads(JsonFormatter().format(rec))
    token = CURRENT_RUN_ID.set("run-1")
    try:
        with span("unit") as s:
            out = json.loads(JsonFormatter().format(rec))
        assert out["trace_id"] == format(s.get_span_context().trace_id, "032x") and out["run_id"] == "run-1" and len(out["span_id"]) == 16
        rec.run_id = "explicit"  # a crew thread passes its run id with extra=
        assert json.loads(JsonFormatter().format(rec))["run_id"] == "explicit"
    finally:
        CURRENT_RUN_ID.reset(token)


async def test_calls_to_the_web_app_carry_traceparent() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"articles": []})

    web = HttpWebApp("http://web", "c" * 40, transport=httpx.MockTransport(handler))
    with span("flow.x") as s:
        await web.published_articles()
    tp = seen[0].headers["traceparent"]
    assert tp.split("-")[1] == format(s.get_span_context().trace_id, "032x")
    assert seen[0].headers["authorization"] == f"Bearer {'c' * 40}"
