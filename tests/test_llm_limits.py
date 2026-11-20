"""LLM budgets set in the web app (Admin → Automation & AI → LLM budgets, `setting` row "llm_budgets"): an optional
daily and monthly limit per model and per provider, checked by BudgetGuard before every call, for every purpose.
The web app's side is tested in moks-cms/tests/llm-budgets.test.ts."""

from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest

from app.llm import BudgetExceeded, BudgetGuard, MemorySpendStore
from app.llm_limits import NO_LIMITS, Limit, LlmLimits, PgLimits, StaticLimits, parse_limits
from tests.moks_cms import www

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"


def guard(limits: LlmLimits, rows: list[dict] | None = None, monthly: float = 1000, ask_daily: float = 1000) -> BudgetGuard:
    store = MemorySpendStore(rows=list(rows or []))
    return BudgetGuard(store, monthly, ask_daily, clock=lambda: NOW, limits=StaticLimits(limits))


def row(model: str, usd: float, purpose: str = "draft", at: datetime = NOW) -> dict:
    return {"model": model, "purpose": purpose, "cost_usd": usd, "at": at}


# --- The stored document -------------------------------------------------------------------------------------------


def test_parse_is_tolerant_and_an_empty_limit_is_no_limit() -> None:
    lims = parse_limits(
        {
            "models": {SONNET: {"dailyUsd": None, "monthlyUsd": 20}, HAIKU: {"dailyUsd": None, "monthlyUsd": None}, "bad model!": {"dailyUsd": 1}},
            "providers": {"anthropic": {"dailyUsd": 2, "monthlyUsd": -5}, "Bad": {"dailyUsd": 1}},
        }
    )
    assert lims.models == {SONNET: Limit(None, 20.0)}  # no entry without a limit, none with a bad id
    assert lims.providers == {"anthropic": Limit(2.0, None)}  # a negative limit is no limit, not a zero one
    assert parse_limits(None) == NO_LIMITS and parse_limits({"models": "x"}) == NO_LIMITS
    assert parse_limits({"models": {SONNET: {"monthlyUsd": True}}}) == NO_LIMITS  # a boolean is not a number


async def test_pg_limits_cache_and_keep_the_last_value_on_errors() -> None:
    class Pool:
        def __init__(self) -> None:
            self.row: dict | None = None
            self.fail = False
            self.reads = 0

        def connection(self):
            pool = self

            class Conn:
                async def __aenter__(self):
                    if pool.fail:
                        raise RuntimeError("database down")
                    return self

                async def __aexit__(self, *a):
                    return False

                async def execute(self, _sql, _args):
                    pool.reads += 1

                    class Cur:
                        async def fetchone(self):
                            return pool.row

                    return Cur()

            return Conn()

    pool = Pool()
    pool.fail = True
    src = PgLimits(pool, ttl_s=0)
    assert await src.limits() == NO_LIMITS  # never read: no limits from here (the other caps still apply)
    pool.fail = False
    assert await src.limits() == NO_LIMITS  # no row
    pool.row = {"value": {"models": {SONNET: {"dailyUsd": None, "monthlyUsd": 20}}}}
    assert (await src.limits()).model(SONNET) == Limit(None, 20.0)
    pool.fail = True
    assert (await src.limits()).model(SONNET) == Limit(None, 20.0)  # an outage does not lift a limit
    cached = PgLimits(pool, ttl_s=300)
    pool.fail = False
    before = pool.reads
    await cached.limits()
    await cached.limits()
    assert pool.reads == before + 1


# --- The guard -------------------------------------------------------------------------------------------------------


async def test_no_limits_change_nothing() -> None:
    g = guard(NO_LIMITS, [row(SONNET, 500)])
    await g.ensure(SONNET, 3500, 1000, "draft")
    async with g.reserve(SONNET, 3500, 1000, "news.writer") as r:
        assert r.released  # the news desk keeps its own caps only, as before
    assert g.pending_models == {}


async def test_a_models_monthly_budget_counts_every_purpose_this_month_only() -> None:
    lims = LlmLimits(models={SONNET: Limit(None, 5.0)})
    rows = [row(SONNET, 2, "draft"), row(SONNET, 2, "ask.answer"), row(SONNET, 50, "draft", datetime(2026, 10, 31, 23, 59, tzinfo=UTC)), row(HAIKU, 50)]
    g = guard(lims, rows)
    await g.ensure(SONNET, 3500, 1000, "draft")  # $4 used, ~$0.01 more fits
    rows.append(row(SONNET, 0.99, "news.writer"))
    g = guard(lims, rows)
    with pytest.raises(BudgetExceeded) as e:
        await g.ensure(SONNET, 3500, 1000, "news.writer")  # the news desk is held to it too
    assert e.value.scope == "llm_model_monthly"
    assert "The monthly budget of claude-sonnet-5-5 is reached: $4.99 of $5.00 used this month" in e.value.detail
    assert "2026-12-01 00:00 UTC" in e.value.detail and "Admin → Automation & AI → LLM budgets" in e.value.detail
    await g.ensure(HAIKU, 3500, 1000, "draft")  # another model is not limited by it


async def test_a_daily_budget_resets_with_the_utc_day() -> None:
    lims = LlmLimits(models={HAIKU: Limit(1.0, None)})
    with pytest.raises(BudgetExceeded) as e:
        await guard(lims, [row(HAIKU, 1.0, "ask.answer")]).ensure(HAIKU, 10, 10, "ask.answer")
    assert e.value.scope == "llm_model_daily" and "used today" in e.value.detail
    await guard(lims, [row(HAIKU, 1.0, "ask.answer", datetime(2026, 11, 19, 23, 59, tzinfo=UTC))]).ensure(HAIKU, 10, 10, "ask.answer")


async def test_the_provider_total_caps_all_models_together() -> None:
    lims = LlmLimits(providers={"anthropic": Limit(None, 10.0)})
    g = guard(lims, [row(SONNET, 6), row(HAIKU, 3.995)])
    with pytest.raises(BudgetExceeded) as e:
        await g.ensure("claude-opus-5-5", 3500, 1000, "draft")
    assert e.value.scope == "llm_provider_monthly" and "total for all anthropic models" in e.value.detail


async def test_calls_in_flight_count_until_they_are_booked() -> None:
    lims = LlmLimits(models={SONNET: Limit(None, 0.03)})
    g = guard(lims)
    async with g.reserve(SONNET, 3500, 1000, "draft"):  # ~$0.012 held
        async with g.reserve(SONNET, 3500, 1000, "draft"):  # ~$0.024 held
            with pytest.raises(BudgetExceeded):
                await g.ensure(SONNET, 3500, 1000, "draft")
        assert g.pending_models[SONNET] == pytest.approx(0.012)
    assert g.pending_models == {}
    await g.ensure(SONNET, 3500, 1000, "draft")


async def test_the_existing_caps_still_apply_alongside() -> None:
    g = guard(LlmLimits(models={SONNET: Limit(None, 1000.0)}), monthly=0.005)
    with pytest.raises(BudgetExceeded) as e:
        await g.ensure(SONNET, 3500, 1000, "draft")
    assert e.value.scope == "monthly"


# --- Contract with the web app -------------------------------------------------------------------------------------


def test_the_web_app_stores_the_document_this_parses() -> None:
    src = www("src/lib/llm-budgets.ts").read_text()
    assert re.search(r'LLM_BUDGETS_KEY = "llm_budgets"', src)
    for name in ("models", "providers", "dailyUsd", "monthlyUsd"):
        assert name in src, name
