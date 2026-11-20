"""LLM budgets set in the web app (Admin → Automation & AI → LLM budgets): an optional daily and monthly limit for
each model, and for each provider (all of its models together, e.g. the credit on the Anthropic account).

The web app stores one JSON document in the `setting` table (key "llm_budgets", moks-cms/src/lib/llm-budgets.ts):

    {"models": {"claude-sonnet-5-5": {"dailyUsd": null, "monthlyUsd": 20}}, "providers": {"anthropic": {...}}}

A missing or null limit is no limit; nothing is preset. Both sides count every Claude call in seo_llm_usage (drafts,
flows, Ask the Blog, the news desk) plus legacy batches in flight, by UTC day and month; app/llm.py BudgetGuard checks
these before each call, on top of the monthly admin cap and the feature caps.

This reads the row, cached for a short time, so a change applies without a restart. No row, an invalid one, or a
database error before anything was ever read all mean no limits here: the other caps still apply, and the provider's
own spend limit is the hard stop. After a successful read, a later database error keeps the last known limits (an
outage must not lift a limit that was set).
"""

from __future__ import annotations

import logging
import math
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

log = logging.getLogger("seo-agent.llm-limits")

KEY = "llm_budgets"
MAX_USD = 100_000.0
_MODEL = re.compile(r"^[A-Za-z0-9._:\-/@]{1,120}$")
_PROVIDER = re.compile(r"^[a-z0-9_-]{2,40}$")


@dataclass(frozen=True)
class Limit:
    daily_usd: float | None = None
    monthly_usd: float | None = None

    @property
    def empty(self) -> bool:
        return self.daily_usd is None and self.monthly_usd is None


@dataclass(frozen=True)
class LlmLimits:
    models: dict[str, Limit] = field(default_factory=dict)
    providers: dict[str, Limit] = field(default_factory=dict)

    def model(self, name: str) -> Limit | None:
        return self.models.get(name)

    def provider(self, name: str) -> Limit | None:
        return self.providers.get(name)


NO_LIMITS = LlmLimits()


def _usd(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 or v > MAX_USD:
        return None
    return float(v)


def _entries(value: Any, key: re.Pattern[str]) -> dict[str, Limit]:
    out: dict[str, Limit] = {}
    if not isinstance(value, dict):
        return out
    for name, entry in value.items():
        if not isinstance(name, str) or not key.fullmatch(name) or not isinstance(entry, dict):
            continue
        lim = Limit(_usd(entry.get("dailyUsd")), _usd(entry.get("monthlyUsd")))
        if not lim.empty:
            out[name] = lim
    return out


def parse_limits(value: Any) -> LlmLimits:
    """The stored document → limits. Tolerant on purpose: this service does not own the schema, so anything missing or
    of the wrong type is no limit for that field only."""
    if not isinstance(value, dict):
        return NO_LIMITS
    return LlmLimits(_entries(value.get("models"), _MODEL), _entries(value.get("providers"), _PROVIDER))


class LimitsSource(Protocol):
    async def limits(self) -> LlmLimits: ...


@dataclass
class StaticLimits:
    """Fixed limits: tests, and the in-memory mode without a database."""

    value: LlmLimits = NO_LIMITS

    async def limits(self) -> LlmLimits:
        return self.value


class PgLimits:
    def __init__(self, pool: Any, ttl_s: float = 30.0):
        self.pool, self.ttl = pool, ttl_s
        self._at = 0.0
        self._value: LlmLimits | None = None

    async def limits(self) -> LlmLimits:
        now = time.monotonic()
        if self._value is not None and now - self._at < self.ttl:
            return self._value
        try:
            async with self.pool.connection() as c:
                cur = await c.execute("select value from setting where key = %s", (KEY,))
                row = await cur.fetchone()
            self._value = parse_limits(row["value"] if row else None)
        except Exception:
            log.warning("could not read the LLM budgets; keeping the last known ones", exc_info=True)
            if self._value is None:
                return NO_LIMITS  # never read successfully: no limits from here, and try again on the next call
        self._at = now
        return self._value
