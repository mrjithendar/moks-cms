"""The Anthropic SDK layer (no LangChain): exact request shape and usage/budget handling, against a mock transport."""

from __future__ import annotations

import json
from typing import Any

import anthropic
import httpx2
import pytest

from app.llm import AnthropicLlm, BudgetGuard, CallSpec, MemorySpendStore, Refused
from app.schemas import Relevance


def mock_client(reply: dict[str, Any], seen: list[dict[str, Any]]) -> anthropic.AsyncAnthropic:
    def handler(req: httpx2.Request) -> httpx2.Response:
        seen.append({"url": str(req.url), "headers": dict(req.headers), "body": json.loads(req.content)})
        return httpx2.Response(200, json=reply, headers={"request-id": "req_1"})

    return anthropic.AsyncAnthropic(api_key="sk-ant-test", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), max_retries=0)


def message(text: str, stop: str = "end_turn") -> dict[str, Any]:
    return {"id": "msg_1", "type": "message", "role": "assistant", "model": "m", "content": [{"type": "text", "text": text}], "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 0}}


async def test_structured_call_shape_caching_fallback_and_usage() -> None:
    seen: list[dict[str, Any]] = []
    store = MemorySpendStore()
    llm = AnthropicLlm("k", BudgetGuard(store, 10, 1), client=mock_client(message('{"relevant": true, "reason": "ok"}'), seen))
    spec = CallSpec(model="claude-sonnet-5-5", purpose="draft", prompt_version="v", cached_system=["RULES", "STYLE"], user="Q", max_tokens=500, effort="medium")
    out, usage = await llm.structured(spec, Relevance)
    assert out.relevant is True
    b = seen[0]["body"]
    assert b["system"][-1]["cache_control"] == {"type": "ephemeral"} and [x["text"] for x in b["system"]] == ["RULES", "STYLE"]
    assert b["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in seen[0]["headers"]["anthropic-beta"]
    assert b["output_config"]["effort"] == "medium" and b["output_config"]["format"]["type"] == "json_schema"
    assert "temperature" not in b
    assert (usage.input_tokens, usage.cache_read_tokens) == (120, 900)  # uncached input is billed separately from cache reads
    assert store.rows[0]["cache_read_tokens"] == 900 and store.rows[0]["purpose"] == "draft"


async def test_haiku_has_no_server_side_fallback() -> None:
    seen: list[dict[str, Any]] = []
    llm = AnthropicLlm("k", BudgetGuard(MemorySpendStore(), 10, 1), client=mock_client(message("hello"), seen))
    text, _ = await llm.text(CallSpec(model="claude-haiku-5-5", purpose="report", prompt_version="v", cached_system=["S"], user="Q", max_tokens=100))
    assert text == "hello" and "fallbacks" not in seen[0]["body"] and "server-side-fallback" not in seen[0]["headers"].get("anthropic-beta", "")


async def test_refusal_raises_and_is_recorded() -> None:
    store = MemorySpendStore()
    llm = AnthropicLlm("k", BudgetGuard(store, 10, 1), client=mock_client(message("", stop="refusal"), []))
    with pytest.raises(Refused):
        await llm.text(CallSpec(model="claude-sonnet-5-5", purpose="draft", prompt_version="v", cached_system=[], user="Q"))
    assert store.rows[0]["outcome"] == "refused"


async def test_budget_blocks_before_any_request() -> None:
    seen: list[dict[str, Any]] = []
    llm = AnthropicLlm("k", BudgetGuard(MemorySpendStore(preexisting_usd=10), 10, 1), client=mock_client(message("x"), seen))
    with pytest.raises(Exception, match="budget"):
        await llm.text(CallSpec(model="claude-sonnet-5-5", purpose="draft", prompt_version="v", cached_system=[], user="Q"))
    assert seen == []
