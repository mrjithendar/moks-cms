"""Sharing with the news agent (mrjithendar/newsroom): it writes the same seo_flow_runs and seo_flow_schedules tables, so
this service touches only its own flows' rows; and its token reaches only /search and the LLM budget's holds."""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.flows import CRON_FLOWS, OWNED_FLOWS
from app.llm import FakeLlm
from app.main import create_app, memory_container
from app.runs import MemoryRunStore, RunError
from app.schedules import MemoryScheduleStore, dispatch
from tests.conftest import FakeWebApp, MemoryRetriever, hits, settings

SERVICE = "t" * 40
NEWS = "n" * 40


def news_row(status: str = "running") -> dict[str, Any]:
    return {"run_id": str(uuid.uuid4()), "flow_name": "news_job_flow", "target_id": "job:1", "status": status, "inputs": {}, "triggered_by": "cron"}


async def test_a_restart_fails_only_this_services_runs() -> None:
    store = MemoryRunStore(flows=OWNED_FLOWS)
    theirs = await store.create(news_row())
    mine = await store.create({"run_id": str(uuid.uuid4()), "flow_name": "gsc_sync_flow", "target_id": "site", "status": "running", "inputs": {}, "triggered_by": "cron"})
    assert [r["run_id"] for r in await store.sweep_orphans()] == [mine["run_id"]]
    assert store.rows[theirs["run_id"]]["status"] == "running"
    assert await store.list_runs() == [store.rows[mine["run_id"]]] and await store.list_runs(flow="news_job_flow") == []
    assert await store.get(theirs["run_id"]) is None and await store.count_status("running") == 0


async def test_the_news_agents_runs_cannot_be_cancelled_or_read_here(llm: FakeLlm, web: FakeWebApp) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    theirs = await c.store.create(news_row())
    with pytest.raises(RunError) as e:
        await c.runner.cancel(theirs["run_id"])
    assert e.value.status == 404 and c.store.rows[theirs["run_id"]]["status"] == "running"


async def test_the_dispatcher_leaves_the_news_agents_schedules_unclaimed() -> None:
    class Runner:
        def __init__(self) -> None:
            self.started: list[str] = []

        async def kickoff(self, name: str, inputs: dict[str, Any], **_: Any) -> dict[str, Any]:
            self.started.append(name)
            return {"run_id": str(uuid.uuid4())}

    now = datetime(2026, 11, 23, 6, 0, 20, tzinfo=UTC)
    store, runner = MemoryScheduleStore(), Runner()
    news = store.add(name="news-dispatch", flow_name="news_dispatch_flow", cron="*/15 * * * *")
    store.add(name="gsc-sync", flow_name="gsc_sync_flow", cron="0 6 * * *")
    out = await dispatch(store, runner, schedulable=CRON_FLOWS, served=OWNED_FLOWS, now=now)
    assert runner.started == ["gsc_sync_flow"] and out["skipped"] == 1 and out["errors"] == []
    assert store.rows[news["id"]]["last_slot"] is None and store.rows[news["id"]]["last_status"] is None
    # Before this change the row was claimed and marked failed ("cannot be scheduled"); the news agent never ran it.
    assert not any(f["schedule"] == "news-dispatch" for f in out["fired"])


def client(llm: FakeLlm, web: FakeWebApp, news_token: str = NEWS) -> TestClient:
    c = memory_container(replace(settings(), news_token=news_token), llm=llm, web=web, retriever=MemoryRetriever(hits()))
    return TestClient(create_app(c))


def test_the_news_token_reaches_search_and_the_budget_holds_only(llm: FakeLlm, web: FakeWebApp) -> None:
    with client(llm, web) as tc:
        news = {"Authorization": f"Bearer {NEWS}"}
        r = tc.post("/search", json={"q": "cert-manager renew", "k": 2}, headers=news)
        assert r.status_code == 200
        hits_ = r.json()["hits"]
        assert len(hits_) == 2 and hits_[0]["path"] == "/blog/ingress-tls" and {"title", "heading", "anchor", "content", "score", "article_id"} <= set(hits_[0])
        hold = tc.post("/llm-budget/reserve", json={"max_usd": 0.1, "purpose": "news.crew"}, headers=news)
        assert hold.status_code == 200
        assert tc.post("/llm-budget/settle", json={"id": hold.json()["id"]}, headers=news).json() == {"released": True}
        for method, path in (("GET", "/flows"), ("POST", "/flows/gsc_sync_flow/kickoff"), ("GET", "/llm-budget"), ("PUT", "/llm-budget"), ("GET", "/flows/runs"), ("POST", "/review/x/decision"), ("GET", "/admin-settings"), ("POST", "/ask")):
            assert tc.request(method, path, headers=news, json={}).status_code == 403, path
        # The service token still reaches everything, /search included; no token reaches nothing.
        assert tc.get("/flows", headers={"Authorization": f"Bearer {SERVICE}"}).status_code == 200
        assert tc.post("/search", json={"q": "istio"}, headers={"Authorization": f"Bearer {SERVICE}"}).status_code == 200
        assert tc.post("/search", json={"q": "istio"}).status_code == 401
        assert tc.post("/search", json={"q": "istio", "k": 50}, headers=news).status_code == 422


def test_without_a_news_token_nothing_is_open_to_it(llm: FakeLlm, web: FakeWebApp) -> None:
    with client(llm, web, news_token="") as tc:
        assert tc.post("/search", json={"q": "istio"}, headers={"Authorization": "Bearer "}).status_code == 401
        assert tc.post("/llm-budget/reserve", json={"max_usd": 0.1, "purpose": "news.crew"}, headers={"Authorization": f"Bearer {NEWS}"}).status_code == 401


def test_a_held_news_call_counts_against_the_one_budget(llm: FakeLlm, web: FakeWebApp) -> None:
    from app.llm_budgets import Budget

    with client(llm, web) as tc:
        c = tc.app.state.c  # type: ignore[attr-defined]
        c.budgets.value = Budget(daily_usd=1.0)
        c.guard.budget = c.budgets
        news = {"Authorization": f"Bearer {NEWS}"}
        assert tc.post("/llm-budget/reserve", json={"max_usd": 0.8, "purpose": "news.crew"}, headers=news).status_code == 200
        refused = tc.post("/llm-budget/reserve", json={"max_usd": 0.5, "purpose": "draft"}, headers={"Authorization": f"Bearer {SERVICE}"})
        assert refused.status_code == 402 and refused.json()["scope"] == "llm_daily"


def test_search_is_503_while_the_index_is_not_ready(llm: FakeLlm, web: FakeWebApp) -> None:
    c = memory_container(replace(settings(), news_token=NEWS), llm=llm, web=web, retriever=MemoryRetriever(hits(), available=False))
    with TestClient(create_app(c)) as tc:
        assert tc.post("/search", json={"q": "istio"}, headers={"Authorization": f"Bearer {NEWS}"}).status_code == 503


def test_catalogues_say_which_agent_owns_each_entry(llm: FakeLlm, web: FakeWebApp) -> None:
    with client(llm, web) as tc:
        auth = {"Authorization": f"Bearer {SERVICE}"}
        flows = tc.get("/flows", headers=auth).json()["items"]
        crews = tc.get("/crews", headers=auth).json()["items"]
    assert flows and all(f["agent"] == "seo" for f in flows) and not any(f["name"].startswith("news_") for f in flows)
    assert crews and all(c["agent"] == "seo" for c in crews) and "news" not in {c["crew"] for c in crews}


def test_a_short_or_shared_news_token_stops_the_start(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from app import main

    for token in ("short", SERVICE):
        monkeypatch.setenv("APP_ENV", "production")
        monkeypatch.setenv("SEO_AGENT_TOKEN", SERVICE)
        monkeypatch.setenv("SEO_AGENT_CALLBACK_TOKEN", "c" * 40)
        monkeypatch.setenv("SEO_AGENT_NEWS_TOKEN", token)
        with pytest.raises(RuntimeError, match="SEO_AGENT_NEWS_TOKEN"):
            asyncio.run(main.serve())




async def test_public_search_news_still_finds_published_news_posts() -> None:
    from app.mcp.news_search import MemoryPublishedNews

    now = datetime(2026, 11, 21, tzinfo=UTC)
    store = MemoryPublishedNews({
        "p1": {"collection": "news", "status": "published", "title": "Kubernetes 1.35 resize", "path": "/news/k8s-135", "body": "pod resize", "published_at": now},
        "p2": {"collection": "news", "status": "draft", "title": "Draft resize", "path": "/news/draft", "body": "resize", "published_at": now},
        "p3": {"collection": "blog", "status": "published", "title": "Blog resize", "path": "/blog/x", "body": "resize", "published_at": now},
    })
    assert [r["path"] for r in await store.search("resize", None, 10)] == ["/news/k8s-135"]


def test_holds_say_who_took_them(llm: FakeLlm, web: FakeWebApp, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    with client(llm, web) as tc, caplog.at_level(logging.INFO, logger="seo_agent.llm"):
        news = tc.post("/llm-budget/reserve", json={"max_usd": 0.25, "purpose": "news.crew"}, headers={"Authorization": f"Bearer {NEWS}"})
        tc.post("/llm-budget/reserve", json={"max_usd": 0.5, "purpose": "draft"}, headers={"Authorization": f"Bearer {SERVICE}"})
        view = tc.get("/llm-budget", headers={"Authorization": f"Bearer {SERVICE}"}).json()
        assert view["holds"] == [{"caller": "news-agent", "usd": 0.25, "calls": 1}, {"caller": "web", "usd": 0.5, "calls": 1}]
        tc.post("/llm-budget/settle", json={"id": news.json()["id"]}, headers={"Authorization": f"Bearer {NEWS}"})
        assert [h["caller"] for h in tc.get("/llm-budget", headers={"Authorization": f"Bearer {SERVICE}"}).json()["holds"]] == ["web"]
    held = [r for r in caplog.records if getattr(r, "event", None) == "llm_budget_hold"]
    assert {(r.caller, r.outcome) for r in held} == {("news-agent", "held"), ("web", "held")}
