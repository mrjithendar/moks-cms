"""The OpenAI-compatible adapter against recorded-shape responses. No live calls: httpx.MockTransport."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from app.llm_adapters import BadOutput, Endpoint, OpenAICompat, ProviderError

KEY = "sk-test-not-a-real-key-000111"


class Verdict(BaseModel):
    label: str
    score: int


def completion(content: str, finish: str = "stop", usage: bool = True, model: str = "served-model") -> dict[str, Any]:
    out: dict[str, Any] = {"id": "chatcmpl-1", "object": "chat.completion", "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish}]}
    if usage:
        out["usage"] = {"prompt_tokens": 32, "completion_tokens": 27, "total_tokens": 59}
    return out


def adapter(replies: list[httpx.Response | Exception], seen: list[httpx.Request], **endpoint: Any) -> OpenAICompat:
    queue = list(replies)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        r = queue.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    async def no_sleep(_: float) -> None:
        return None

    ep = Endpoint(**{"base_url": "https://llm.example.com/v1", "api_key": KEY, **endpoint})
    return OpenAICompat(ep, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), sleep=no_sleep)


def ok(body: dict[str, Any], **headers: str) -> httpx.Response:
    return httpx.Response(200, json=body, headers=headers)


async def test_structured_with_json_schema_sends_the_schema_and_reads_usage() -> None:
    seen: list[httpx.Request] = []
    a = adapter([ok(completion('{"label": "good", "score": 4}'), **{"x-request-id": "req_1"})], seen, structured="json_schema")
    value, answers = await a.structured("m1", ["You grade things."], "Grade this.", 200, Verdict)
    assert value == Verdict(label="good", score=4)
    (ans,) = answers
    assert (ans.input_tokens, ans.output_tokens, ans.usage_reported, ans.request_id, ans.model) == (32, 27, True, "req_1", "served-model")
    (req,) = seen
    assert str(req.url) == "https://llm.example.com/v1/chat/completions" and req.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(req.content)
    assert body["model"] == "m1" and body["max_tokens"] == 200
    assert body["messages"] == [{"role": "system", "content": "You grade things."}, {"role": "user", "content": "Grade this."}]
    fmt = body["response_format"]
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["name"] == "Verdict" and fmt["json_schema"]["strict"] is False
    assert fmt["json_schema"]["schema"]["properties"].keys() == {"label", "score"}


async def test_json_mode_puts_the_schema_in_the_system_message_and_accepts_a_fenced_answer() -> None:
    seen: list[httpx.Request] = []
    a = adapter([ok(completion('```json\n{"label": "ok", "score": 1}\n```'))], seen, structured="json_object")
    value, _ = await a.structured("m1", [], "Grade this.", 100, Verdict)
    assert value.score == 1
    body = json.loads(seen[0].content)
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][0]["role"] == "system" and "JSON Schema" in body["messages"][0]["content"] and '"score"' in body["messages"][0]["content"]
    seen.clear()
    plain = adapter([ok(completion('{"label": "ok", "score": 2}'))], seen, structured="none")
    assert (await plain.structured("m1", [], "x", 100, Verdict))[0].score == 2 and "response_format" not in json.loads(seen[0].content)


async def test_one_repair_then_bad_output_and_both_calls_are_reported() -> None:
    seen: list[httpx.Request] = []
    a = adapter([ok(completion('{"label": "good"}')), ok(completion('{"label": "good", "score": 3}'))], seen)
    value, answers = await a.structured("m1", [], "Grade this.", 100, Verdict)
    assert value.score == 3 and len(answers) == 2
    repair = json.loads(seen[1].content)["messages"][-1]["content"]
    assert "rejected by the validator" in repair and "score" in repair and repair.startswith("Grade this.")
    seen.clear()
    b = adapter([ok(completion("not json")), ok(completion('{"label": 1}'))], seen)
    with pytest.raises(BadOutput) as e:
        await b.structured("m1", [], "Grade this.", 100, Verdict)
    assert len(e.value.answers) == 2 and len(seen) == 2 and e.value.code == "schema"  # never a third call


async def test_cut_off_and_filtered_answers_are_not_repaired() -> None:
    seen: list[httpx.Request] = []
    a = adapter([ok(completion('{"label": "go', finish="length"))], seen)
    with pytest.raises(BadOutput) as e:
        await a.structured("m1", [], "x", 5, Verdict)
    assert e.value.code == "max_tokens" and len(seen) == 1 and len(e.value.answers) == 1
    b = adapter([ok(completion("", finish="content_filter"))], [])
    with pytest.raises(BadOutput) as e2:
        await b.text("m1", [], "x", 5)
    assert e2.value.code == "refusal"


async def test_text_and_missing_usage() -> None:
    seen: list[httpx.Request] = []
    a = adapter([ok(completion("Hello.", usage=False, model=""))], seen, auth="none")
    ans = await a.text("local-model", ["Be brief."], "Hi", 50)
    assert ans.text == "Hello." and ans.usage_reported is False and ans.input_tokens == 0 and ans.model == "local-model"
    assert "authorization" not in seen[0].headers and "api-key" not in seen[0].headers


async def test_azure_style_key_header_and_query() -> None:
    seen: list[httpx.Request] = []
    a = adapter([ok(completion("x"))], seen, base_url="https://res.openai.azure.com/openai/deployments/dep1", auth="api-key", query=(("api-version", "2024-10-21"),))
    await a.text("dep1", [], "Hi", 10)
    assert seen[0].headers["api-key"] == KEY and "authorization" not in seen[0].headers
    assert str(seen[0].url) == "https://res.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21"


async def test_retries_twice_on_429_and_5xx_then_gives_up_and_never_on_a_400() -> None:
    seen: list[httpx.Request] = []
    a = adapter([httpx.Response(429, json={"error": {"message": "slow down", "code": "rate_limit_exceeded"}}), httpx.Response(503, text="busy"), ok(completion("fine"))], seen)
    assert (await a.text("m1", [], "x", 10)).text == "fine" and len(seen) == 3
    seen.clear()
    b = adapter([httpx.Response(500, text="x"), httpx.ConnectError("boom"), httpx.ReadTimeout("slow")], seen)
    with pytest.raises(ProviderError) as e:
        await b.text("m1", [], "x", 10)
    assert e.value.retryable and e.value.code == "timeout" and len(seen) == 3
    seen.clear()
    c = adapter([httpx.Response(400, json={"error": {"message": "unknown model", "type": "invalid_request_error"}})], seen)
    with pytest.raises(ProviderError) as e2:
        await c.text("nope", [], "x", 10)
    assert (e2.value.status, e2.value.code, str(e2.value), len(seen)) == (400, "invalid_request_error", "unknown model", 1)


async def test_errors_and_reprs_never_hold_the_key() -> None:
    a = adapter([httpx.Response(401, json={"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}})], [])
    with pytest.raises(ProviderError) as e:
        await a.text("m1", [], "secret prompt", 10)
    assert KEY not in str(e.value) and "secret prompt" not in str(e.value) and e.value.status == 401
    assert KEY not in repr(a.endpoint)
    b = adapter([ok({"unexpected": True})], [])
    with pytest.raises(ProviderError) as e2:
        await b.text("m1", [], "x", 10)
    assert e2.value.code == "bad_response"


async def test_list_models() -> None:
    seen: list[httpx.Request] = []
    a = adapter([ok({"object": "list", "data": [{"id": "b", "object": "model"}, {"id": "a", "object": "model"}, {"id": "a"}, {"nope": 1}]})], seen)
    assert await a.list_models() == ["a", "b"]
    assert seen[0].method == "GET" and str(seen[0].url) == "https://llm.example.com/v1/models"
    b = adapter([httpx.Response(404, text="not found")], [])
    with pytest.raises(ProviderError) as e:
        await b.list_models()
    assert e.value.status == 404
