"""LiteLLM: the only way this service calls a chat model (D-109, D-110).

Every flow step, crew, content flow, report and Ask the Blog answer goes to LiteLLM's OpenAI-compatible Chat
Completions API. LiteLLM holds the provider keys, chooses the provider and model behind each alias, and enforces the
budgets. This service names an alias and a key, nothing else: it has no provider client, no model list, no prices and
no budget of its own.

- **Models are aliases.** LITELLM_MODEL (default `cms-claude-sonnet-latest`: drafting, crews) and LITELLM_MODEL_FAST (default
  `ops-claude-haiku-latest`: classifying, Ask the Blog). A crew agent or a content flow may name another alias
  (SEO_CREW_MODELS, the crew configuration); names are passed to LiteLLM as they are. Changing provider or model is a
  change in LiteLLM (its Admin UI, Models + Endpoints), not a deploy.
- **Budgets are LiteLLM's.** The team "jithendar.com" and each caller's virtual key carry their own budget (and rate
  limits); LiteLLM refuses a call over one with HTTP 422 `budget_exceeded`, raised here as BudgetExceeded, so a flow
  run pauses (paused_budget) and Ask the Blog answers that it is resting. Every call is recorded (seo_llm_usage,
  metrics, spans) with the cost LiteLLM reported (`x-litellm-response-cost`; a stream reports none).
- **One key per caller**: LITELLM_API_KEY for the agent, LITELLM_ASK_API_KEY for Ask the Blog (readers can start it,
  so it gets its own budget; the agent's key when unset). The web app's own calls use their own keys.
- **Not configured** (no LITELLM_BASE_URL or LITELLM_API_KEY): the service starts, and every model call fails at once
  with LlmNotConfigured. There is no fallback to a provider.

Requests: system text as content blocks with `cache_control` on the last one (LiteLLM keeps Anthropic's prompt caching;
other providers ignore it), images as data URLs, structured output as `response_format` json_schema validated here
with one repair. Retries: timeouts, connection errors, 408/409/429/5xx, twice, with backoff. No key, prompt or answer
ever goes into an error, a log line or a repr.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .llm import PROVIDER, BudgetExceeded, CallSpec, InvalidOutput, Refused, Truncated, Usage, UsageCallback, UsageLedger, book_call, estimated_usage

log = logging.getLogger("seo_agent.llm_gateway")

T = TypeVar("T", bound=BaseModel)

RETRY_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504})
MAX_RETRIES = 2
MAX_REPAIR_CHARS = 2000
DEFAULT_ALIAS = "cms-claude-sonnet-latest"
FAST_ALIAS = "ops-claude-haiku-latest"
NOT_CONFIGURED = "LiteLLM is not configured: set LITELLM_BASE_URL and LITELLM_API_KEY (Secret seo-agent-env). Every model call goes through LiteLLM."


@dataclass(frozen=True)
class Gateway:
    """Where LiteLLM is and which key each caller uses. Keys stay in this object: never in a message or a repr."""

    base_url: str = ""  # …/v1
    api_key: str = field(default="", repr=False)
    ask_api_key: str = field(default="", repr=False)
    model_default: str = DEFAULT_ALIAS
    model_fast: str = FAST_ALIAS
    timeout_s: float = 120.0

    @classmethod
    def from_settings(cls, s: Any) -> Gateway:
        return cls(
            base_url=str(getattr(s, "litellm_base_url", "") or "").rstrip("/"),
            api_key=str(getattr(s, "litellm_api_key", "") or ""),
            ask_api_key=str(getattr(s, "litellm_ask_api_key", "") or ""),
            model_default=str(getattr(s, "llm_model", "") or DEFAULT_ALIAS),
            model_fast=str(getattr(s, "llm_model_fast", "") or FAST_ALIAS),
            timeout_s=float(getattr(s, "llm_timeout_s", 120.0) or 120.0),
        )

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    def key_for(self, purpose: str) -> str:
        """Ask the Blog's own key for its calls (its own budget in LiteLLM), the agent's key for everything else."""
        return self.ask_api_key if purpose.startswith("ask") and self.ask_api_key else self.api_key

    def model_for(self, model: str) -> str:
        """The alias LiteLLM is asked for: the name as it is, the default alias when none is given."""
        return (model or "").strip() or self.model_default

    def headers(self, key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    @property
    def root(self) -> str:
        """LiteLLM's own routes (/key/info, /team/info) are at the root, not under /v1."""
        return self.base_url[:-3] if self.base_url.endswith("/v1") else self.base_url


class GatewayError(Exception):
    """LiteLLM could not be reached, or refused the request for a reason other than a budget. Never holds the key or
    the prompt: LiteLLM's own message and code only."""

    def __init__(self, message: str, status: int | None = None, code: str | None = None, retryable: bool = False):
        super().__init__(message)
        self.status, self.code, self.retryable = status, code, retryable


class LlmNotConfigured(GatewayError):
    """LITELLM_BASE_URL or LITELLM_API_KEY is not set: no model call can be made."""

    def __init__(self) -> None:
        super().__init__(NOT_CONFIGURED, code="not_configured")


def _error_of(status: int, body: Any) -> tuple[str, str | None]:
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        msg = err.get("message")
        code = err.get("type") or err.get("code")
        return (str(msg)[:400] if isinstance(msg, str) else f"HTTP {status}"), (str(code)[:80] if code else None)
    if isinstance(body, dict) and isinstance(body.get("detail"), str):
        return str(body["detail"])[:400], None
    return f"HTTP {status}", None


def budget_refusal(status: int, body: Any, purpose: str) -> BudgetExceeded | None:
    """LiteLLM's answer to a call over a budget (HTTP 422 or 400, error.type budget_exceeded), as BudgetExceeded: the
    key's own budget ("Key=…") or the team's ("Team=…"). Anything else: None."""
    msg, code = _error_of(status, body)
    if code != "budget_exceeded" and "budget has been exceeded" not in msg.lower():
        return None
    whose = "team" if "Team=" in msg else "key"
    caller = "Ask the Blog's key" if purpose.startswith("ask") and whose == "key" else ("the jithendar.com team" if whose == "team" else "the agent's key")
    spent = msg.split("Current cost:", 1)[1].strip() if "Current cost:" in msg else ""
    return BudgetExceeded(
        f"litellm_{whose}",
        f"LiteLLM refused the call: the budget of {caller} is used up" + (f" ({spent})" if spent else "") + ". Raise it or wait for its reset in LiteLLM (https://jithendar.com/llm/ui → Teams / Virtual Keys).",
    )


def _problems(e: ValidationError) -> str:
    return "\n".join(f"- {'.'.join(str(p) for p in err['loc']) or 'root'}: {err['msg']}" for err in e.errors(include_input=False)[:15])


def _strip_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def _answered(headers: httpx.Headers | dict[str, str], requested: str) -> str:
    """The model that answered, from LiteLLM's x-litellm-model-name ("anthropic/claude-haiku-5-5" → "claude-haiku-5-5"):
    the alias's current target, which is what a usage row should name."""
    name = headers.get("x-litellm-model-name") if headers else None
    return name.split("/", 1)[-1] if isinstance(name, str) and name else requested


def _cost_of(headers: httpx.Headers | dict[str, str]) -> float | None:
    """What LiteLLM charged for the call (x-litellm-response-cost); None when it did not say."""
    raw = headers.get("x-litellm-response-cost") if headers else None
    try:
        return float(raw) if raw not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _usage_of(raw: dict[str, Any] | None, model: str, started: float, request_id: str | None, cost: float | None) -> Usage:
    """OpenAI-shaped usage → this service's Usage. prompt_tokens includes cached tokens; LiteLLM reports cache reads as
    prompt_tokens_details.cached_tokens (and cache_read_input_tokens) and cache writes as cache_creation_input_tokens."""
    u: dict[str, Any] = raw or {}
    pd = u.get("prompt_tokens_details")
    details: dict[str, Any] = pd if isinstance(pd, dict) else {}
    prompt = int(u.get("prompt_tokens") or 0)
    read = int(details.get("cached_tokens") or u.get("cache_read_input_tokens") or 0)
    write = int(u.get("cache_creation_input_tokens") or details.get("cache_creation_tokens") or 0)
    return Usage(
        model=model,
        input_tokens=max(0, prompt - read - write),
        output_tokens=int(u.get("completion_tokens") or 0),
        cache_read_tokens=read,
        cache_write_tokens=write,
        request_id=request_id,
        latency_ms=int((time.monotonic() - started) * 1000),
        provider=PROVIDER,
        cost=cost,
    )


class GatewayLlm:
    """The service's Llm (app/llm.py): LiteLLM's Chat Completions API, every call recorded through the ledger.

    Every call that reached a model is booked exactly once (usage row, metrics, `llm.call` span), whatever its ending:
    ok | invalid | truncated (finish_reason length → Truncated) | refused (content_filter → Refused) | cancelled (a
    stream closed early, with estimated token counts). A call LiteLLM refused (budget, model not allowed, provider
    down) made no tokens and is not booked."""

    def __init__(self, gateway: Gateway, ledger: UsageLedger, client: httpx.AsyncClient | None = None, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self.gw = gateway
        self.ledger = ledger
        self.client = client or httpx.AsyncClient(timeout=gateway.timeout_s)
        self.sleep = sleep

    async def aclose(self) -> None:
        await self.client.aclose()

    # --- Requests -----------------------------------------------------------------------------------------------

    def _body(self, spec: CallSpec, *, user: str | None = None, extra_system: str | None = None, response_format: dict[str, Any] | None = None, stream: bool = False) -> dict[str, Any]:
        blocks: list[dict[str, Any]] = [{"type": "text", "text": t} for t in spec.cached_system if t]
        if blocks:
            blocks[-1]["cache_control"] = {"type": "ephemeral"}  # one breakpoint after the stable prefix
        if extra_system:
            blocks.append({"type": "text", "text": extra_system})
        text = spec.user if user is None else user
        content: Any = text
        if spec.images:
            content = [*({"type": "image_url", "image_url": {"url": f"data:{mt};base64,{base64.b64encode(b).decode()}"}} for mt, b in spec.images), {"type": "text", "text": text}]
        messages: list[dict[str, Any]] = ([{"role": "system", "content": blocks}] if blocks else []) + [{"role": "user", "content": content}]
        body: dict[str, Any] = {"model": self.gw.model_for(spec.model), "messages": messages, "max_tokens": spec.max_tokens}
        if response_format is not None:
            body["response_format"] = response_format
        if stream:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}
        # LiteLLM attributes the call in its own logs (no prompt text): what it is for and which run made it.
        body["metadata"] = {"purpose": spec.purpose, "prompt_version": spec.prompt_version, **({"run_id": spec.run_id} if spec.run_id else {})}
        return body

    def _check_configured(self) -> None:
        if not self.gw.configured:
            raise LlmNotConfigured()

    def _raise_for(self, status: int, parsed: Any, purpose: str) -> GatewayError:
        refusal = budget_refusal(status, parsed, purpose)
        if refusal is not None:
            raise refusal
        msg, code = _error_of(status, parsed)
        return GatewayError(f"LiteLLM: {msg} (HTTP {status}{f' {code}' if code else ''})", status=status, code=code, retryable=status in RETRY_STATUS)

    async def _post(self, spec: CallSpec, body: dict[str, Any]) -> httpx.Response:
        self._check_configured()
        last: GatewayError | None = None
        for attempt in range(MAX_RETRIES + 1):
            if attempt:
                await self.sleep(min(8.0, 0.5 * 2**attempt))
            try:
                res = await self.client.post(f"{self.gw.base_url}/chat/completions", headers=self.gw.headers(self.gw.key_for(spec.purpose)), json=body)
            except httpx.TimeoutException:
                last = GatewayError("LiteLLM did not answer in time", code="timeout", retryable=True)
                continue
            except httpx.HTTPError as e:
                last = GatewayError(f"LiteLLM could not be reached ({type(e).__name__})", code="connection", retryable=True)
                continue
            if res.status_code < 400:
                return res
            try:
                parsed: Any = res.json()
            except ValueError:
                parsed = None
            last = self._raise_for(res.status_code, parsed, spec.purpose)
            if not last.retryable:
                break
        assert last is not None
        raise last

    async def _complete(self, spec: CallSpec, body: dict[str, Any]) -> tuple[str, str | None, Usage]:
        started = time.monotonic()
        res = await self._post(spec, body)
        try:
            data = res.json()
            choice = data["choices"][0]
            content = choice["message"].get("content")
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
            raise GatewayError("LiteLLM's answer was not a chat completion", status=res.status_code, code="bad_response") from e
        rid = res.headers.get("x-litellm-call-id") or (data.get("id") if isinstance(data.get("id"), str) else None)
        usage = _usage_of(data.get("usage") if isinstance(data.get("usage"), dict) else None, _answered(res.headers, body["model"]), started, rid, _cost_of(res.headers))
        finish = choice.get("finish_reason") if isinstance(choice.get("finish_reason"), str) else None
        return (content if isinstance(content, str) else ""), finish, usage

    # --- The Llm protocol -------------------------------------------------------------------------------------------

    async def _ending(self, spec: CallSpec, finish: str | None, usage: Usage, started_ns: int) -> None:
        if finish == "content_filter":
            await book_call(self.ledger, spec, usage, started_ns, "refused", "refusal")
            raise Refused("the model declined this request")
        if finish == "length":
            await book_call(self.ledger, spec, usage, started_ns, "truncated", "max_tokens")
            raise Truncated(f"output cut off at max_tokens={spec.max_tokens}", usage)

    async def text(self, spec: CallSpec) -> tuple[str, Usage]:
        started_ns = time.time_ns()
        text, finish, usage = await self._complete(spec, self._body(spec))
        await self._ending(spec, finish, usage, started_ns)
        await book_call(self.ledger, spec, usage, started_ns)
        return text, usage

    async def structured(self, spec: CallSpec, schema: type[T]) -> tuple[T, Usage]:
        """json_schema response format (LiteLLM translates it for each provider), validated here; one repair request
        with the validation problems, then InvalidOutput. Each call is booked on its own."""
        fmt = {"type": "json_schema", "json_schema": {"name": schema.__name__[:64], "strict": False, "schema": schema.model_json_schema()}}
        hint = "Answer with one JSON object that follows the requested schema, and nothing else."
        prompt = spec.user
        problems = ""
        last: Usage | None = None
        for _ in range(2):
            started_ns = time.time_ns()
            text, finish, usage = await self._complete(spec, self._body(spec, user=prompt, extra_system=hint, response_format=fmt))
            last = usage
            await self._ending(spec, finish, usage, started_ns)
            try:
                value = schema.model_validate_json(_strip_fence(text))
            except ValidationError as e:
                problems = _problems(e)
                await book_call(self.ledger, spec, usage, started_ns, "invalid", "schema")
                prompt = (f"{spec.user}\n\nYour previous answer was rejected by the validator:\n{problems[:MAX_REPAIR_CHARS]}\n\n" f"Your previous answer was:\n{text[:MAX_REPAIR_CHARS]}\n\nAnswer again with the complete JSON object, fixing every problem.")
                continue
            await book_call(self.ledger, spec, usage, started_ns)
            return value, usage
        raise InvalidOutput(f"invalid output after one repair:\n{problems[:900]}", last)

    async def stream(self, spec: CallSpec, *, on_usage: UsageCallback | None = None) -> AsyncIterator[str]:
        """Yields text deltas; usage from LiteLLM's final chunk (stream_options.include_usage). A stream carries no
        cost header, so its row has no cost unless LiteLLM sent one. Booked once in every ending."""
        self._check_configured()
        started, started_ns = time.monotonic(), time.time_ns()
        body = self._body(spec, stream=True)
        streamed_chars = 0
        booked = False
        finish: str | None = None
        raw_usage: dict[str, Any] | None = None
        answered = body["model"]
        rid: str | None = None
        cost: float | None = None
        try:
            async with self.client.stream("POST", f"{self.gw.base_url}/chat/completions", headers=self.gw.headers(self.gw.key_for(spec.purpose)), json=body) as res:
                if res.status_code >= 400:
                    raw = await res.aread()
                    try:
                        parsed: Any = json.loads(raw)
                    except ValueError:
                        parsed = None
                    booked = True  # refused before any token: nothing to book
                    raise self._raise_for(res.status_code, parsed, spec.purpose)
                answered = _answered(res.headers, body["model"])
                rid = res.headers.get("x-litellm-call-id")
                cost = _cost_of(res.headers)
                async for line in res.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        continue
                    if isinstance(chunk.get("usage"), dict):
                        raw_usage = chunk["usage"]
                    for ch in chunk.get("choices") or []:
                        if isinstance(ch, dict):
                            if isinstance(ch.get("finish_reason"), str):
                                finish = ch["finish_reason"]
                            delta = (ch.get("delta") or {}).get("content") if isinstance(ch.get("delta"), dict) else None
                            if isinstance(delta, str) and delta:
                                streamed_chars += len(delta)
                                yield delta
            if raw_usage is not None:
                usage = _usage_of(raw_usage, answered, started, rid, cost)
            else:
                usage = estimated_usage(spec, started, streamed_chars)
                usage.model, usage.request_id, usage.cost = answered, rid, cost
            booked = True
            if on_usage:
                on_usage(usage)
            await self._ending(spec, finish, usage, started_ns)
            await book_call(self.ledger, spec, usage, started_ns)
        finally:
            if not booked:
                est = estimated_usage(spec, started, streamed_chars)
                est.model, est.request_id = answered, rid
                if on_usage:
                    on_usage(est)
                await asyncio.shield(book_call(self.ledger, spec, est, started_ns, "cancelled", "stream_closed"))


# --- What the admin sees ---------------------------------------------------------------------------------------------


async def list_aliases(gw: Gateway, client: httpx.AsyncClient | None = None) -> list[str] | None:
    """The model aliases the agent's key may use (GET /v1/models), or None when LiteLLM is not configured or did not
    answer. For the crew editor's model choices: names only."""
    if not gw.configured:
        return None
    own = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    try:
        res = await http.get(f"{gw.base_url}/models", headers=gw.headers(gw.api_key))
        data = res.json().get("data") if res.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        data = None
    finally:
        if own:
            await http.aclose()
    if not isinstance(data, list):
        return None
    return sorted({str(m["id"]) for m in data if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"]})


async def gateway_status(gw: Gateway, client: httpx.AsyncClient | None = None, now: Callable[[], datetime] | None = None) -> dict[str, Any]:
    """GET /llm-status: is LiteLLM configured and reachable with the agent's key, which aliases it uses, and LiteLLM's
    view of the agent's keys and their team (spend, budget, reset, limits; read with the keys themselves). LiteLLM
    writes spend to its database in batches, so a total can trail the last calls by up to a minute. Never a key."""
    checked = (now or (lambda: datetime.now(UTC)))().isoformat()
    out: dict[str, Any] = {"gateway": "litellm", "configured": gw.configured, "base_url": gw.base_url or None, "aliases": {"default": gw.model_default, "fast": gw.model_fast}, "healthy": None, "checked_at": checked, "keys": [], "team": None, "models": [], "errors": []}
    if not gw.configured:
        out["errors"].append(NOT_CONFIGURED)
        return out
    own = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    try:
        names: list[str] = []
        try:
            res = await http.get(f"{gw.base_url}/models", headers=gw.headers(gw.api_key))
            out["healthy"] = res.status_code == 200
            data = res.json().get("data") if res.status_code == 200 else None
            names = sorted({str(m["id"]) for m in data if isinstance(m, dict) and isinstance(m.get("id"), str)}) if isinstance(data, list) else []
            if res.status_code != 200:
                out["errors"].append(f"LiteLLM refused the agent's key (HTTP {res.status_code})")
        except (httpx.HTTPError, ValueError, AttributeError) as e:
            out["healthy"] = False
            out["errors"].append(f"LiteLLM could not be reached ({type(e).__name__})")
        team_id: str | None = None
        callers = [("agent", gw.api_key)] + ([("ask", gw.ask_api_key)] if gw.ask_api_key else [])
        for caller, key in callers:
            try:
                res = await http.get(f"{gw.root}/key/info", headers=gw.headers(key))
                info = res.json().get("info") if res.status_code == 200 else None
            except (httpx.HTTPError, ValueError, AttributeError):
                info = None
            if not isinstance(info, dict):
                out["errors"].append(f"LiteLLM did not describe the {caller} key")
                continue
            team_id = team_id or info.get("team_id")
            out["keys"].append(
                {
                    "caller": caller,
                    "alias": info.get("key_alias"),
                    "spend_usd": info.get("spend"),
                    "max_budget_usd": info.get("max_budget"),
                    "budget_duration": info.get("budget_duration"),
                    "budget_reset_at": info.get("budget_reset_at"),
                    "models": info.get("models") or [],
                    "tpm_limit": info.get("tpm_limit"),
                    "rpm_limit": info.get("rpm_limit"),
                }
            )
        if team_id:
            try:
                res = await http.get(f"{gw.root}/team/info", params={"team_id": team_id}, headers=gw.headers(gw.api_key))
                t = res.json().get("team_info") if res.status_code == 200 else None
            except (httpx.HTTPError, ValueError, AttributeError):
                t = None
            if isinstance(t, dict):
                out["team"] = {"alias": t.get("team_alias"), "spend_usd": t.get("spend"), "max_budget_usd": t.get("max_budget"), "budget_duration": t.get("budget_duration"), "budget_reset_at": t.get("budget_reset_at"), "models": t.get("models") or []}
        targets: dict[str, str | None] = {}
        if out["healthy"]:
            try:
                res = await http.get(f"{gw.base_url}/model/info", headers=gw.headers(gw.api_key))
                data = res.json().get("data") if res.status_code == 200 else None
            except (httpx.HTTPError, ValueError, AttributeError):
                data = None
            for m in data if isinstance(data, list) else []:
                if isinstance(m, dict) and isinstance(m.get("model_name"), str):
                    lp = m.get("litellm_params")
                    target = lp.get("model") if isinstance(lp, dict) else None
                    targets.setdefault(m["model_name"], target if isinstance(target, str) else None)
        out["models"] = [{"name": n, "target": targets.get(n)} for n in (names or sorted(targets))]
    finally:
        if own:
            await http.aclose()
    return out
