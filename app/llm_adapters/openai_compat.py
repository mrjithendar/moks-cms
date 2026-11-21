"""One adapter for every server that speaks the OpenAI Chat Completions API.

Checked against the docs on 2026-11-21:
- Chat Completions and `response_format` (`{"type": "json_schema", "json_schema": {...}}`, or `{"type":
  "json_object"}`, which needs the word JSON in a message): https://developers.openai.com/api/docs/guides/structured-outputs
- List models, `GET /models`, `Authorization: Bearer`: https://developers.openai.com/api/reference/resources/models/methods/list
- Azure OpenAI sends the key in an `api-key` header: https://learn.microsoft.com/azure/ai-services/openai/reference

Structured answers, in the order tried:
1. `json_schema` where the endpoint says it supports it. `strict` is off: strict mode accepts only a subset of JSON
   Schema, which a Pydantic model's schema does not always fit. The schema guides the model; it does not replace 2.
2. Every answer is validated against the Pydantic model here. If it does not fit, the model gets **one** repair
   request with the validation problems. A second miss is BadOutput.
Without `json_schema`: JSON mode (`json_object`) with the schema in the system message, or plain text for a server
that supports neither, then the same validation and repair.

Not done here, on purpose: images (the request shape is not verified yet, so a call with images is refused),
streaming, tools, prompt caching (Anthropic only).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

RETRY_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504})
MAX_RETRIES = 2
MAX_REPAIR_CHARS = 2000


@dataclass(frozen=True)
class Endpoint:
    """Where and how to call. `api_key` stays in this object: it is never put in an error, a log line or a repr."""

    base_url: str  # the part before /chat/completions, without a trailing slash
    api_key: str | None = field(default=None, repr=False)
    auth: Literal["bearer", "api-key", "none"] = "bearer"
    structured: Literal["json_schema", "json_object", "none"] = "json_object"
    timeout_s: float = 120.0
    query: tuple[tuple[str, str], ...] = ()  # e.g. (("api-version", "…"),) for Azure's older route
    # The name of the output-limit field. Chat Completions servers take "max_tokens"; set it per provider where
    # the provider's docs name another field.
    max_tokens_param: str = "max_tokens"

    def headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key and self.auth == "bearer":
            h["Authorization"] = f"Bearer {self.api_key}"
        elif self.api_key and self.auth == "api-key":
            h["api-key"] = self.api_key
        return h


@dataclass(frozen=True)
class Answer:
    """One call, as the provider reported it. Token counts are 0 when the server sent no usage."""

    text: str
    model: str  # the model that answered, when the server says; else the one asked for
    input_tokens: int = 0
    output_tokens: int = 0
    usage_reported: bool = False
    request_id: str | None = None
    latency_ms: int = 0
    finish_reason: str | None = None


class ProviderError(Exception):
    """The provider could not be reached or refused the request. The message never holds the key or the prompt."""

    def __init__(self, message: str, status: int | None = None, code: str | None = None, retryable: bool = False):
        super().__init__(message)
        self.status, self.code, self.retryable = status, code, retryable


class BadOutput(Exception):
    """The model answered, but not with something usable. `answers` are the calls that were made and must be booked."""

    def __init__(self, detail: str, answers: list[Answer], code: str = "schema"):
        super().__init__(detail)
        self.detail, self.answers, self.code = detail, answers, code


def _problems(e: ValidationError) -> str:
    return "\n".join(f"- {'.'.join(str(p) for p in err['loc']) or 'root'}: {err['msg']}" for err in e.errors(include_input=False)[:15])


def _strip_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def _error_text(status: int, body: Any) -> tuple[str, str | None]:
    """A short, safe message from an error body: the provider's own message and code, nothing else."""
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        msg, code = err.get("message"), err.get("code") or err.get("type")
        return (str(msg)[:300] if isinstance(msg, str) else f"HTTP {status}"), (str(code)[:80] if code else None)
    if isinstance(err, str):
        return err[:300], None
    return f"HTTP {status}", None


class OpenAICompat:
    def __init__(self, endpoint: Endpoint, client: httpx.AsyncClient | None = None, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self.endpoint = endpoint
        self.client = client or httpx.AsyncClient(timeout=endpoint.timeout_s)
        self.sleep = sleep

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _send(self, method: str, path: str, body: dict[str, Any] | None) -> httpx.Response:
        url = f"{self.endpoint.base_url}{path}"
        last: ProviderError | None = None
        for attempt in range(MAX_RETRIES + 1):
            if attempt:
                await self.sleep(min(8.0, 0.5 * 2**attempt))
            try:
                res = await self.client.request(method, url, headers=self.endpoint.headers(), params=dict(self.endpoint.query) or None, json=body)
            except httpx.TimeoutException:
                last = ProviderError("the provider did not answer in time", code="timeout", retryable=True)
                continue
            except httpx.HTTPError as e:
                last = ProviderError(f"the provider could not be reached ({type(e).__name__})", code="connection", retryable=True)
                continue
            if res.status_code < 400:
                return res
            try:
                parsed: Any = res.json()
            except ValueError:
                parsed = None
            msg, code = _error_text(res.status_code, parsed)
            last = ProviderError(msg, status=res.status_code, code=code, retryable=res.status_code in RETRY_STATUS)
            if not last.retryable:
                break
        assert last is not None
        raise last

    async def chat(self, model: str, system: list[str], user: str, max_tokens: int, response_format: dict[str, Any] | None = None) -> Answer:
        messages: list[dict[str, str]] = [{"role": "system", "content": "\n\n".join(s for s in system if s)}] if any(system) else []
        messages.append({"role": "user", "content": user})
        body: dict[str, Any] = {"model": model, "messages": messages, self.endpoint.max_tokens_param: max_tokens}
        if response_format is not None:
            body["response_format"] = response_format
        started = time.monotonic()
        res = await self._send("POST", "/chat/completions", body)
        latency = int((time.monotonic() - started) * 1000)
        try:
            data = res.json()
            choice = data["choices"][0]
            content = choice["message"].get("content")
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
            raise ProviderError("the provider's answer was not a chat completion", status=res.status_code, code="bad_response") from e
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else None
        return Answer(
            text=content if isinstance(content, str) else "",
            model=data.get("model") if isinstance(data.get("model"), str) and data.get("model") else model,
            input_tokens=int(usage.get("prompt_tokens") or 0) if usage else 0,
            output_tokens=int(usage.get("completion_tokens") or 0) if usage else 0,
            usage_reported=usage is not None,
            request_id=res.headers.get("x-request-id") or (data.get("id") if isinstance(data.get("id"), str) else None),
            latency_ms=latency,
            finish_reason=choice.get("finish_reason") if isinstance(choice.get("finish_reason"), str) else None,
        )

    async def text(self, model: str, system: list[str], user: str, max_tokens: int) -> Answer:
        a = await self.chat(model, system, user, max_tokens)
        if a.finish_reason == "length":
            raise BadOutput(f"output cut off at {max_tokens} tokens", [a], "max_tokens")
        if a.finish_reason == "content_filter":
            raise BadOutput("the provider filtered this answer", [a], "refusal")
        return a

    async def structured(self, model: str, system: list[str], user: str, max_tokens: int, schema: type[T]) -> tuple[T, list[Answer]]:
        """The validated object and every call that was made for it (one, or two when a repair was needed)."""
        json_schema = schema.model_json_schema()
        mode = self.endpoint.structured
        sys = list(system)
        if mode == "json_schema":
            fmt: dict[str, Any] | None = {"type": "json_schema", "json_schema": {"name": schema.__name__[:64], "strict": False, "schema": json_schema}}
        else:
            fmt = {"type": "json_object"} if mode == "json_object" else None
            sys.append("Answer with one JSON object and nothing else. It must follow this JSON Schema:\n" + json.dumps(json_schema, separators=(",", ":")))
        answers: list[Answer] = []
        prompt = user
        problems = ""
        for _ in range(2):
            a = await self.chat(model, sys, prompt, max_tokens, fmt)
            answers.append(a)
            if a.finish_reason == "length":
                raise BadOutput(f"output cut off at {max_tokens} tokens", answers, "max_tokens")
            if a.finish_reason == "content_filter":
                raise BadOutput("the provider filtered this answer", answers, "refusal")
            try:
                return schema.model_validate_json(_strip_fence(a.text)), answers
            except ValidationError as e:
                problems = _problems(e)
            prompt = (
                f"{user}\n\nYour previous answer was rejected by the validator:\n{problems[:MAX_REPAIR_CHARS]}\n\n"
                f"Your previous answer was:\n{a.text[:MAX_REPAIR_CHARS]}\n\nAnswer again with the complete JSON object, fixing every problem."
            )
        raise BadOutput(f"invalid output after one repair:\n{problems[:900]}", answers)

    async def list_models(self) -> list[str]:
        """Model ids from GET /models, sorted. A server without the endpoint answers 404: ProviderError."""
        res = await self._send("GET", "/models", None)
        try:
            data = res.json()["data"]
            ids = [m["id"] for m in data if isinstance(m, dict) and isinstance(m.get("id"), str)]
        except (ValueError, KeyError, TypeError) as e:
            raise ProviderError("the provider's model list could not be read", status=res.status_code, code="bad_response") from e
        return sorted(set(ids))
