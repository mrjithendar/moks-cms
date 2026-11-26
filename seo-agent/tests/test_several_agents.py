"""Several agents on one database (D-105: one agent container in every site pod). Two run managers share one run store
and one set of locks, as two agents share seo_flow_runs and Postgres advisory locks (app/runs.py module docstring)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

from app.main import memory_container
from app.runs import ORPHAN_ERROR, ORPHAN_STALE_MARGIN_S, FlowRunner
from tests.conftest import ARTICLE, DRAFT, FakeOptimizationCrew, FakeWebApp, settings

OPT = {"article_id": ARTICLE, "draft_id": DRAFT}


def two_agents(llm: Any, web: FakeWebApp, gate: asyncio.Event) -> tuple[Any, FlowRunner]:
    class Slow(FakeOptimizationCrew):
        async def run(self, context: Any, **kw: Any) -> Any:
            await gate.wait()
            return await super().run(context, **kw)

    a = memory_container(settings(), llm=llm, web=web, optimization_crew=lambda: Slow())
    b = memory_container(settings(), llm=llm, web=web).runner
    b.store, b.locks = a.runner.store, a.runner.locks  # the shared table and the shared advisory locks
    return a, b


def orphan(store: Any, run_id: str, *, age_s: float, target: str = DRAFT) -> None:
    store.rows[run_id] = {
        "run_id": run_id, "flow_name": "optimize_article_flow", "target_id": target, "draft_id": target, "status": "running",
        "inputs": OPT, "triggered_by": "manual", "started_at": datetime.now(UTC) - timedelta(seconds=age_s), "error": None,
    }


async def test_a_run_another_agent_is_running_is_never_swept(llm, web) -> None:
    gate = asyncio.Event()
    a, b = two_agents(llm, web, gate)
    r = await a.runner.kickoff("optimize_article_flow", OPT)
    await asyncio.sleep(0.05)
    assert await b.recover(grace_s=0) == []  # its lock is held by agent a
    assert (await a.store.get(r["run_id"]))["status"] == "running"
    gate.set()
    assert (await a.runner.wait(r["run_id"], 10))["status"] == "succeeded"


async def test_the_orphan_of_a_gone_agent_is_failed_by_any_agent_but_not_while_it_is_young(llm, web) -> None:
    a, b = two_agents(llm, web, asyncio.Event())
    orphan(a.store, "young", age_s=1, target="t-young")
    orphan(a.store, "old", age_s=120, target="t-old")
    assert await b.recover() == ["old"]  # "young" may be a kickoff that has not taken its lock yet
    assert a.store.rows["old"]["status"] == "failed" and a.store.rows["old"]["error"] == ORPHAN_ERROR
    assert a.store.rows["young"]["status"] == "running"
    assert await a.runner.recover() == []  # swept once: the other agent finds nothing left
    assert b.locks.held == set()  # the lock taken for the update is released


async def test_a_row_older_than_the_wall_clock_limit_is_swept_even_with_its_lock_held(llm, web) -> None:
    a, b = two_agents(llm, web, asyncio.Event())
    orphan(a.store, "stale", age_s=b.timeout_s + ORPHAN_STALE_MARGIN_S + 5)
    await b.locks.acquire(FlowRunner.lock_key("optimize_article_flow", DRAFT))  # a dead node's connection still holds it
    assert await b.recover() == ["stale"]


async def test_a_cancel_that_reaches_another_agent_stops_the_run_where_it_runs(llm, web) -> None:
    gate = asyncio.Event()
    a, b = two_agents(llm, web, gate)
    r = await a.runner.kickoff("optimize_article_flow", OPT)
    await asyncio.sleep(0.05)
    task = a.runner.tasks[r["run_id"]]
    assert (await b.cancel(r["run_id"]))["status"] == "cancelled"  # b has no task for it: it records the end
    assert await a.runner.stop_runs_ended_elsewhere() == [r["run_id"]]
    await asyncio.gather(task, return_exceptions=True)
    row = await a.store.get(r["run_id"])
    assert row["status"] == "cancelled" and row["error"] == "cancelled"  # b's status, not written over by a
    assert a.runner.locks.held == set() and a.runner.tasks == {}
    assert web.drafts.get(DRAFT, {}).get("status") != "ready_for_review"


async def test_a_run_finishing_here_is_not_taken_for_one_ended_elsewhere(llm, web) -> None:
    gate = asyncio.Event()
    a, _ = two_agents(llm, web, gate)
    r = await a.runner.kickoff("optimize_article_flow", OPT)
    await asyncio.sleep(0.05)
    a.runner._finishing.add(r["run_id"])  # its end is being recorded here: the row may already be terminal
    await a.store.update(r["run_id"], status="succeeded")
    assert await a.runner.stop_runs_ended_elsewhere() == []
    assert not a.runner.tasks[r["run_id"]].done()
    a.runner._finishing.discard(r["run_id"])
    gate.set()
    await a.runner.wait(r["run_id"], 10)


async def test_waiting_on_another_agents_run_follows_its_row(llm, web) -> None:
    gate = asyncio.Event()
    a, b = two_agents(llm, web, gate)
    r = await a.runner.kickoff("optimize_article_flow", OPT)
    waiting = asyncio.create_task(b.wait(r["run_id"], 10))
    await asyncio.sleep(0.05)
    assert not waiting.done()
    gate.set()
    assert (await waiting)["status"] == "succeeded"
    assert (await b.wait(r["run_id"], 0))["status"] == "succeeded"  # an ended run returns at once


async def test_maintain_forever_sweeps_and_stops_runs(llm, web) -> None:
    gate = asyncio.Event()
    a, b = two_agents(llm, web, gate)
    orphan(a.store, "old", age_s=120, target="t-old")
    r = await a.runner.kickoff("optimize_article_flow", OPT)
    loop = asyncio.create_task(a.runner.maintain_forever(watch_every_s=0.01, sweep_every_s=0.01))
    try:
        await asyncio.sleep(0.05)
        assert a.store.rows["old"]["status"] == "failed"
        await b.cancel(r["run_id"])
        for _ in range(100):
            if not a.runner.tasks:
                break
            await asyncio.sleep(0.01)
        assert a.runner.tasks == {} and (await a.store.get(r["run_id"]))["status"] == "cancelled"
    finally:
        loop.cancel()
        await asyncio.gather(loop, return_exceptions=True)
