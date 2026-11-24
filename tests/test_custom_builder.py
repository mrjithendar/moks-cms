"""Custom crews and flows made in the admin (crew-jobs plan PR 6): the spec checks, the interpreter, and the guardrails
that stay in code (allowlisted tools, no publishing, no approval or MCP start)."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.crews import custom as cc
from app.flows import CRON_FLOWS, SPECS, check_kickoff
from app.flows import custom as cf
from app.main import create_app, memory_container
from app.runs import RunError
from tests.conftest import FakeWebApp, settings
from tests.test_console import AUTH

CREW: dict[str, Any] = {
    "key": "explainer",
    "label": "Explainer",
    "description": "Explains one topic for engineers.",
    "inputs": ["topic"],
    "agents": [
        {"key": "researcher", "role": "Researcher", "goal": "Find what the site already says.", "backstory": "Careful.", "tools": ["vector_search", "read_article"]},
        {"key": "writer", "role": "Writer", "goal": "Write it.", "backstory": "Plain.", "tools": []},
    ],
    "tasks": [
        {"key": "research", "agent": "researcher", "label": "Research", "instructions": "Research {topic} as of {today}.", "expected_output": "Notes."},
        {"key": "write", "agent": "writer", "label": "Write", "instructions": "Write about {topic}.", "expected_output": "MDX.", "context": ["research"]},
    ],
}
FLOW: dict[str, Any] = {
    "key": "explain_topic",
    "label": "Explain a topic",
    "inputs": ["topic"],
    "steps": [
        {"kind": "crew", "crew": "explainer", "inputs": {"topic": "{input.topic}"}, "save_as": "article"},
        {"kind": "condition", "value": "{steps.article}", "op": "min_length", "operand": "20", "otherwise": "stop"},
        {"kind": "draft", "title": "{input.topic} explained", "description": "What {input.topic} is.", "body": "{steps.article}", "collection": "blog"},
    ],
}


def bad(mutate: Any, base: dict[str, Any] = CREW) -> dict[str, Any]:
    spec = copy.deepcopy(base)
    mutate(spec)
    return spec


# --- the spec checks ---------------------------------------------------------------------------------------------------


def test_a_good_crew_spec_passes_and_keeps_its_shape() -> None:
    spec = cc.validate_crew(CREW)
    assert [a.key for a in spec.agents] == ["researcher", "writer"] and spec.tasks[1].context == ["research"]
    assert [d.tools for d in cc.agent_defs(spec)] == [["vector_search", "read_article"], []]


@pytest.mark.parametrize(
    ("why", "mutate"),
    [
        ("a tool outside the allowlist", lambda s: s["agents"][0]["tools"].append("read_news_item")),
        ("the per-article tool", lambda s: s["agents"][0]["tools"].append("gsc_queries_for_page")),
        ("a code crew's key", lambda s: s.update(key="editorial")),
        ("two agents with one key", lambda s: s["agents"].append(dict(s["agents"][0]))),
        ("a task for an agent that does not exist", lambda s: s["tasks"][0].update(agent="ghost")),
        ("context from a later task", lambda s: s["tasks"][0].update(context=["write"])),
        ("an input the crew does not have", lambda s: s["tasks"][0].update(instructions="Research {audience}.")),
        ("an unknown field", lambda s: s.update(memory=True)),
        ("a model that is not a Claude model id", lambda s: s["agents"][0].update(model="gpt-5")),
    ],
)
def test_a_crew_spec_cannot_widen_what_an_agent_may_do(why: str, mutate: Any) -> None:
    with pytest.raises(cc.SpecError) as e:
        cc.validate_crew(bad(mutate))
    assert e.value.issues, why


def test_a_task_reads_the_tasks_it_names_or_else_the_one_before_it() -> None:
    spec = cc.validate_crew(bad(lambda s: s["tasks"][1].update(context=[])))
    text = cc.task_text(spec, spec.tasks[0], {"topic": "pod resize"})
    assert text.startswith("Research pod resize as of ") and '<data name="inputs">' in text  # inputs are data, untrusted


def test_a_flow_spec_is_checked_against_its_inputs_steps_and_crews() -> None:
    assert [s.kind for s in cf.validate_flow(FLOW, {"explainer"}).steps] == ["crew", "condition", "draft"]
    for mutate in (
        lambda s: s["steps"][0]["inputs"].update(topic="{input.audience}"),
        lambda s: s["steps"][2].update(body="{steps.summary}"),
        lambda s: s.update(steps=[s["steps"][2]]),
        lambda s: s["steps"][1].update(operand="many"),
        lambda s: s["steps"].append({"kind": "publish", "draft": "x"}),  # there is no such step
    ):
        with pytest.raises(cc.SpecError):
            cf.validate_flow(bad(mutate, FLOW), {"explainer"})
    with pytest.raises(cc.SpecError) as e:
        cf.validate_flow(FLOW, set())
    assert "no crew explainer" in e.value.issues[0]


def test_templates_and_conditions() -> None:
    v = {"input": {"topic": "kubelet"}, "steps": {"article": "A long enough article."}}
    assert cf.fill("{input.topic}: {steps.article} {other}", v) == "kubelet: A long enough article. {other}"
    step = cf.ConditionStep(kind="condition", value="x", op="contains", operand="Long")
    assert cf.holds(step, "a long one") and not cf.holds(step.model_copy(update={"op": "not_contains"}), "a long one")
    assert cf.holds(step.model_copy(update={"op": "min_length", "operand": "3"}), "abcd")


# --- the interpreter ---------------------------------------------------------------------------------------------------


class FakeOutcome:
    def __init__(self, text: str) -> None:
        self.output, self.status, self.tokens, self.cost_usd = text, "completed", 100, 0.001


@pytest.fixture
def ran(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake(spec: Any, inputs: dict[str, str], **kw: Any) -> FakeOutcome:
        calls.append({"crew": spec.key, "inputs": inputs, "version": kw.get("version")})
        return FakeOutcome(f"An article about {inputs.get('topic')} with enough words to pass.")

    monkeypatch.setattr(cf, "run_custom_crew", fake)
    return calls


def container(flow: dict[str, Any] = FLOW) -> tuple[Any, FakeWebApp]:
    web = FakeWebApp(custom_crew_rows=[{"key": "explainer", "version": 2, "spec": CREW}], custom_flow_rows=[{"key": flow["key"], "version": 1, "spec": flow}])
    return memory_container(settings(), llm=None, web=web), web


async def go(c: Any, inputs: dict[str, Any]) -> dict[str, Any]:
    r = await c.runner.kickoff("custom_flow", inputs, triggered_by="manual")
    return await c.runner.wait(r["run_id"], 30)


async def test_a_custom_flow_runs_its_crew_and_puts_a_draft_in_review(ran: list[dict[str, Any]]) -> None:
    c, web = container()
    fr = await go(c, {"flow": "explain_topic", "inputs": {"topic": "kubelet"}})
    assert fr["status"] == "succeeded", fr
    assert ran == [{"crew": "explainer", "inputs": {"topic": "kubelet"}, "version": 2}]
    assert web.custom_drafts[0] | {"runId": None} == {"title": "kubelet explained", "description": "What kubelet is.", "body": "An article about kubelet with enough words to pass.", "collection": "blog", "category": None, "flow": "explain_topic", "runId": None}
    assert [s["outcome"] for s in fr["state_json"]["steps"]] == ["completed", "held", "ready_for_review"]
    assert not web.published  # a custom flow never publishes


async def test_a_test_run_creates_no_draft(ran: list[dict[str, Any]]) -> None:
    c, web = container()
    fr = await go(c, {"flow": "explain_topic", "inputs": {"topic": "kubelet"}, "dry_run": True})
    assert fr["outputs"]["outcome"] == "dry_run" and web.custom_drafts == []


async def test_a_condition_can_stop_the_flow_or_skip_the_next_step(ran: list[dict[str, Any]]) -> None:
    stop = bad(lambda s: s["steps"][1].update(op="contains", operand="nowhere"), FLOW)
    c, web = container(stop)
    fr = await go(c, {"flow": "explain_topic", "inputs": {"topic": "kubelet"}})
    assert fr["outputs"]["outcome"] == "stopped" and web.custom_drafts == []
    skip = bad(lambda s: s["steps"][1].update(op="contains", operand="nowhere", otherwise="skip_next"), FLOW)
    c2, web2 = container(skip)
    fr2 = await go(c2, {"flow": "explain_topic", "inputs": {"topic": "kubelet"}})
    assert [s["outcome"] for s in fr2["state_json"]["steps"]][-1] == "skipped" and web2.custom_drafts == []


async def test_a_flow_that_is_gone_fails_and_says_why(ran: list[dict[str, Any]]) -> None:
    c, _web = container()
    fr = await go(c, {"flow": "no_such_flow"})
    assert fr["status"] == "failed" and "no flow no_such_flow" in str(fr.get("error") or fr["state_json"]["errors"])


# --- guardrails and the API -------------------------------------------------------------------------------------------


def test_who_may_start_a_custom_flow() -> None:
    assert "custom_flow" in SPECS and "custom_flow" in CRON_FLOWS  # by hand, by a schedule
    check_kickoff("custom_flow", "manual")
    check_kickoff("custom_flow", "cron")
    for trigger in ("approval", "mcp"):
        with pytest.raises(RunError):
            check_kickoff("custom_flow", trigger)


def test_the_builder_code_has_no_way_to_publish() -> None:
    from pathlib import Path

    for f in ("app/crews/custom.py", "app/flows/custom.py"):
        code = Path(f).read_text().split('"""', 2)[-1]  # the code after the module docstring
        assert "publish" not in code and "approve" not in code, f


def test_the_validate_endpoint(web: FakeWebApp) -> None:
    with TestClient(create_app(memory_container(settings(), llm=None, web=web))) as client:
        ok = client.post("/custom/validate", headers=AUTH, json={"kind": "crew", "spec": CREW})
        assert ok.status_code == 200 and ok.json()["spec"]["key"] == "explainer"
        no = client.post("/custom/validate", headers=AUTH, json={"kind": "crew", "spec": bad(lambda s: s["agents"][0]["tools"].append("shell"))})
        assert no.status_code == 422 and "shell" in no.json()["issues"][0]
        flow = client.post("/custom/validate", headers=AUTH, json={"kind": "flow", "spec": FLOW, "crews": []})
        assert flow.status_code == 422
        assert client.post("/custom/validate", headers=AUTH, json={"kind": "flow", "spec": FLOW, "crews": ["explainer"]}).status_code == 200
        assert client.post("/custom/validate", json={"kind": "crew", "spec": CREW}).status_code == 401
