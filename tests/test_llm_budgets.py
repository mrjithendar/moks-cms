"""LLM budgets, owned by the seo-agent (app/llm_budgets.py): an optional daily and monthly limit per model and per
provider, stored in the agent's own table, set through GET/PUT /llm-budgets (the web app's Admin → Automation & AI →
LLM budgets card is a thin client), and checked by BudgetGuard before every call, for every purpose."""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.llm import BudgetExceeded, BudgetGuard, MemorySpendStore
from app.llm_budgets import NO_LIMITS, TABLE, BudgetsIn, Limit, LlmLimits, MemoryBudgets, PgBudgets, overview, parse_legacy
from app.main import create_app, memory_container
from tests.conftest import FakeLlm, FakeWebApp, settings
from tests.moks_cms import www

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"
AUTH = {"Authorization": "Bearer " + "t" * 40}


def guard(limits: LlmLimits, rows: list[dict] | None = None, monthly: float = 1000, ask_daily: float = 1000) -> BudgetGuard:
    return BudgetGuard(MemorySpendStore(rows=list(rows or [])), monthly, ask_daily, clock=lambda: NOW, limits=MemoryBudgets(limits))


def row(model: str, usd: float, purpose: str = "draft", at: datetime = NOW) -> dict:
    return {"model": model, "purpose": purpose, "cost_usd": usd, "at": at}


# --- Validation ------------------------------------------------------------------------------------------------------


def test_the_whole_set_is_validated_and_an_empty_limit_is_no_limit() -> None:
    b = BudgetsIn.model_validate({"models": {SONNET: {"monthly_usd": 20}, HAIKU: {}}, "providers": {"anthropic": {"daily_usd": 2, "monthly_usd": None}}, "actor": "admin"})
    assert b.limits() == LlmLimits({SONNET: Limit(None, 20.0)}, {"anthropic": Limit(2.0, None)})  # nothing kept without a limit
    for bad in ({"models": {"bad model!": {"daily_usd": 1}}}, {"models": {SONNET: {"daily_usd": -1}}}, {"providers": {"Anthropic": {"daily_usd": 1}}},
                {"models": {SONNET: {"weekly_usd": 1}}}, {"models": {SONNET: {"daily_usd": float("inf")}}}, {"other": {}}):
        with pytest.raises(ValidationError):
            BudgetsIn.model_validate(bad)


def test_the_web_apps_earlier_document_is_read_tolerantly() -> None:
    lims = parse_legacy({"models": {SONNET: {"dailyUsd": None, "monthlyUsd": 20}, "bad!": {"dailyUsd": 1}}, "providers": {"anthropic": {"dailyUsd": 2, "monthlyUsd": -5}}})
    assert lims == LlmLimits({SONNET: Limit(None, 20.0)}, {"anthropic": Limit(2.0, None)})
    assert parse_legacy(None) == NO_LIMITS and parse_legacy({"models": "x"}) == NO_LIMITS and parse_legacy("{not json") == NO_LIMITS


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
    await guard(lims, rows).ensure(SONNET, 3500, 1000, "draft")  # $4 used, ~$0.01 more fits
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
    g = guard(LlmLimits(providers={"anthropic": Limit(None, 10.0)}), [row(SONNET, 6), row(HAIKU, 3.995)])
    with pytest.raises(BudgetExceeded) as e:
        await g.ensure("claude-opus-5-5", 3500, 1000, "draft")
    assert e.value.scope == "llm_provider_monthly" and "total for all anthropic models" in e.value.detail


async def test_calls_in_flight_count_until_they_are_booked() -> None:
    g = guard(LlmLimits(models={SONNET: Limit(None, 0.03)}))
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


async def test_the_overview_adds_up_spend_and_forecasts_the_month() -> None:
    store = MemorySpendStore(rows=[row(SONNET, 3), row(SONNET, 1, "news.writer", datetime(2026, 11, 2, tzinfo=UTC)), row(HAIKU, 1, "ask.answer"),
                                   row(SONNET, 50, "draft", datetime(2026, 10, 30, tzinfo=UTC))])
    o = await overview(LlmLimits(providers={"anthropic": Limit(None, 30.0)}), store, NOW)
    assert o["budgets"] == {"models": {}, "providers": {"anthropic": {"daily_usd": None, "monthly_usd": 30.0}}}
    sonnet = next(m for m in o["models"] if m["model"] == SONNET)
    assert sonnet == {"model": SONNET, "provider": "anthropic", "today_usd": 3.0, "month_usd": 4.0, "calls": 2, "purposes": ["draft", "news"]}
    [anthropic] = o["providers"]
    assert anthropic["month_usd"] == 5.0 and anthropic["forecast_usd"] == pytest.approx(5 / 19.5 * 30)
    assert (o["month_start"], o["month_resets_at"][:10]) == ("2026-11-01", "2026-12-01")


# --- The API ---------------------------------------------------------------------------------------------------------


def test_the_api_reads_and_replaces_the_set_and_the_guard_follows_it() -> None:
    llm = FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1))
    c = memory_container(settings(), llm=llm, web=FakeWebApp())
    with TestClient(create_app(c)) as client:
        assert client.get("/llm-budgets").status_code == 401
        empty = client.get("/llm-budgets", headers=AUTH).json()
        assert empty["budgets"] == {"models": {}, "providers": {}} and empty["providers"] == []  # nothing preset
        bad = client.put("/llm-budgets", headers=AUTH, json={"models": {SONNET: {"daily_usd": -1}}})
        assert bad.status_code == 422 and any(SONNET in i for i in bad.json()["issues"])
        ok = client.put("/llm-budgets", headers=AUTH, json={"models": {SONNET: {"daily_usd": None, "monthly_usd": 0}}, "providers": {"anthropic": {"monthly_usd": 30}}, "actor": "admin"})
        assert ok.status_code == 200
        assert ok.json()["budgets"] == {"models": {SONNET: {"daily_usd": None, "monthly_usd": 0.0}}, "providers": {"anthropic": {"daily_usd": None, "monthly_usd": 30.0}}}
        assert client.get("/llm-budgets", headers=AUTH).json()["budgets"] == ok.json()["budgets"]
    assert c.guard.limits is c.budgets
    cleared = memory_container(settings(), llm=llm, web=FakeWebApp())
    assert cleared.budgets is c.budgets  # one store per guard


async def test_a_saved_zero_budget_stops_the_model() -> None:
    llm = FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1))
    c = memory_container(settings(), llm=llm, web=FakeWebApp())
    await c.budgets.save(LlmLimits(models={SONNET: Limit(None, 0.0)}), "admin")
    with pytest.raises(BudgetExceeded):
        await c.guard.ensure(SONNET, 3500, 1000, "draft")
    await c.guard.ensure(HAIKU, 3500, 1000, "draft")


# --- The table (needs SEO_AGENT_TEST_DATABASE_URL) -----------------------------------------------------------------


@pytest.fixture
async def pool() -> AsyncIterator[Any]:
    url = os.environ.get("SEO_AGENT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("set SEO_AGENT_TEST_DATABASE_URL to run the Postgres tests")
    import psycopg
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    schema = f"b_{uuid.uuid4().hex[:10]}"
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as c:
        await c.execute(f"create schema {schema}")
        await c.execute(f"set search_path to {schema}")
        await c.execute("create table setting (key text primary key, value jsonb not null, updated_at timestamptz not null default now(), updated_by text)")
    p = AsyncConnectionPool(url, min_size=1, max_size=3, open=False, kwargs={"autocommit": True, "row_factory": dict_row, "options": f"-c search_path={schema}"})
    await p.open()
    try:
        yield p
    finally:
        await p.close()
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as c:
            await c.execute(f"drop schema {schema} cascade")


@pytest.mark.postgres
async def test_the_table_is_created_once_imports_the_web_apps_budgets_and_is_replaced_whole(pool: Any) -> None:
    async with pool.connection() as c:
        await c.execute("insert into setting (key, value) values ('llm_budgets', %s::jsonb)", ('{"models": {"claude-sonnet-5-5": {"dailyUsd": null, "monthlyUsd": 20}}, "providers": {}}',))
    store = PgBudgets(pool, ttl_s=0)
    await store.ensure_schema()
    assert await store.limits() == LlmLimits({SONNET: Limit(None, 20.0)}, {})
    await store.save(LlmLimits({}, {"anthropic": Limit(1.5, 30.0)}), "admin")
    assert await PgBudgets(pool, ttl_s=0).limits() == LlmLimits({}, {"anthropic": Limit(1.5, 30.0)})
    await store.save(NO_LIMITS, "admin")
    await PgBudgets(pool).ensure_schema()  # the table exists now: the old document is not imported again
    assert await PgBudgets(pool, ttl_s=0).limits() == NO_LIMITS
    async with pool.connection() as c:
        assert (await (await c.execute(f"select count(*)::int as n from {TABLE}")).fetchone())["n"] == 0  # noqa: S608 - constant name


async def test_an_outage_keeps_the_last_known_limits() -> None:
    class Pool:
        def __init__(self) -> None:
            self.rows: list[dict] = []
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

                async def execute(self, _sql, *_a):
                    pool.reads += 1

                    class Cur:
                        async def fetchall(self):
                            return pool.rows

                    return Cur()

            return Conn()

    pool = Pool()
    pool.fail = True
    src = PgBudgets(pool, ttl_s=0)
    assert await src.limits() == NO_LIMITS  # never read: no limits from here (the other caps still apply)
    pool.fail = False
    pool.rows = [{"kind": "model", "name": SONNET, "daily_usd": None, "monthly_usd": 20.0}]
    assert (await src.limits()).model(SONNET) == Limit(None, 20.0)
    pool.fail = True
    assert (await src.limits()).model(SONNET) == Limit(None, 20.0)  # an outage does not lift a limit
    cached = PgBudgets(pool, ttl_s=300)
    pool.fail = False
    before = pool.reads
    await cached.limits()
    await cached.limits()
    assert pool.reads == before + 1


# --- Contract with the web app -------------------------------------------------------------------------------------


def test_the_web_app_card_calls_this_api() -> None:
    client = www("src/lib/seo-agent/client.ts").read_text()
    assert '"/llm-budgets"' in client and "daily_usd" in client and "monthly_usd" in client
