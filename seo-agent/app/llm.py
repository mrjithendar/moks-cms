"""Model calls for every flow step and crew: the call types, usage recording, and the test model.

Every chat model call of this service goes through LiteLLM (D-110, app/llm_gateway.py): LiteLLM chooses the provider
and model behind each alias, holds the provider keys, and enforces the budgets (its team and virtual keys). Nothing
here prices a call or limits spend:

- Each call writes one row to the web app's `seo_llm_usage` table (provider `litellm`) with the tokens and the cost
  LiteLLM reported for it (`x-litellm-response-cost`; none for a stream, which carries no cost header). Flow runs add
  those costs up for their own record (seo_flow_runs.cost_usd).
- A call LiteLLM refuses over a budget raises BudgetExceeded (the flow run moves to paused_budget; Ask the Blog
  answers that it is resting).
- Stable system text (rules, style guide) is sent as cached system blocks (cache_control ephemeral).
- Tests inject FakeLlm: deterministic structured answers per purpose, with fake token counts and a fake reported cost.
"""

from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

from . import metrics, tracing

T = TypeVar("T", bound=BaseModel)

PROVIDER = "litellm"  # seo_llm_usage.provider: every call goes through LiteLLM


@dataclass
class Usage:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    request_id: str | None = None
    latency_ms: int | None = None
    provider: str = PROVIDER
    # What LiteLLM charged for this call (its x-litellm-response-cost). None: not reported (a stream, a fake).
    cost: float | None = None

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens

    def cost_usd(self) -> float:
        """The cost LiteLLM reported, or 0 when it reported none. Never computed here."""
        return max(0.0, self.cost) if self.cost is not None and math.isfinite(self.cost) else 0.0


class BudgetExceeded(Exception):
    """LiteLLM refused the call: a budget (its key's or its team's) is used up. Also raised for the content flows'
    image caps (app/news/budget.py) and when a run's LLM calls are switched off."""

    def __init__(self, scope: str, detail: str):
        super().__init__(detail)
        self.scope = scope
        self.detail = detail


class TokenCapExceeded(Exception):
    """A per-run token cap (CREW_MAX_TOKENS_PER_RUN) was reached."""


class InvalidOutput(Exception):
    def __init__(self, detail: str, usage: Usage | None = None):
        super().__init__(detail)
        self.usage = usage


class Truncated(InvalidOutput):
    """finish_reason == "length": the answer was cut off. A subclass of InvalidOutput, so every existing handler
    treats a truncated answer like an unusable one instead of shipping half a text."""


class Refused(Exception):
    """The model declined the request (finish_reason content_filter)."""


# --- Usage records (shared table seo_llm_usage) ---------------------------------------------------------------------


class SpendStore(Protocol):
    async def record(self, row: dict[str, Any]) -> None: ...


class PgSpendStore:
    def __init__(self, pool: Any):
        self.pool = pool

    _attribution: bool | None = None  # seo_llm_usage has run_id/agent (web app migration 0022); checked once

    async def _has_attribution(self, c: Any) -> bool:
        """The web app owns the table and may be deployed after this service: write run_id/agent only once its
        migration has added them, so an older schema never fails a model call."""
        if self._attribution is None:
            cur = await c.execute(
                "select count(*)::int as n from information_schema.columns where table_name = 'seo_llm_usage' and column_name in ('run_id', 'agent')"
            )
            self._attribution = int((await cur.fetchone())["n"]) == 2
        return self._attribution

    async def record(self, row: dict[str, Any]) -> None:
        draft_id = row.get("draft_id")
        async with self.pool.connection() as c:
            extra_cols, extra_vals = ("", "")
            if await self._has_attribution(c):
                extra_cols, extra_vals = (", run_id, agent", ", %(run_id)s, %(agent)s")
            await c.execute(
                f"""insert into seo_llm_usage (provider, model, purpose, prompt_version, mode, request_id, input_tokens,
                     output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, outcome, error_code, draft_id{extra_cols})
                   values (%(provider)s, %(model)s, %(purpose)s, %(prompt_version)s, 'sync', %(request_id)s, %(input_tokens)s,
                     %(output_tokens)s, %(cache_read_tokens)s, %(cache_write_tokens)s, %(cost_usd)s, %(latency_ms)s,
                     %(outcome)s, %(error_code)s,
                     (select id from seo_drafts where id::text = %(draft_id)s){extra_vals})""",  # noqa: S608 - constant column lists
                {**row, "provider": row.get("provider") or PROVIDER, "draft_id": draft_id, "run_id": row.get("run_id"), "agent": row.get("agent")},
            )


@dataclass
class MemorySpendStore:
    rows: list[dict[str, Any]] = field(default_factory=list)

    async def record(self, row: dict[str, Any]) -> None:
        self.rows.append(row)


class UsageLedger:
    """Records every model call: one seo_llm_usage row and the Prometheus counters. No limits: LiteLLM holds the
    budgets and refuses a call over one (BudgetExceeded)."""

    def __init__(self, store: SpendStore, clock: Callable[[], datetime] | None = None):
        self.store = store
        self.clock = clock or (lambda: datetime.now(UTC))

    async def record(
        self,
        usage: Usage,
        purpose: str,
        prompt_version: str,
        outcome: str = "ok",
        error_code: str | None = None,
        draft_id: str | None = None,
        *,
        run_id: str | None = None,
        agent: str | None = None,
    ) -> float:
        cost = usage.cost_usd()
        await self.store.record({"provider": usage.provider, "model": usage.model, "purpose": purpose, "prompt_version": prompt_version, "request_id": usage.request_id, "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens, "cache_read_tokens": usage.cache_read_tokens, "cache_write_tokens": usage.cache_write_tokens, "cost_usd": cost, "latency_ms": usage.latency_ms, "outcome": outcome, "error_code": error_code, "draft_id": draft_id, "run_id": run_id, "agent": agent})
        metrics.LLM_TOKENS.labels(model=usage.model, purpose=metrics.purpose_label(purpose)).inc(usage.total_tokens)
        metrics.LLM_COST.labels(purpose=metrics.purpose_label(purpose)).inc(cost)
        metrics.LLM_CALLS.labels(purpose=metrics.purpose_label(purpose), outcome=metrics.llm_outcome_label(outcome)).inc()
        return cost


# --- Calls ----------------------------------------------------------------------------------------------------------


@dataclass
class CallSpec:
    # A LiteLLM model alias (e.g. cms-claude-sonnet-latest). Which provider and model answer is set in LiteLLM.
    model: str
    purpose: str
    prompt_version: str
    cached_system: list[str]
    user: str
    max_tokens: int = 4096
    draft_id: str | None = None
    run_id: str | None = None  # the flow run this call belongs to (seo_flow_runs.run_id), for usage attribution
    agent: str | None = None  # the crew agent key (e.g. "writer") that made the call
    # News desk: images for a vision check (media type, bytes), sent before the text. Alt text is written by a model
    # looking at the final image, never from the generation prompt (docs/news/IMAGES.md).
    images: list[tuple[str, bytes]] = field(default_factory=list)

    @property
    def input_chars(self) -> int:
        # An image counts as roughly 1,000 tokens (a 1200×630 image is about (w × h) / 750 tokens).
        return len(self.user) + sum(len(s) for s in self.cached_system) + 3500 * len(self.images)


UsageCallback = Callable[[Usage], None]


class Llm(Protocol):
    async def structured(self, spec: CallSpec, schema: type[T]) -> tuple[T, Usage]: ...
    async def text(self, spec: CallSpec) -> tuple[str, Usage]: ...
    def stream(self, spec: CallSpec) -> AsyncIterator[str]: ...


class UsageReportingLlm(Llm, Protocol):
    """GatewayLlm and FakeLlm: `stream(spec, on_usage=cb)` calls `cb` once with the recorded usage when the stream
    ends (also on a refusal, a truncation or a client disconnect), so a caller can add the streamed step to its own
    record (Ask the Blog). Wrappers that only implement Llm (NewsLlm) do not take it."""

    def stream(self, spec: CallSpec, *, on_usage: UsageCallback | None = None) -> AsyncIterator[str]: ...


def estimated_usage(spec: CallSpec, started: float, output_chars: int | None = None) -> Usage:
    """Token counts when LiteLLM's own are not available (a stream closed early or ended without a usage chunk):
    input chars / 3.5, output the streamed chars / 3.5 (or max_tokens when nothing is known), never more than
    max_tokens. Tokens only: the cost is LiteLLM's, never estimated here."""
    out = spec.max_tokens if output_chars is None else min(spec.max_tokens, math.ceil(output_chars * 2 / 7))
    return Usage(model=spec.model, input_tokens=math.ceil(spec.input_chars * 2 / 7), output_tokens=out, latency_ms=int((time.monotonic() - started) * 1000))


def _attribution(spec: CallSpec) -> dict[str, str | None]:
    # run_id / agent are optional CallSpec fields (flows and crews set them); older specs simply lack them.
    return {"run_id": getattr(spec, "run_id", None), "agent": getattr(spec, "agent", None)}


async def book_call(ledger: UsageLedger, spec: CallSpec, usage: Usage, started_ns: int, outcome: str = "ok", error_code: str | None = None) -> float:
    """Book one model call exactly once: a seo_llm_usage row (UsageLedger.record), Prometheus, and one `llm.call` span."""
    attrs = _attribution(spec)
    cost = await ledger.record(usage, spec.purpose, spec.prompt_version, outcome, error_code, spec.draft_id, run_id=attrs["run_id"], agent=attrs["agent"])
    tracing.emit_span(
        "llm.call",
        start_ns=started_ns,
        attrs={
            "llm.model": usage.model,
            "llm.requested_model": spec.model,
            "llm.purpose": spec.purpose,
            "llm.prompt_version": spec.prompt_version,
            "llm.input_tokens": usage.input_tokens,
            "llm.output_tokens": usage.output_tokens,
            "llm.cache_read_tokens": usage.cache_read_tokens,
            "llm.cache_write_tokens": usage.cache_write_tokens,
            "llm.cost_usd": round(cost, 6),
            "llm.outcome": outcome,
            **({"llm.error_code": error_code} if error_code else {}),
            **{f"llm.{k}": v for k, v in attrs.items() if v},
        },
        error=None if outcome == "ok" else outcome,
    )
    return cost


class FakeLlm:
    """Deterministic model for tests: answers are queued per purpose (BaseModel instances, dicts, str or exceptions).

    Every call is recorded through the UsageLedger like a real one, with `tokens` and `cost` (what LiteLLM would have
    reported for the call; the fake's own number, nothing is priced)."""

    def __init__(self, ledger: UsageLedger, answers: dict[str, list[Any]] | None = None, tokens: tuple[int, int] = (1200, 300), cost: float | None = 0.0054):
        self.ledger = ledger
        self.answers: dict[str, deque[Any]] = {k: deque(v) for k, v in (answers or {}).items()}
        self.tokens = tokens
        self.cost = cost
        self.calls: list[CallSpec] = []

    def queue(self, purpose: str, *items: Any) -> None:
        self.answers.setdefault(purpose, deque()).extend(items)

    def _next(self, spec: CallSpec) -> Any:
        q = self.answers.get(spec.purpose)
        if not q:
            raise AssertionError(f"FakeLlm: no answer queued for purpose {spec.purpose!r}")
        item = q.popleft()
        if isinstance(item, Exception):
            raise item
        return item(spec) if callable(item) and not isinstance(item, type) else item

    def _usage(self, spec: CallSpec) -> Usage:
        return Usage(spec.model, input_tokens=self.tokens[0], output_tokens=self.tokens[1], request_id=f"fake_{len(self.calls)}", cost=self.cost)

    async def structured(self, spec: CallSpec, schema: type[T]) -> tuple[T, Usage]:
        self.calls.append(spec)
        usage = self._usage(spec)
        item = self._next(spec)
        try:
            value = item if isinstance(item, schema) else schema.model_validate(item)
        except Exception as e:
            await self.ledger.record(usage, spec.purpose, spec.prompt_version, "invalid", "schema", spec.draft_id, run_id=getattr(spec, "run_id", None), agent=getattr(spec, "agent", None))
            raise InvalidOutput(str(e), usage) from e
        await self.ledger.record(usage, spec.purpose, spec.prompt_version, draft_id=spec.draft_id, run_id=getattr(spec, "run_id", None), agent=getattr(spec, "agent", None))
        return value, usage

    async def text(self, spec: CallSpec) -> tuple[str, Usage]:
        self.calls.append(spec)
        usage = self._usage(spec)
        out = str(self._next(spec))
        await self.ledger.record(usage, spec.purpose, spec.prompt_version, run_id=getattr(spec, "run_id", None), agent=getattr(spec, "agent", None))
        return out, usage

    async def stream(self, spec: CallSpec, *, on_usage: UsageCallback | None = None) -> AsyncIterator[str]:
        text, usage = await self.text(spec)
        if on_usage:
            on_usage(usage)
        for word in text.split(" "):
            yield word + " "
