"""LiteLLM as the gateway (D-109, app/llm_gateway.py): every model call through LiteLLM's Chat Completions API, its
aliases choosing the models and its team and virtual keys holding the budgets.

The stand-in below answers like LiteLLM 1.111 did against a local proxy on 2026-11-28 (moks-cms PR notes): the alias
in the body, the target in x-litellm-model-name, the charge in x-litellm-response-cost (none on a stream: the price
comes from GET /model/info), HTTP 422 error.type budget_exceeded for a key ("Key=…") or a team ("Team=…") over its
budget, 403 key_model_access_denied, /key/info and /team/info readable with the key itself, at LiteLLM's root.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.config import load_settings
from app.llm import BudgetExceeded, BudgetGuard, CallSpec, InvalidOutput, MemorySpendStore, Truncated
from app.llm_gateway import Gateway, GatewayError, GatewayLlm, budget_refusal, gateway_status
from app.main import create_app, memory_container
from tests.conftest import FakeWebApp, settings

BASE = "http://litellm.test:4000/v1"
AGENT, ASK = "sk-agent-key", "sk-ask-key"
TARGET = {"moks-cms-default": "anthropic/claude-sonnet-5-5", "moks-cms-fast": "anthropic/claude-haiku-5-5"}
USAGE = {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200, "prompt_tokens_details": {"cached_tokens": 400}, "cache_creation_input_tokens": 100}


class Verdict(BaseModel):
    title: str
    score: int


@dataclass
class FakeLiteLLM:
    """Scripted answers per call (dicts: content / finish / status / error), or the default answer."""

    answers: list[dict[str, Any]] = field(default_factory=list)
    requests: list[tuple[str, dict[str, Any], dict[str, str]]] = field(default_factory=list)

    def handler(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else {}
        self.requests.append((req.url.path, body, dict(req.headers)))
        key = req.headers.get("authorization", "").removeprefix("Bearer ")
        if req.url.path == "/key/info":
            alias = {AGENT: "jithendar-seo", ASK: "jithendar-ask"}.get(key)
            info = {"key_alias": alias, "spend": 1.25, "max_budget": None if key == AGENT else 0.5, "budget_duration": None if key == AGENT else "1d", "budget_reset_at": None, "team_id": "team-1", "models": ["moks-cms-default", "moks-cms-fast"], "tpm_limit": None, "rpm_limit": None}
            return httpx.Response(200, json={"key": "hashed", "info": info})
        if req.url.path == "/team/info":
            return httpx.Response(200, json={"team_id": "team-1", "team_info": {"team_alias": "jithendar.com", "spend": 3.5, "max_budget": 20.0, "budget_duration": "30d", "budget_reset_at": "2026-12-28T00:00:00+00:00", "models": ["moks-cms-default", "moks-cms-fast"]}})
        if req.url.path == "/v1/model/info":
            data = [{"model_name": n, "litellm_params": {"model": t}, "model_info": {"input_cost_per_token": 3e-6 if "sonnet" in t else 1e-6, "output_cost_per_token": 15e-6 if "sonnet" in t else 5e-6, "cache_read_input_token_cost": 3e-7 if "sonnet" in t else 1e-7, "cache_creation_input_token_cost": 3.75e-6 if "sonnet" in t else 1.25e-6}} for n, t in TARGET.items()]
            return httpx.Response(200, json={"data": data})
        assert req.url.path == "/v1/chat/completions", req.url.path
        a = self.answers.pop(0) if self.answers else {}
        if a.get("status"):
            return httpx.Response(a["status"], json={"error": a["error"]})
        model = body["model"]
        if model not in TARGET:
            return httpx.Response(403, json={"error": {"message": f"The requested model '{model}' is not available for this API key", "type": "key_model_access_denied", "code": "403"}})
        content, finish = a.get("content", "Hello"), a.get("finish", "stop")
        headers = {"x-litellm-model-name": TARGET[model], "x-litellm-call-id": "call-1"}
        if body.get("stream"):
            chunks = [{"choices": [{"index": 0, "delta": {"content": content[:3]}}]}, {"choices": [{"index": 0, "delta": {"content": content[3:]}}]}, {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}, {"choices": [], "usage": USAGE}]
            text = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
            return httpx.Response(200, headers={**headers, "content-type": "text/event-stream"}, content=text.encode())
        headers["x-litellm-response-cost"] = str(a.get("cost", 0.0042))
        return httpx.Response(200, headers=headers, json={"id": "chatcmpl-1", "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish}], "usage": USAGE})


def gateway(fake: FakeLiteLLM, *, ask: bool = True) -> tuple[GatewayLlm, MemorySpendStore]:
    store = MemorySpendStore()
    gw = Gateway(base_url=BASE, api_key=AGENT, ask_api_key=ASK if ask else "")

    async def no_sleep(_s: float) -> None:
        return None

    return GatewayLlm(gw, BudgetGuard(store, None, 0.0, gateway=True), client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)), sleep=no_sleep), store


def spec(model: str = "claude-sonnet-5-5", purpose: str = "draft", **kw: Any) -> CallSpec:
    return CallSpec(model=model, purpose=purpose, prompt_version="v1", cached_system=["Rules.", "Style guide."], user="Write it.", max_tokens=500, run_id="run-1", **kw)


def chat_bodies(fake: FakeLiteLLM) -> list[dict[str, Any]]:
    return [b for p, b, _ in fake.requests if p == "/v1/chat/completions"]


def test_settings_turn_the_gateway_on_only_with_a_url_and_a_key() -> None:
    assert Gateway.from_settings(load_settings({"LITELLM_BASE_URL": BASE})) is None
    assert Gateway.from_settings(load_settings({"LITELLM_API_KEY": AGENT})) is None
    gw = Gateway.from_settings(load_settings({"LITELLM_BASE_URL": BASE + "/", "LITELLM_API_KEY": AGENT, "LITELLM_ASK_API_KEY": ASK, "LITELLM_MODEL_FAST": "my-fast"}))
    assert gw is not None and gw.base_url == BASE and gw.root == "http://litellm.test:4000" and gw.model_fast == "my-fast"
    assert AGENT not in repr(gw) and ASK not in repr(gw) and AGENT not in repr(load_settings({"LITELLM_API_KEY": AGENT}))


def test_models_are_asked_by_tier_and_aliases_pass_through() -> None:
    gw = Gateway(base_url=BASE, api_key=AGENT, ask_api_key=ASK)
    assert gw.model_for("claude-sonnet-5-5") == "moks-cms-default" and gw.model_for("claude-opus-5-5") == "moks-cms-default"
    assert gw.model_for("claude-haiku-5-5") == "moks-cms-fast"
    assert gw.model_for("moks-cms-writer") == "moks-cms-writer" and gw.model_for("") == "moks-cms-default"
    assert gw.key_for("ask_answer") == ASK and gw.key_for("draft") == AGENT
    assert Gateway(base_url=BASE, api_key=AGENT).key_for("ask_answer") == AGENT  # no Ask key: the agent's


async def test_a_call_goes_through_litellm_and_is_booked_at_its_charge() -> None:
    fake = FakeLiteLLM()
    llm, store = gateway(fake)
    text, usage = await llm.text(spec())
    assert text == "Hello"
    body = chat_bodies(fake)[0]
    assert body["model"] == "moks-cms-default" and body["max_tokens"] == 500
    assert body["messages"][0]["content"][-1] == {"type": "text", "text": "Style guide.", "cache_control": {"type": "ephemeral"}}
    assert body["metadata"] == {"purpose": "draft", "prompt_version": "v1", "run_id": "run-1"}
    assert fake.requests[0][2]["authorization"] == f"Bearer {AGENT}"
    assert (usage.model, usage.provider, usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.output_tokens) == ("claude-sonnet-5-5", "litellm", 500, 400, 100, 200)
    [row] = store.rows
    assert row["provider"] == "litellm" and row["model"] == "claude-sonnet-5-5" and row["cost_usd"] == pytest.approx(0.0042) and row["outcome"] == "ok" and row["run_id"] == "run-1"


async def test_ask_the_blog_uses_its_own_key_and_images_go_as_data_urls() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    await llm.text(spec("claude-haiku-5-5", "ask_answer", images=[("image/png", b"\x89PNG")]))
    _, body, headers = fake.requests[0]
    assert headers["authorization"] == f"Bearer {ASK}" and body["model"] == "moks-cms-fast"
    assert body["messages"][1]["content"][0] == {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw=="}}


async def test_structured_answers_are_validated_with_one_repair() -> None:
    fake = FakeLiteLLM([{"content": '{"title": "x"}'}, {"content": '```json\n{"title": "Kubernetes", "score": 7}\n```'}])
    llm, store = gateway(fake)
    value, _ = await llm.structured(spec(), Verdict)
    assert value == Verdict(title="Kubernetes", score=7)
    first, second = chat_bodies(fake)
    assert first["response_format"]["type"] == "json_schema" and first["response_format"]["json_schema"]["name"] == "Verdict"
    assert "rejected by the validator" in second["messages"][1]["content"] and "score" in second["messages"][1]["content"]
    assert [r["outcome"] for r in store.rows] == ["invalid", "ok"]
    fake2 = FakeLiteLLM([{"content": "no"}, {"content": "still no"}])
    llm2, store2 = gateway(fake2)
    with pytest.raises(InvalidOutput):
        await llm2.structured(spec(), Verdict)
    assert [r["outcome"] for r in store2.rows] == ["invalid", "invalid"]


async def test_a_stream_is_priced_with_litellms_own_prices_and_booked_once() -> None:
    fake = FakeLiteLLM([{"content": "Hello there"}])
    llm, store = gateway(fake)
    seen: list[Any] = []
    out = [t async for t in llm.stream(spec("claude-haiku-5-5", "ask_answer"), on_usage=seen.append)]
    assert "".join(out) == "Hello there" and chat_bodies(fake)[0]["stream_options"] == {"include_usage": True}
    # 500 in × 1e-6 + 200 out × 5e-6 + 400 cache read × 1e-7 + 100 cache write × 1.25e-6 (moks-cms-fast in /model/info)
    expected = 500e-6 + 200 * 5e-6 + 400e-7 + 100 * 1.25e-6
    [row] = store.rows
    assert row["cost_usd"] == pytest.approx(expected) and row["provider"] == "litellm" and seen[0].cost_override == pytest.approx(expected)


async def test_a_budget_litellm_refuses_pauses_like_the_services_own_did() -> None:
    key_over = {"status": 422, "error": {"message": "Budget has been exceeded! Key=abc Current cost: 0.51, Max budget: 0.5", "type": "budget_exceeded", "code": "422"}}
    team_over = {"status": 422, "error": {"message": "Budget has been exceeded! Team=team-1 Current cost: 20.1, Max budget: 20.0", "type": "budget_exceeded", "code": "422"}}
    fake = FakeLiteLLM([key_over, team_over])
    llm, store = gateway(fake)
    with pytest.raises(BudgetExceeded) as ask:
        await llm.text(spec("claude-haiku-5-5", "ask_answer"))
    assert ask.value.scope == "litellm_key" and "Ask the Blog's key" in ask.value.detail and "0.51, Max budget: 0.5" in ask.value.detail
    with pytest.raises(BudgetExceeded) as team:
        await llm.text(spec())
    assert team.value.scope == "litellm_team" and "jithendar.com team" in team.value.detail
    assert store.rows == [] and len(chat_bodies(fake)) == 2  # refused before any token, and never retried
    assert budget_refusal(400, {"error": {"message": "nope", "type": "invalid_request_error"}}, "draft") is None


async def test_a_refused_model_is_not_retried_a_server_error_is() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    with pytest.raises(GatewayError) as e:
        await llm.text(spec("gpt-unknown"))
    assert e.value.code == "key_model_access_denied" and len(chat_bodies(fake)) == 1 and AGENT not in str(e.value)
    flaky = FakeLiteLLM([{"status": 503, "error": {"message": "upstream down"}}, {}])
    llm2, store2 = gateway(flaky)
    assert (await llm2.text(spec()))[0] == "Hello" and len(chat_bodies(flaky)) == 2 and len(store2.rows) == 1


async def test_a_cut_off_answer_is_booked_as_truncated() -> None:
    fake = FakeLiteLLM([{"content": "Half an ans", "finish": "length"}])
    llm, store = gateway(fake)
    with pytest.raises(Truncated):
        await llm.text(spec())
    assert store.rows[0]["outcome"] == "truncated" and store.rows[0]["error_code"] == "max_tokens"


async def test_the_status_is_litellms_view_of_the_keys_the_team_and_the_aliases() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    st = await gateway_status(llm.gw, llm.client)
    assert st["errors"] == [] and [k["caller"] for k in st["keys"]] == ["agent", "ask"]
    assert st["keys"][1] | {} == {**st["keys"][1], "alias": "jithendar-ask", "max_budget_usd": 0.5, "budget_duration": "1d"}
    assert st["team"] == {"alias": "jithendar.com", "spend_usd": 3.5, "max_budget_usd": 20.0, "budget_duration": "30d", "budget_reset_at": "2026-12-28T00:00:00+00:00", "models": ["moks-cms-default", "moks-cms-fast"]}
    assert {m["name"]: m["target"] for m in st["models"]} == TARGET and st["models"][0]["input_usd_per_mtok"] == 3.0
    paths = [p for p, _, _ in fake.requests]
    assert "/key/info" in paths and "/team/info" in paths  # at LiteLLM's root, not under /v1
    assert all(AGENT not in json.dumps(v) for v in st.values())


def test_the_budget_api_shows_litellms_budgets_and_keeps_one_for_calls_outside_it() -> None:
    fake = FakeLiteLLM()
    llm, store = gateway(fake)
    c = memory_container(settings(), llm=llm, web=FakeWebApp())
    client = TestClient(create_app(c))
    auth = {"Authorization": "Bearer " + settings().agent_token}
    with client:
        view = client.get("/llm-budget", headers=auth).json()
        assert view["gateway"]["team"]["max_budget_usd"] == 20.0 and view["ask_daily"]["limit_usd"] is None
        assert "outside LiteLLM (AI visibility)" in view["gateway"]["budget_note"]
        # The admin's budget now covers only what cannot go through LiteLLM: AI visibility asks each assistant itself.
        assert client.put("/llm-budget", headers=auth, json={"daily_usd": 1, "monthly_usd": None}).status_code == 200
        store.rows.append({"provider": "litellm", "model": "claude-sonnet-5-5", "purpose": "draft", "cost_usd": 50.0})
        assert client.post("/llm-budget/reserve", headers=auth, json={"max_usd": 0.5, "purpose": "ai_visibility"}).status_code == 200
        store.rows.append({"provider": "openai", "model": "gpt-x", "purpose": "ai_visibility", "cost_usd": 0.9})
        refused = client.post("/llm-budget/reserve", headers=auth, json={"max_usd": 0.5, "purpose": "ai_visibility"})
        assert refused.status_code == 402 and "outside LiteLLM" in refused.json()["error"]


async def test_the_guard_never_checks_its_own_calls_in_gateway_mode_but_books_them() -> None:
    guard = BudgetGuard(MemorySpendStore(), 0.0, 0.0, gateway=True)  # a zero budget and a zero Ask cap: not for these
    await guard.ensure("claude-sonnet-5-5", 10_000, 4096, "draft")
    await guard.ensure("claude-haiku-5-5", 10_000, 4096, "ask_answer")
    with pytest.raises(BudgetExceeded):  # a call outside LiteLLM still is
        await guard.hold(0.01, "ai_visibility")
    closed = BudgetGuard(MemorySpendStore(), 0.0, 0.0)
    with pytest.raises(BudgetExceeded):
        await closed.ensure("claude-sonnet-5-5", 10_000, 4096, "draft")
