"""The one LLM budget, owned by the seo-agent (app/llm_budgets.py): an optional daily and an optional monthly limit
for everything together, stored in the agent's own table, set through GET/PUT /llm-budget, enforced by BudgetGuard
before every call of every purpose, and held against by outside callers through /llm-budget/reserve and /settle."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import llm as llm_module
from app.llm import BudgetExceeded, BudgetGuard, MemorySpendStore, estimate_cost_usd, used_up
from app.llm_budgets import LEGACY_TABLE, NO_BUDGET, TABLE, Budget, BudgetIn, MemoryBudget, PgBudget, overview
from app.main import create_app, memory_container
from tests.conftest import FakeLlm, FakeWebApp, settings
from tests.moks_cms import www

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
YESTERDAY = datetime(2026, 11, 19, 12, 0, tzinfo=UTC)
LAST_MONTH = datetime(2026, 10, 31, 23, 0, tzinfo=UTC)
SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"
AUTH = {"Authorization": "Bearer " + "t" * 40}


def guard(budget: Budget, rows: list[dict] | None = None, ask_daily: float = 1000) -> BudgetGuard:
    return BudgetGuard(MemorySpendStore(rows=list(rows or [])), None, ask_daily, clock=lambda: NOW, budget=MemoryBudget(budget))


def row(model: str, usd: float, purpose: str = "draft", at: datetime = NOW) -> dict:
    return {"model": model, "purpose": purpose, "cost_usd": usd, "at": at}


# --- Validation ------------------------------------------------------------------------------------------------------


def test_both_limits_are_optional_and_a_bad_one_is_refused() -> None:
    assert BudgetIn.model_validate({}).budget() == NO_BUDGET and NO_BUDGET.empty  # nothing preset
    b = BudgetIn.model_validate({"daily_usd": 2, "monthly_usd": None, "actor": "admin"})
    assert b.budget() == Budget(2.0, None) and b.budget().limit("day") == 2.0 and b.budget().limit("month") is None
    assert BudgetIn.model_validate({"monthly_usd": 0}).budget() == Budget(None, 0.0)  # 0 is a limit: nothing may be spent
    for bad in ({"daily_usd": -1}, {"monthly_usd": 1e9}, {"daily_usd": "2"}, {"monthly_usd": float("nan")}, {"models": {}}, {"actor": "x" * 300}):
        with pytest.raises(ValidationError):
            BudgetIn.model_validate(bad, strict=True)


# --- Enforcement -----------------------------------------------------------------------------------------------------


async def test_without_a_budget_nothing_is_limited() -> None:
    g = guard(NO_BUDGET, [row(SONNET, 500)])
    await g.ensure(SONNET, 3500, 1000, "draft")
    async with g.reserve(SONNET, 3500, 1000, "news_draft"):
        assert g.pending["total"] > 0
    assert g.pending == {"total": 0.0, "ask_daily": 0.0}
    assert not used_up(await g.status())


async def test_the_monthly_limit_counts_every_model_and_every_purpose_together() -> None:
    spent = [row(SONNET, 4), row(HAIKU, 3, "news_draft"), row(HAIKU, 2.9999, "ask_answer"), row(SONNET, 50, at=LAST_MONTH)]
    g = guard(Budget(None, 10.0), spent)
    for model, purpose in ((SONNET, "draft"), (HAIKU, "news_classify"), (HAIKU, "ask_answer"), (SONNET, "report")):
        with pytest.raises(BudgetExceeded) as e:
            await g.ensure(model, 3500, 1000, purpose)
        assert e.value.scope == "llm_monthly", purpose
    assert "$10.00 of $10.00 used this month" in e.value.detail and "could cost up to" in e.value.detail and "It resets 2026-12-01 00:00 UTC" in e.value.detail
    assert "Admin → Settings → AI & models → LLM providers & budget" in e.value.detail
    await guard(Budget(None, 10.0), [row(SONNET, 4), row(SONNET, 50, at=LAST_MONTH)]).ensure(
        SONNET, 3500, 1000, "draft"
    )  # last month's spend is not this month's


async def test_the_daily_limit_is_by_utc_day_and_both_limits_apply() -> None:
    g = guard(Budget(1.0, 100.0), [row(SONNET, 0.9999), row(SONNET, 20, at=YESTERDAY)])
    with pytest.raises(BudgetExceeded) as e:
        await g.ensure(HAIKU, 3500, 1000, "draft")
    assert e.value.scope == "llm_daily" and "It resets 2026-11-21 00:00 UTC" in e.value.detail
    await guard(Budget(1.0, 100.0), [row(SONNET, 20, at=YESTERDAY)]).ensure(HAIKU, 3500, 1000, "draft")  # yesterday is over
    with pytest.raises(BudgetExceeded) as e:
        await guard(Budget(50.0, 20.0), [row(SONNET, 19.9999, at=YESTERDAY)]).ensure(HAIKU, 3500, 1000, "draft")
    assert e.value.scope == "llm_monthly"


async def test_a_zero_budget_stops_every_call_and_a_reached_one_says_so() -> None:
    with pytest.raises(BudgetExceeded):
        await guard(Budget(None, 0.0)).ensure(HAIKU, 10, 10, "ask_answer")
    g = guard(Budget(5.0, None), [row(SONNET, 5)])
    with pytest.raises(BudgetExceeded) as e:
        await g.ensure(HAIKU, 10, 10, "draft")
    assert "could cost up to" not in e.value.detail  # already reached: the call's own cost is beside the point
    assert used_up(await g.status())


async def test_calls_in_flight_count_so_concurrent_calls_cannot_all_pass() -> None:
    est = estimate_cost_usd(SONNET, 3500, 1000)
    g = guard(Budget(None, est * 2.5))  # room for two in-flight estimates, not three
    gate = asyncio.Event()

    async def call(purpose: str) -> str:
        try:
            async with g.reserve(SONNET, 3500, 1000, purpose):
                await gate.wait()
                return "ok"
        except BudgetExceeded:
            return "blocked"

    tasks = [asyncio.create_task(call(p)) for p in ("draft", "news_draft", "ask_answer")]  # different purposes, one budget
    await asyncio.sleep(0.01)
    gate.set()
    assert sorted(await asyncio.gather(*tasks)) == ["blocked", "ok", "ok"]
    assert g.pending == {"total": pytest.approx(0), "ask_daily": pytest.approx(0)}


async def test_ask_the_blog_keeps_its_own_daily_limit_on_top() -> None:
    g = guard(Budget(None, 1000.0), [row(HAIKU, 1.0, "ask_answer")], ask_daily=1.0)
    with pytest.raises(BudgetExceeded) as e:
        await g.ensure(HAIKU, 100, 100, "ask_answer")
    assert e.value.scope == "ask_daily"
    await g.ensure(HAIKU, 100, 100, "draft")  # readers reaching their limit does not stop the admin's work
    async with g.reserve(HAIKU, 100, 100, "draft"):
        assert g.pending["ask_daily"] == 0 and g.pending["total"] > 0


# --- Holds for callers outside this process ---------------------------------------------------------------------------


async def test_a_hold_counts_until_it_is_settled() -> None:
    g = guard(Budget(None, 1.0))
    first = await g.hold(0.6, "ai_visibility")
    assert g.pending["total"] == pytest.approx(0.6)
    with pytest.raises(BudgetExceeded):
        await g.hold(0.6, "practice_hint")
    with pytest.raises(BudgetExceeded):
        await g.ensure(SONNET, 350_000, 100_000, "draft")  # the agent's own calls see the web app's hold
    assert g.settle(first) is True and g.pending["total"] == pytest.approx(0)
    assert g.settle(first) is False and g.settle("0" * 32) is False  # settling twice, or an unknown id, changes nothing
    await g.hold(0.6, "practice_hint")


async def test_a_hold_that_is_never_settled_lapses() -> None:
    clock = {"t": 1000.0}
    g = guard(Budget(None, 1.0))
    g.monotonic = lambda: clock["t"]
    key = await g.hold(0.9, "ai_visibility")
    with pytest.raises(BudgetExceeded):
        await g.hold(0.9, "ai_visibility")
    clock["t"] += llm_module.HOLD_SECONDS + 1
    await g.hold(0.9, "ai_visibility")  # the forgotten hold no longer counts
    assert key not in g.holds and len(g.holds) == 1


async def test_holds_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_module, "MAX_HOLDS", 3)
    g = guard(NO_BUDGET)
    for _ in range(3):
        await g.hold(0.01, "ai_visibility")
    with pytest.raises(BudgetExceeded) as e:
        await g.hold(0.01, "ai_visibility")
    assert e.value.scope == "llm_holds"


# --- The overview ------------------------------------------------------------------------------------------------------


async def test_the_overview_reports_one_period_with_breakdowns_and_the_other_in_one_line() -> None:
    store = MemorySpendStore(
        rows=[
            row(SONNET, 4),
            row(SONNET, 1, at=YESTERDAY),
            row(HAIKU, 0.5, "news_draft"),
            row(HAIKU, 0.25, "news_classify", at=YESTERDAY),
            row(SONNET, 99, at=LAST_MONTH),
        ]
    )
    month = await overview(Budget(2.0, 30.0), store, NOW, "month", pending_usd=1.0)
    assert (month["scope"], month["spent_usd"], month["limit_usd"], month["remaining_usd"], month["pending_usd"]) == ("month", 5.75, 30.0, 23.25, 1.0)
    assert month["forecast_usd"] == pytest.approx(5.75 / 19.5 * 30) and month["resets_at"][:10] == "2026-12-01" and month["period_start"][:10] == "2026-11-01"
    assert month["by_provider"] == [{"provider": "anthropic", "usd": 5.75, "calls": 4}]
    assert month["by_model"] == [
        {"provider": "anthropic", "model": SONNET, "usd": 5.0, "calls": 2},
        {"provider": "anthropic", "model": HAIKU, "usd": 0.75, "calls": 2},
    ]
    assert month["by_purpose"] == [
        {"purpose": "draft", "usd": 5.0, "calls": 2},
        {"purpose": "news_draft", "usd": 0.5, "calls": 1},
        {"purpose": "news_classify", "usd": 0.25, "calls": 1},
    ]
    assert month["other"] == {"scope": "day", "spent_usd": 4.5, "limit_usd": 2.0, "resets_at": "2026-11-21T00:00:00+00:00"}
    day = await overview(Budget(2.0, 30.0), store, NOW, "day")
    assert (day["spent_usd"], day["limit_usd"], day["remaining_usd"], day["forecast_usd"]) == (4.5, 2.0, 0.0, None)  # over: nothing remains, never negative
    assert day["other"]["scope"] == "month" and day["other"]["spent_usd"] == 5.75
    none = await overview(NO_BUDGET, store, NOW, "day")
    assert none["limit_usd"] is None and none["remaining_usd"] is None and none["budget"] == {"daily_usd": None, "monthly_usd": None}


# --- The API ---------------------------------------------------------------------------------------------------------


def _app() -> tuple[TestClient, Any]:
    llm = FakeLlm(BudgetGuard(MemorySpendStore(), None, 1))
    c = memory_container(settings(), llm=llm, web=FakeWebApp())
    return TestClient(create_app(c)), c


def test_the_api_reads_and_saves_the_budget_and_the_guard_follows_it() -> None:
    client, c = _app()
    with client:
        assert client.get("/llm-budget").status_code == 401 and client.put("/llm-budget", json={}).status_code == 401
        empty = client.get("/llm-budget", headers=AUTH).json()
        assert empty["budget"] == {"daily_usd": None, "monthly_usd": None} and empty["scope"] == "month"  # nothing preset
        assert empty["legacy_limits"] == {"models": {}, "providers": {}} and empty["ask_daily"] == {"limit_usd": 1, "spent_usd": 0}
        assert client.get("/llm-budget?scope=day", headers=AUTH).json()["scope"] == "day"
        assert client.get("/llm-budget?scope=week", headers=AUTH).status_code == 422
        bad = client.put("/llm-budget", headers=AUTH, json={"daily_usd": -1})
        assert bad.status_code == 422 and any("daily_usd" in i for i in bad.json()["issues"])
        assert client.put("/llm-budget", headers=AUTH, json={"models": {SONNET: {"monthly_usd": 5}}}).status_code == 422  # the earlier shape
        ok = client.put("/llm-budget", headers=AUTH, json={"daily_usd": None, "monthly_usd": 30, "actor": "admin"})
        assert ok.status_code == 200 and ok.json() == {"budget": {"daily_usd": None, "monthly_usd": 30.0}}
        assert client.get("/llm-budget", headers=AUTH).json()["limit_usd"] == 30.0
        assert client.get("/budget", headers=AUTH).json()["monthly_budget_usd"] == 30.0
    assert c.guard.budget is c.budgets  # one store: the guard reads what the API saves


async def test_a_saved_zero_budget_stops_every_model() -> None:
    _, c = _app()
    await c.guard.ensure(SONNET, 3500, 1000, "draft")
    await c.budgets.save(Budget(None, 0.0), "admin")
    for model in (SONNET, HAIKU):
        with pytest.raises(BudgetExceeded):
            await c.guard.ensure(model, 3500, 1000, "draft")


def test_the_api_holds_and_settles_for_the_web_app() -> None:
    client, c = _app()
    with client:
        assert client.post("/llm-budget/reserve", json={"max_usd": 1, "purpose": "ai_visibility"}).status_code == 401
        client.put("/llm-budget", headers=AUTH, json={"monthly_usd": 1})
        held = client.post("/llm-budget/reserve", headers=AUTH, json={"max_usd": 0.75, "purpose": "ai_visibility"})
        assert held.status_code == 200 and len(held.json()["id"]) == 32
        assert client.get("/llm-budget", headers=AUTH).json()["pending_usd"] == 0.75
        over = client.post("/llm-budget/reserve", headers=AUTH, json={"max_usd": 0.75, "purpose": "practice_hint"})
        assert over.status_code == 402 and over.json()["scope"] == "llm_monthly" and "monthly LLM budget is reached" in over.json()["error"]
        assert client.post("/llm-budget/settle", headers=AUTH, json={"id": held.json()["id"]}).json() == {"released": True}
        assert client.post("/llm-budget/settle", headers=AUTH, json={"id": held.json()["id"]}).json() == {"released": False}
        assert c.guard.pending["total"] == 0
        for bad in (
            {"max_usd": -1, "purpose": "x_y"},
            {"max_usd": "1", "purpose": "x_y"},
            {"max_usd": 1},
            {"max_usd": 1, "purpose": "Not A Purpose"},
            {"max_usd": 5000, "purpose": "x_y"},
            [1],
        ):
            assert client.post("/llm-budget/reserve", headers=AUTH, json=bad).status_code == 422, bad
        for bad in ({}, {"id": "nope"}, {"id": 7}):
            assert client.post("/llm-budget/settle", headers=AUTH, json=bad).status_code == 422


def test_an_older_web_app_still_reads_spend_and_is_told_the_limits_moved() -> None:
    client, _ = _app()
    with client:
        old = client.get("/llm-budgets", headers=AUTH)
        assert old.status_code == 200 and old.json()["budgets"] == {"models": {}, "providers": {}} and old.json()["replaced_by"] == "/llm-budget"
        assert {"month_start", "day_resets_at", "month_resets_at", "models", "providers"} <= set(old.json())
        put = client.put("/llm-budgets", headers=AUTH, json={"models": {SONNET: {"monthly_usd": 5}}, "providers": {}})
        assert put.status_code == 409 and "one LLM budget" in put.json()["error"]


def test_no_monthly_cap_comes_from_the_environment_any_more() -> None:
    from app.config import Settings, load_settings

    assert not hasattr(Settings, "monthly_budget_usd")
    assert load_settings({"SEO_LLM_MONTHLY_BUDGET_USD": "15"}) == load_settings({})  # set or not, it limits nothing


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
    p = AsyncConnectionPool(
        url, min_size=1, max_size=3, open=False, kwargs={"autocommit": True, "row_factory": dict_row, "options": f"-c search_path={schema}"}
    )
    await p.open()
    try:
        yield p
    finally:
        await p.close()
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as c:
            await c.execute(f"drop schema {schema} cascade")


@pytest.mark.postgres
async def test_the_table_holds_one_budget_and_starts_empty(pool: Any) -> None:
    store = PgBudget(pool, ttl_s=0)
    await store.ensure_schema()
    await store.ensure_schema()
    assert await store.budget() == NO_BUDGET  # nothing preset
    await store.save(Budget(1.5, 30.0), "admin")
    assert await PgBudget(pool, ttl_s=0).budget() == Budget(1.5, 30.0)
    await store.save(Budget(None, 12.0), "other")
    assert await PgBudget(pool, ttl_s=0).budget() == Budget(None, 12.0)
    async with pool.connection() as c:
        rows = await (await c.execute(f"select daily_usd, monthly_usd, updated_by from {TABLE}")).fetchall()  # noqa: S608 - constant name
    assert rows == [{"daily_usd": None, "monthly_usd": 12.0, "updated_by": "other"}]
    await store.save(NO_BUDGET, "admin")
    assert await PgBudget(pool, ttl_s=0).budget() == NO_BUDGET


@pytest.mark.postgres
async def test_earlier_per_model_limits_stay_readable_and_are_not_turned_into_a_budget(pool: Any) -> None:
    store = PgBudget(pool, ttl_s=0)
    assert await store.legacy() == {"models": {}, "providers": {}}  # no such table: nothing to show
    async with pool.connection() as c:
        await c.execute(
            f"create table {LEGACY_TABLE} (kind text not null, name text not null, daily_usd double precision, monthly_usd double precision, primary key (kind, name))"
        )
        insert = f"insert into {LEGACY_TABLE} values ('model', %s, null, 20), ('provider', 'anthropic', 1.5, 30), ('model', %s, null, null)"  # noqa: S608 - constant name
        await c.execute(insert, (SONNET, HAIKU))
    await store.ensure_schema()
    assert await store.legacy() == {
        "models": {SONNET: {"daily_usd": None, "monthly_usd": 20.0}},
        "providers": {"anthropic": {"daily_usd": 1.5, "monthly_usd": 30.0}},
    }
    assert await store.budget() == NO_BUDGET  # the owner decides the one budget; nothing adds the old limits up
    async with pool.connection() as c:
        assert (await (await c.execute(f"select count(*)::int as n from {LEGACY_TABLE}")).fetchone())["n"] == 3  # noqa: S608 - left in place


@pytest.mark.postgres
async def test_spend_is_broken_down_by_provider_model_and_purpose(pool: Any) -> None:
    from app.llm import PgSpendStore

    async with pool.connection() as c:
        await c.execute(
            "create table seo_llm_usage (provider text, model text, purpose text, cost_usd double precision, at timestamptz not null default now())"
        )
        await c.execute("create table seo_llm_batches (model text, estimated_cost_usd double precision, status text)")
        await c.execute(
            "insert into seo_llm_usage (provider, model, purpose, cost_usd, at) values"
            " ('anthropic', %s, 'draft.rewrite', 4, %s), ('anthropic', %s, 'draft.outline', 1, %s), ('openai', 'gpt-x', 'ai_visibility', 0.5, %s), ('anthropic', %s, 'draft', 99, %s)",
            (SONNET, NOW, SONNET, NOW, NOW, SONNET, LAST_MONTH),
        )
        await c.execute("insert into seo_llm_batches values (%s, 0.25, 'in_progress'), (%s, 9, 'ended')", (HAIKU, HAIKU))
    store = PgSpendStore(pool)
    rows = sorted(await store.llm_spend_breakdown(datetime(2026, 11, 1, tzinfo=UTC)), key=lambda r: -r["usd"])
    assert rows == [
        {"provider": "anthropic", "model": SONNET, "purpose": "draft", "usd": 5.0, "calls": 2},
        {"provider": "openai", "model": "gpt-x", "purpose": "ai_visibility", "usd": 0.5, "calls": 1},
        {"provider": "anthropic", "model": HAIKU, "purpose": "batch", "usd": 0.25, "calls": 1},
    ]
    assert await store.llm_spend(datetime(2026, 11, 1, tzinfo=UTC)) == pytest.approx(5.75)  # every provider, and batches in flight
    o = await overview(Budget(None, 10.0), store, NOW, "month")
    assert [p["provider"] for p in o["by_provider"]] == ["anthropic", "openai"] and o["spent_usd"] == 5.75 and o["remaining_usd"] == 4.25


async def test_an_outage_keeps_the_last_known_budget() -> None:
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

                async def execute(self, _sql, *_a):
                    pool.reads += 1

                    class Cur:
                        async def fetchone(self):
                            return pool.row

                    return Cur()

            return Conn()

    pool = Pool()
    pool.fail = True
    src = PgBudget(pool, ttl_s=0)
    assert await src.budget() == NO_BUDGET  # never read: no limit from here (the provider's own limit is the stop)
    pool.fail = False
    pool.row = {"daily_usd": None, "monthly_usd": 20.0}
    assert await src.budget() == Budget(None, 20.0)
    pool.fail = True
    assert await src.budget() == Budget(None, 20.0)  # an outage does not lift a limit
    cached = PgBudget(pool, ttl_s=300)
    pool.fail = False
    before = pool.reads
    await cached.budget()
    await cached.budget()
    assert pool.reads == before + 1


# --- Contract with the web app -------------------------------------------------------------------------------------


def test_the_web_app_calls_this_api() -> None:
    client = www("src/lib/seo-agent/client.ts").read_text()
    assert "daily_usd" in client and "monthly_usd" in client and ("/llm-budget" in client)
