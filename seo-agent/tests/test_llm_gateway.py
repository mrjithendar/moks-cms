"""LiteLLM, the only model gateway (D-109, D-110; app/llm_gateway.py): every model call through LiteLLM's Chat
Completions API, its aliases choosing the models and its team and virtual keys holding the budgets. The service has no
provider client, no prices and no budget of its own.

The stand-in below answers like LiteLLM 1.111 did against a local proxy on 2026-11-28 (moks-cms PR notes): the alias
in the body, the target in x-litellm-model-name, the charge in x-litellm-response-cost (none on a stream), HTTP 422
error.type budget_exceeded for a key ("Key=…") or a team ("Team=…") over its budget, 403 key_model_access_denied,
GET /v1/models with the aliases the key may use, /key/info and /team/info readable with the key itself, at LiteLLM's
root.
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
from app.llm import BudgetExceeded, CallSpec, InvalidOutput, MemorySpendStore, Truncated, UsageLedger
from app.llm_gateway import Gateway, GatewayError, GatewayLlm, LlmNotConfigured, budget_refusal, gateway_status, list_aliases
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
        if req.url.path == "/v1/models":
            if key not in (AGENT, ASK):
                return httpx.Response(401, json={"error": {"message": "Authentication Error, Invalid proxy server token passed.", "type": "auth_error"}})
            return httpx.Response(200, json={"object": "list", "data": [{"id": n, "object": "model", "owned_by": "openai"} for n in TARGET]})
        if req.url.path == "/v1/model/info":
            data = [{"model_name": n, "litellm_params": {"model": t}, "model_info": {"input_cost_per_token": 3e-6}} for n, t in TARGET.items()]
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


def gateway(fake: FakeLiteLLM, *, ask: bool = True, key: str = AGENT) -> tuple[GatewayLlm, MemorySpendStore]:
    store = MemorySpendStore()
    gw = Gateway(base_url=BASE, api_key=key, ask_api_key=ASK if ask else "")

    async def no_sleep(_s: float) -> None:
        return None

    return GatewayLlm(gw, UsageLedger(store), client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)), sleep=no_sleep), store


def spec(model: str = "moks-cms-default", purpose: str = "draft", **kw: Any) -> CallSpec:
    return CallSpec(model=model, purpose=purpose, prompt_version="v1", cached_system=["Rules.", "Style guide."], user="Write it.", max_tokens=500, run_id="run-1", **kw)


def chat_bodies(fake: FakeLiteLLM) -> list[dict[str, Any]]:
    return [b for p, b, _ in fake.requests if p == "/v1/chat/completions"]


def test_settings_name_litellm_and_its_aliases_and_nothing_else() -> None:
    assert not Gateway.from_settings(load_settings({"LITELLM_BASE_URL": BASE})).configured
    assert not Gateway.from_settings(load_settings({"LITELLM_API_KEY": AGENT})).configured
    gw = Gateway.from_settings(load_settings({"LITELLM_BASE_URL": BASE + "/", "LITELLM_API_KEY": AGENT, "LITELLM_ASK_API_KEY": ASK, "LITELLM_MODEL": "my-default", "LITELLM_MODEL_FAST": "my-fast"}))
    assert gw.configured and gw.base_url == BASE and gw.root == "http://litellm.test:4000" and (gw.model_default, gw.model_fast) == ("my-default", "my-fast")
    assert AGENT not in repr(gw) and ASK not in repr(gw) and AGENT not in repr(load_settings({"LITELLM_API_KEY": AGENT}))
    plain = load_settings({})
    assert (plain.llm_model, plain.llm_model_fast) == ("moks-cms-default", "moks-cms-fast")
    # The provider settings are gone: a provider's key or model in the environment changes nothing.
    old = load_settings({"ANTHROPIC_API_KEY": "sk-ant", "SEO_DRAFT_MODEL": "claude-opus-5-5", "SEO_CLASSIFY_MODEL": "claude-haiku-5-5", "LITELLM_MODEL": "not an alias!"})
    assert (old.llm_model, old.llm_model_fast) == ("moks-cms-default", "moks-cms-fast") and not hasattr(old, "anthropic_api_key")
    assert load_settings({"SEO_CREW_MODELS": '{"editorial.writer": "moks-cms-quality", "editorial.reviewer": "bad name"}'}).crew_models == {"editorial.writer": "moks-cms-quality"}


def test_models_are_aliases_passed_as_they_are() -> None:
    gw = Gateway(base_url=BASE, api_key=AGENT, ask_api_key=ASK)
    assert gw.model_for("moks-cms-quality") == "moks-cms-quality" and gw.model_for("claude-sonnet-5-5") == "claude-sonnet-5-5"
    assert gw.model_for("") == "moks-cms-default" and gw.model_for("  ") == "moks-cms-default"
    assert gw.key_for("ask_answer") == ASK and gw.key_for("draft") == AGENT
    assert Gateway(base_url=BASE, api_key=AGENT).key_for("ask_answer") == AGENT  # no Ask key: the agent's


async def test_without_litellm_every_call_fails_at_once_and_nothing_is_sent() -> None:
    fake = FakeLiteLLM()
    llm = GatewayLlm(Gateway(), UsageLedger(MemorySpendStore()), client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)))
    with pytest.raises(LlmNotConfigured) as e:
        await llm.text(spec())
    assert e.value.code == "not_configured" and "LITELLM_BASE_URL" in str(e.value)
    with pytest.raises(LlmNotConfigured):
        await llm.structured(spec(), Verdict)
    with pytest.raises(LlmNotConfigured):
        [t async for t in llm.stream(spec())]
    assert fake.requests == [] and llm.ledger.store.rows == []  # type: ignore[attr-defined]


async def test_a_call_goes_through_litellm_and_is_recorded_at_its_charge() -> None:
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
    assert (row["provider"] == "litellm" and row["model"] == "claude-sonnet-5-5" and row["cost_usd"] == pytest.approx(0.0042) and row["outcome"] == "ok" and row["run_id"] == "run-1")
    assert [p for p, _, _ in fake.requests] == ["/v1/chat/completions"]  # no price list is read: the cost is LiteLLM's


async def test_a_call_without_a_cost_header_is_recorded_without_a_cost() -> None:
    fake = FakeLiteLLM([{"cost": ""}])
    llm, store = gateway(fake)
    _, usage = await llm.text(spec())
    assert usage.cost is None and usage.cost_usd() == 0.0 and store.rows[0]["cost_usd"] == 0.0


async def test_ask_the_blog_uses_its_own_key_and_images_go_as_data_urls() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    await llm.text(spec("moks-cms-fast", "ask_answer", images=[("image/png", b"\x89PNG")]))
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


async def test_a_stream_is_recorded_once_with_litellms_tokens_and_no_computed_cost() -> None:
    fake = FakeLiteLLM([{"content": "Hello there"}])
    llm, store = gateway(fake)
    seen: list[Any] = []
    out = [t async for t in llm.stream(spec("moks-cms-fast", "ask_answer"), on_usage=seen.append)]
    assert "".join(out) == "Hello there" and chat_bodies(fake)[0]["stream_options"] == {"include_usage": True}
    [row] = store.rows
    assert row["cost_usd"] == 0.0 and row["provider"] == "litellm" and row["input_tokens"] == 500 and row["output_tokens"] == 200
    assert seen[0].cost is None and [p for p, _, _ in fake.requests] == ["/v1/chat/completions"]


async def test_a_stream_closed_early_is_recorded_once_as_cancelled() -> None:
    fake = FakeLiteLLM([{"content": "Hello there, a longer answer"}])
    llm, store = gateway(fake)
    seen: list[Any] = []
    gen = llm.stream(spec("moks-cms-fast", "ask_answer"), on_usage=seen.append)
    assert await gen.__anext__() == "Hel"
    await gen.aclose()  # the reader went away
    [row] = store.rows
    assert row["outcome"] == "cancelled" and row["error_code"] == "stream_closed" and row["cost_usd"] == 0.0 and len(seen) == 1


async def test_a_budget_litellm_refuses_raises_budget_exceeded_and_pauses_the_run() -> None:
    key_over = {"status": 422, "error": {"message": "Budget has been exceeded! Key=abc Current cost: 0.51, Max budget: 0.5", "type": "budget_exceeded", "code": "422"}}
    team_over = {"status": 422, "error": {"message": "Budget has been exceeded! Team=team-1 Current cost: 20.1, Max budget: 20.0", "type": "budget_exceeded", "code": "422"}}
    fake = FakeLiteLLM([key_over, team_over])
    llm, store = gateway(fake)
    with pytest.raises(BudgetExceeded) as ask:
        await llm.text(spec("moks-cms-fast", "ask_answer"))
    assert ask.value.scope == "litellm_key" and "Ask the Blog's key" in ask.value.detail and "0.51, Max budget: 0.5" in ask.value.detail
    with pytest.raises(BudgetExceeded) as team:
        await llm.text(spec())
    assert team.value.scope == "litellm_team" and "jithendar.com team" in team.value.detail
    assert store.rows == [] and len(chat_bodies(fake)) == 2  # refused before any token, and never retried
    assert budget_refusal(400, {"error": {"message": "nope", "type": "invalid_request_error"}}, "draft") is None


def test_a_flow_run_refused_by_litellms_budget_ends_paused_budget() -> None:
    over = {"status": 422, "error": {"message": "Budget has been exceeded! Team=team-1 Current cost: 20.1, Max budget: 20.0", "type": "budget_exceeded", "code": "422"}}
    fake = FakeLiteLLM([over] * 8)
    llm, _ = gateway(fake)
    web = FakeWebApp()
    c = memory_container(settings(), llm=llm, web=web)
    client = TestClient(create_app(c))
    auth = {"Authorization": "Bearer " + settings().agent_token}
    with client:
        run = client.post("/flows/report_flow/kickoff", headers=auth, json={"inputs": {"period": "weekly"}, "triggered_by": "manual"})
        assert run.status_code in (200, 202), run.text
        rid = run.json()["run_id"]
        import time

        for _ in range(200):
            view = client.get(f"/flows/runs/{rid}", headers=auth).json()
            if view["status"] not in ("queued", "running"):
                break
            time.sleep(0.02)
    assert view["status"] == "paused_budget", view
    assert chat_bodies(fake), "the run asked LiteLLM"


async def test_a_refused_model_is_not_retried_a_server_error_is() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    with pytest.raises(GatewayError) as e:
        await llm.text(spec("gpt-unknown"))
    assert e.value.code == "key_model_access_denied" and len(chat_bodies(fake)) == 1 and AGENT not in str(e.value)
    flaky = FakeLiteLLM([{"status": 503, "error": {"message": "upstream down"}}, {}])
    llm2, store2 = gateway(flaky)
    assert (await llm2.text(spec()))[0] == "Hello" and len(chat_bodies(flaky)) == 2 and len(store2.rows) == 1


async def test_a_cut_off_answer_is_recorded_as_truncated() -> None:
    fake = FakeLiteLLM([{"content": "Half an ans", "finish": "length"}])
    llm, store = gateway(fake)
    with pytest.raises(Truncated):
        await llm.text(spec())
    assert store.rows[0]["outcome"] == "truncated" and store.rows[0]["error_code"] == "max_tokens"


async def test_the_status_says_whether_litellm_answers_and_shows_its_keys_team_and_aliases() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    st = await gateway_status(llm.gw, llm.client)
    assert set(st) == {"gateway", "configured", "base_url", "aliases", "healthy", "checked_at", "keys", "team", "models", "errors"}
    assert st["gateway"] == "litellm" and st["configured"] is True and st["healthy"] is True and st["base_url"] == BASE and st["errors"] == []
    assert st["aliases"] == {"default": "moks-cms-default", "fast": "moks-cms-fast"} and "T" in st["checked_at"]
    assert [k["caller"] for k in st["keys"]] == ["agent", "ask"]
    assert st["keys"][1] | {} == {**st["keys"][1], "alias": "jithendar-ask", "max_budget_usd": 0.5, "budget_duration": "1d"}
    assert st["team"] == {"alias": "jithendar.com", "spend_usd": 3.5, "max_budget_usd": 20.0, "budget_duration": "30d", "budget_reset_at": "2026-12-28T00:00:00+00:00", "models": ["moks-cms-default", "moks-cms-fast"]}
    assert st["models"] == [{"name": n, "target": t} for n, t in sorted(TARGET.items())]  # no prices: those are LiteLLM's
    paths = [p for p, _, _ in fake.requests]
    assert "/key/info" in paths and "/team/info" in paths and "/v1/models" in paths  # LiteLLM's own routes at its root
    assert all(AGENT not in json.dumps(v) and ASK not in json.dumps(v) for v in st.values())


async def test_the_status_without_litellm_or_with_a_bad_key() -> None:
    st = await gateway_status(Gateway())
    assert st["configured"] is False and st["healthy"] is None and st["base_url"] is None and st["keys"] == [] and "LITELLM_BASE_URL" in st["errors"][0]
    fake = FakeLiteLLM()
    llm, _ = gateway(fake, key="sk-revoked")
    bad = await gateway_status(llm.gw, llm.client)
    assert bad["healthy"] is False and any("HTTP 401" in e for e in bad["errors"]) and "sk-revoked" not in json.dumps(bad)


async def test_the_aliases_the_key_may_use_are_listed_for_the_crew_editor() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    assert await list_aliases(llm.gw, llm.client) == sorted(TARGET)
    assert await list_aliases(Gateway()) is None


def test_the_status_route_and_the_removed_budget_and_provider_routes() -> None:
    fake = FakeLiteLLM()
    llm, _ = gateway(fake)
    c = memory_container(settings(), llm=llm, web=FakeWebApp())
    client = TestClient(create_app(c))
    auth = {"Authorization": "Bearer " + settings().agent_token}
    with client:
        st = client.get("/llm-status", headers=auth).json()
        assert st["configured"] is True and st["healthy"] is True and st["team"]["max_budget_usd"] == 20.0
        assert client.get("/llm-status").status_code == 401
        for method, path in (("GET", "/budget"), ("GET", "/llm-budget"), ("PUT", "/llm-budget"), ("POST", "/llm-budget/reserve"), ("POST", "/llm-budget/settle"), ("GET", "/llm-budgets"), ("GET", "/llm-providers"), ("PUT", "/llm-providers"), ("POST", "/llm-providers/anthropic/discover"), ("GET", "/llm-models")):
            assert client.request(method, path, headers=auth).status_code in (404, 405), path
    unconfigured = TestClient(create_app(memory_container(settings(), llm=llm, web=FakeWebApp(), gateway=Gateway())))
    with unconfigured:
        assert unconfigured.get("/llm-status", headers=auth).json()["configured"] is False


def test_no_provider_client_remains_in_the_agent() -> None:
    """Every chat model call goes through LiteLLM: no provider SDK or provider chat endpoint anywhere in app/. Image
    generation (app/news/images.py: Gemini and OpenAI image APIs) is the one documented exception (D-110)."""
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    banned = re.compile(r"api\.anthropic\.com|api\.openai\.com/v1/(chat|responses|completions)|generativelanguage\.googleapis\.com|^\s*(import|from)\s+(anthropic|openai|google\.genai|google\.generativeai)\b|AsyncAnthropic|bedrock-runtime|api\.perplexity\.ai", re.M)
    hits = [f"{p.relative_to(root)}: {m.group(0)}" for p in root.rglob("*.py") if p.name != "images.py" or p.parent.name != "news" for m in [banned.search(p.read_text())] if m]
    assert hits == []
    import importlib.util

    for gone in ("app.llm_budgets", "app.llm_providers", "app.llm_adapters"):
        assert importlib.util.find_spec(gone) is None, gone
