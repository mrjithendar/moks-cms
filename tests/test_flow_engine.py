"""The unified flow engine (2026-11-24): any crew in a step, flow steps, needs, conditions, retries, timeouts, failure
handling and fallbacks; flows switched off in the admin; the catalogue's metadata; redaction of what a run records."""

from __future__ import annotations

import asyncio
import copy
import logging
from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient

from app.crews import custom as cc
from app.flows import FLOW_INFO, SPECS, catalogue
from app.flows import custom as cf
from app.flows.switches import FlowSwitches
from app.logs import JsonFormatter
from app.main import create_app, memory_container
from app.redaction import MASK, metadata, redact, redact_text
from app.runs import RunError
from tests.conftest import FakeWebApp, settings
from tests.test_console import AUTH
from tests.test_custom_builder import CREW

FLOW: dict[str, Any] = {"key": "pipeline", "label": "Pipeline", "inputs": ["topic"], "steps": []}


def flow(*steps: dict[str, Any], inputs: list[str] | None = None) -> dict[str, Any]:
    f = copy.deepcopy(FLOW)
    f["steps"] = list(steps)
    if inputs is not None:
        f["inputs"] = inputs
    return f


def crew_step(save_as: str = "out", **kw: Any) -> dict[str, Any]:
    return {"kind": "crew", "crew": "explainer", "inputs": {"topic": "{input.topic}"}, "save_as": save_as, **kw}


class Outcome:
    def __init__(self, text: str, status: str = "completed") -> None:
        self.output, self.status, self.tokens, self.cost_usd, self.reason = text, status, 10, 0.0001, None


class Crews:
    """A fake crew runner: answers from a script, one item per call (an Exception item raises)."""

    def __init__(self, script: list[Any] | None = None) -> None:
        self.script = list(script or [])
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, spec: Any, inputs: dict[str, str], **kw: Any) -> Outcome:
        self.calls.append({"crew": spec.key, "inputs": dict(inputs), "version": kw.get("version"), "tools": [a.tools for a in spec.agents]})
        item = self.script.pop(0) if self.script else f"Notes on {inputs.get('topic', '')} long enough to pass."
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, Outcome):
            return item
        return Outcome(str(item))


@pytest.fixture
def crews(monkeypatch: pytest.MonkeyPatch) -> Crews:
    fake = Crews()
    monkeypatch.setattr(cf, "run_custom_crew", fake)
    return fake


class SwitchWeb(FakeWebApp):
    off: list[dict[str, Any]] | None = None
    fail: bool = False

    async def flow_switches(self) -> dict[str, Any]:
        if self.fail:
            raise ConnectionError("web app down")
        return {"disabled": list(self.off or [])}


def container(spec: dict[str, Any], *, history: bool = False, web: FakeWebApp | None = None) -> tuple[Any, FakeWebApp]:
    w = web or FakeWebApp()
    w.custom_crew_rows = [{"key": "explainer", "version": 3, "spec": CREW}]
    w.custom_flow_rows = [{"key": spec["key"], "version": 7, "spec": spec}]
    return memory_container(settings(), llm=None, web=w, history=history), w


async def go(c: Any, inputs: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    r = await c.runner.kickoff("custom_flow", {"flow": "pipeline", "inputs": inputs or {"topic": "kubelet"}, **kw}, triggered_by="manual")
    return await c.runner.wait(r["run_id"], 30)


def outcomes(fr: dict[str, Any]) -> list[tuple[str, str]]:
    return [(s["id"], s["outcome"]) for s in fr["state_json"]["steps"]]


# --- the spec ----------------------------------------------------------------------------------------------------------


def test_a_v2_spec_validates_ids_needs_fallbacks_and_flow_steps() -> None:
    ok = flow(crew_step("first", on_failure="fallback", fallback="second"), crew_step("second"), {"kind": "flow", "flow": "gsc_sync_flow", "needs": ["first"], "save_as": "sync"}, crew_step("third", inputs={"topic": "{steps.sync}"}))
    assert [cf.step_id(s, n) for n, s in enumerate(cf.validate_flow(ok, {"explainer"}).steps, 1)] == ["first", "second", "sync", "third"]
    for why, spec in (
        ("needs a later step", flow(crew_step("first", needs=["second"]), crew_step("second"))),
        ("fallback before it", flow(crew_step("first"), crew_step("second", on_failure="fallback", fallback="first"))),
        ("fallback without on_failure", flow(crew_step("first", fallback="second"), crew_step("second"))),
        ("two steps with one id", flow(crew_step("first"), {"kind": "condition", "id": "first", "value": "{steps.first}", "op": "not_empty"})),
        ("the approval-only flow", flow({"kind": "flow", "flow": "publish_flow", "inputs": {"draft_id": "x"}})),
        ("the console's test run", flow({"kind": "flow", "flow": "crew_test_flow"})),
        ("a step flow inside a step flow", flow({"kind": "flow", "flow": "custom_flow"})),
        ("an unknown flow", flow({"kind": "flow", "flow": "nothing_here_flow"})),
        ("too many retries", flow(crew_step(retry={"attempts": 9}))),
        ("no crew and no flow step", flow({"kind": "condition", "value": "{input.topic}", "op": "not_empty"})),
    ):
        with pytest.raises(cc.SpecError):
            cf.validate_flow(spec, {"explainer"})
        assert why


def test_crews_defined_in_code_are_always_known_to_a_step() -> None:
    cf.validate_flow(flow({"kind": "crew", "crew": "report", "inputs": {"kind": "weekly"}, "save_as": "brief"}), set())
    with pytest.raises(cc.SpecError) as e:
        cf.validate_flow(flow(crew_step()), set())
    assert "no crew explainer" in e.value.issues[0]


def test_crew_inputs_take_a_schema_and_old_specs_still_load() -> None:
    spec = cc.validate_crew({**CREW, "inputs": [{"name": "topic", "required": True, "description": "What to explain"}], "output": {"format": "json", "required_keys": ["title"]}})
    assert spec.input_names == ["topic"] and spec.inputs[0].required
    assert cc.validate_crew(CREW).inputs[0].name == "topic"  # ["topic"], as saved before
    assert cc.missing_inputs(spec, {"topic": " "}) == ["topic"]
    assert cc.check_output(spec, '```json\n{"title": "x"}\n```') is None
    assert "lacks title" in str(cc.check_output(spec, '{"other": 1}'))
    assert "not JSON" in str(cc.check_output(spec, "plain words"))


def test_every_code_crew_can_be_materialized_as_a_spec() -> None:
    from app.crews.config import Effective, registry

    for key, crew in registry().items():
        spec = cc.validate_crew(cc.materialize(Effective(crew), key=f"{key}_copy"))
        assert spec.agents and spec.tasks
        assert all(t in cc.CUSTOM_TOOLS for a in spec.agents for t in a.tools)
    with pytest.raises(cc.SpecError):
        cc.validate_crew(cc.materialize(Effective(registry()["report"])))  # its own key is a code crew's
    assert cc.validate_crew(cc.materialize(Effective(registry()["report"])), code_crew=True).key == "report"


# --- the engine --------------------------------------------------------------------------------------------------------


async def test_a_failing_step_is_retried_and_each_attempt_is_recorded(crews: Crews) -> None:
    crews.script = [ConnectionError("model overloaded"), "Second time lucky, long enough."]
    c, _ = container(flow(crew_step(retry={"attempts": 2, "delay_seconds": 1, "backoff": 2})), history=True)
    fr = await go(c)
    assert fr["status"] == "succeeded" and len(crews.calls) == 2
    step = next(s for s in c.history.sink.steps if s["step"] == "1-crew")
    assert [a["status"] for a in step["detail"]["attempts"]] == ["failed", "succeeded"]
    assert step["detail"]["crew"] == "explainer" and step["detail"]["crew_version"] == 3 and step["detail"]["flow_version"] == 7
    assert "model overloaded" in step["detail"]["attempts"][0]["error"]


async def test_stop_fails_the_flow_and_continue_carries_on_without_the_steps_that_need_it(crews: Crews) -> None:
    crews.script = [RuntimeError("boom")]
    c, _ = container(flow(crew_step("first")))
    fr = await go(c)
    assert fr["status"] == "failed" and "step first failed" in str(fr["error"])
    crews.script = [RuntimeError("boom")]
    c2, _ = container(flow(crew_step("first", on_failure="continue"), crew_step("second", needs=["first"]), crew_step("third")))
    fr2 = await go(c2)
    assert fr2["status"] == "succeeded" and fr2["outputs"]["outcome"] == "partial"
    assert outcomes(fr2) == [("first", "failed"), ("second", "skipped"), ("third", "completed")]
    assert "needs first failed" in fr2["state_json"]["steps"][1]["reason"]


async def test_a_fallback_runs_only_when_the_step_it_backs_fails(crews: Crews) -> None:
    spec = flow(crew_step("first", on_failure="fallback", fallback="second"), crew_step("second"), crew_step("third"))
    c, _ = container(spec)
    assert outcomes(await go(c)) == [("first", "completed"), ("second", "skipped"), ("third", "completed")]
    crews.script = [RuntimeError("down")]
    c2, _ = container(spec)
    assert outcomes(await go(c2)) == [("first", "failed"), ("second", "completed"), ("third", "completed")]


async def test_when_skips_a_step_and_records_the_evaluation(crews: Crews) -> None:
    spec = flow(crew_step("first"), crew_step("second", when={"value": "{steps.first}", "op": "contains", "operand": "nowhere"}), crew_step("third", when={"value": "{input.topic}", "op": "equals", "operand": "KUBELET"}))
    c, _ = container(spec, history=True)
    fr = await go(c)
    assert outcomes(fr) == [("first", "completed"), ("second", "skipped"), ("third", "completed")]
    when = next(s for s in c.history.sink.steps if s["step"] == "2-crew")["detail"]["when"]
    assert when["held"] is False and when["op"] == "contains"


async def test_a_step_that_runs_out_of_time_fails(crews: Crews, monkeypatch: pytest.MonkeyPatch) -> None:
    async def slow(*_a: Any, **_k: Any) -> Outcome:
        await asyncio.sleep(10)
        return Outcome("late")

    monkeypatch.setattr(cf, "run_custom_crew", slow)
    monkeypatch.setattr(cf, "_timeout", lambda aw, _t: asyncio.wait_for(aw, 0.05))
    c, _ = container(flow(crew_step(timeout_seconds=5)))
    fr = await go(c)
    assert fr["status"] == "failed" and "timed out after 5 s" in str(fr["error"])


async def test_an_output_that_does_not_fit_the_schema_fails_and_is_retried(crews: Crews) -> None:
    schema = {**CREW, "output": {"format": "json", "required_keys": ["title"]}}
    crews.script = ["not json at all", '{"title": "ok"}']
    c, web = container(flow(crew_step(retry={"attempts": 1})))
    web.custom_crew_rows = [{"key": "explainer", "version": 3, "spec": schema}]
    fr = await go(c)
    assert fr["status"] == "succeeded" and len(crews.calls) == 2


async def test_required_inputs_and_defaults(crews: Crews) -> None:
    schema = {**CREW, "inputs": [{"name": "topic", "required": True}, {"name": "audience", "default": "engineers"}]}
    c, web = container(flow({"kind": "crew", "crew": "explainer", "inputs": {"topic": "{input.topic}"}, "save_as": "out"}))
    web.custom_crew_rows = [{"key": "explainer", "version": 1, "spec": schema}]
    fr = await go(c)
    assert crews.calls[0]["inputs"] == {"audience": "engineers", "topic": "kubelet"} and fr["status"] == "succeeded"
    c2, web2 = container(flow({"kind": "crew", "crew": "explainer", "inputs": {"topic": "{input.topic}"}, "save_as": "out"}))
    web2.custom_crew_rows = [{"key": "explainer", "version": 1, "spec": schema}]
    fr2 = await go(c2, {"topic": ""})
    assert fr2["status"] == "failed" and "required input(s) empty: topic" in str(fr2["error"])


async def test_a_code_crew_runs_in_a_step_with_the_tools_that_need_no_article(crews: Crews) -> None:
    c, _ = container(flow({"kind": "crew", "crew": "editorial", "inputs": {}, "save_as": "out"}))
    fr = await go(c)
    assert fr["status"] == "succeeded" and crews.calls[0]["crew"] == "editorial"
    assert all(t in cc.CUSTOM_TOOLS for tools in crews.calls[0]["tools"] for t in tools)


async def test_a_flow_step_starts_a_child_run_and_waits_for_it(crews: Crews) -> None:
    spec = flow({"kind": "flow", "flow": "gsc_sync_flow", "save_as": "sync"}, crew_step("after", needs=["sync"]))
    c, web = container(spec)
    fr = await go(c)
    assert fr["status"] == "succeeded", fr
    child = next(r for r in c.store.rows.values() if r["flow_name"] == "gsc_sync_flow")
    assert child["triggered_by"] == "flow" and child["status"] == "succeeded"
    assert outcomes(fr) == [("sync", "succeeded"), ("after", "completed")]
    assert web.jobs  # the sync ran


async def test_a_test_run_starts_no_other_flow(crews: Crews) -> None:
    c, _ = container(flow({"kind": "flow", "flow": "gsc_sync_flow", "save_as": "sync"}, crew_step("after")))
    fr = await go(c, dry_run=True)
    assert fr["outputs"]["outcome"] == "dry_run"
    assert not [r for r in c.store.rows.values() if r["flow_name"] == "gsc_sync_flow"]


# --- switches ----------------------------------------------------------------------------------------------------------


async def test_a_flow_switched_off_in_the_admin_is_refused_whoever_starts_it() -> None:
    web = SwitchWeb()
    web.off = [{"flow": "gsc_sync_flow", "reason": "quota"}]
    c = memory_container(settings(), llm=None, web=web)
    for trigger in ("manual", "cron", "flow"):
        with pytest.raises(RunError) as e:
            await c.runner.kickoff("gsc_sync_flow", {}, triggered_by=trigger)
        assert e.value.status == 409 and "switched off" in str(e.value) and "quota" in str(e.value)
    r = await c.runner.kickoff("ga4_sync_flow", {}, triggered_by="manual")
    assert r["status"] == "queued"


async def test_switches_keep_the_last_answer_when_the_web_app_is_down() -> None:
    web = SwitchWeb()
    now = [0.0]
    sw = FlowSwitches(web, ttl_s=30, clock=lambda: now[0])
    web.fail = True
    assert await sw.disabled() == {}  # never told: nothing is off
    web.fail, web.off = False, [{"flow": "reindex_flow", "reason": ""}]
    now[0] = 31
    assert await sw.disabled() == {"reindex_flow": ""}
    web.fail = True
    now[0] = 62
    assert await sw.disabled() == {"reindex_flow": ""}


# --- catalogue -----------------------------------------------------------------------------------------------------------


def test_every_flow_has_catalogue_metadata_and_categories_never_decide_how_it_runs() -> None:
    assert set(SPECS) <= set(FLOW_INFO)
    items = {f["name"]: f for f in catalogue()}
    assert items["gsc_sync_flow"]["label"] == "Search Console sync" and "seo" in items["gsc_sync_flow"]["categories"]
    assert items["publish_flow"]["start"] == "approval" and not items["publish_flow"]["flow_step"]
    # Categories are served to the admin and never read back: neither engine module mentions them.
    from pathlib import Path

    assert all("categories" not in Path(f).read_text() for f in ("app/runs.py", "app/flows/custom.py", "app/crews/custom.py", "app/flows/switches.py"))


def test_crew_as_spec_endpoint(web: FakeWebApp) -> None:
    with TestClient(create_app(memory_container(settings(), llm=None, web=web))) as client:
        r = client.post("/crews/editorial/as-spec", headers=AUTH, json={"key": "editorial_copy", "label": "Editorial (copy)"})
        assert r.status_code == 200, r.text
        assert r.json()["spec"]["key"] == "editorial_copy" and r.json()["spec"]["label"] == "Editorial (copy)"
        assert client.post("/crews/editorial/as-spec", headers=AUTH, json={"key": "report"}).status_code == 422
        assert client.post("/crews/nope/as-spec", headers=AUTH, json={"key": "x_y"}).status_code == 404
        crews_ = client.get("/crews", headers=AUTH).json()["items"]
        assert {c["crew"]: c["categories"] for c in crews_}["report"] == ["seo"]


# --- redaction and logging switches ------------------------------------------------------------------------------------


def test_redaction_by_key_and_by_shape() -> None:
    data = {"api_key": "abc123", "nested": {"Authorization": "Bearer x", "password": "hunter2"}, "tokens": 12, "note": "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA and ghp_BBBBBBBBBBBBBBBBBBBBBBBB"}
    out = redact(data)
    assert out["api_key"] == MASK and out["nested"] == {"Authorization": MASK, "password": MASK} and out["tokens"] == 12
    assert "sk-ant" not in out["note"] and "ghp_" not in out["note"]
    assert redact_text("postgres://moks:s3cr3t@db:5432/x") == f"postgres://moks:{MASK}@db:5432/x"
    assert redact_text("AKIAABCDEFGHIJKLMNOP here") == f"{MASK} here"
    assert "eyJ" not in redact_text("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop")
    assert metadata({"token": "x", "topic": "kubelet"})["values"]["token"] == MASK


def test_the_service_log_is_redacted() -> None:
    rec = logging.LogRecord("seo_agent.x", logging.INFO, __file__, 1, "connecting with password=hunter22", None, None)
    rec.api_key = "sk-proj-CCCCCCCCCCCCCCCCCCCCCCCC"
    line = JsonFormatter().format(rec)
    assert "hunter22" not in line and "CCCCCCCC" not in line and MASK in line


async def test_run_log_lines_and_step_detail_are_redacted_and_switchable(crews: Crews) -> None:
    class Web(FakeWebApp):
        switches: ClassVar[dict[str, Any]] = {}

        async def run_history_settings(self) -> dict[str, Any]:
            return dict(self.switches)

    crews.script = ["Output mentioning sk-ant-api03-DDDDDDDDDDDDDDDDDDDD inline, long enough."]
    w = Web()
    c, _ = container(flow(crew_step()), history=True, web=w)
    logging.getLogger("seo_agent.flows.custom").warning("secret is password=hunter33", extra={"token": "abc"})
    fr = await go(c, {"topic": "my api_key=zzzzzzzz"})
    await c.history.flush()
    assert fr["status"] == "succeeded"
    dumped = repr(c.history.sink.steps) + repr(c.history.sink.logs)
    assert "DDDDDDDD" not in dumped and "zzzzzzzz" not in dumped
    # Switched off: no log lines kept; step inputs and outputs left out of the detail.
    w.switches = {"logs": False, "step_io": False}
    c2, _ = container(flow(crew_step()), history=True, web=w)
    await go(c2)
    await c2.history.flush()
    assert c2.history.sink.logs == []
    detail = next(s for s in c2.history.sink.steps if s["step"] == "1-crew")["detail"]
    assert "input" not in detail and "output" not in detail and detail["crew"] == "explainer"


async def test_unsaved_drafts_run_only_as_test_runs(crews: Crews) -> None:
    c, web = container(flow(crew_step()))
    web.custom_crew_rows = []
    draft = flow(crew_step("checked"), inputs=["topic"])
    r = await c.runner.kickoff("custom_flow", {"flow": "pipeline", "inputs": {"topic": "etcd"}, "dry_run": True, "draft": draft, "crew_draft": CREW}, triggered_by="manual")
    fr = await c.runner.wait(r["run_id"], 30)
    assert fr["status"] == "succeeded" and outcomes(fr) == [("checked", "completed")] and crews.calls[0]["crew"] == "explainer"
    with pytest.raises(RunError) as e:
        await c.runner.kickoff("custom_flow", {"flow": "pipeline", "draft": draft}, triggered_by="manual")
    assert e.value.status == 422
    r2 = await c.runner.kickoff("custom_flow", {"flow": "pipeline", "dry_run": True, "draft": draft}, triggered_by="cron")
    assert (await c.runner.wait(r2["run_id"], 30))["status"] == "failed"
