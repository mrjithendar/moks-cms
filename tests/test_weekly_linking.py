"""weekly_recommendations fan-out and internal_linking."""

from __future__ import annotations

import asyncio

from app.graphs.internal_linking import combine
from app.main import memory_container
from tests.conftest import FakeWebApp, good_changeset, settings


async def test_weekly_fans_out_one_child_per_article_with_bounded_concurrency(llm, web: FakeWebApp) -> None:
    ids = [f"3333333{i}-3333-4333-8333-33333333333{i}" for i in range(5)]
    web.weekly_items = [{"articleId": f"a{i}", "draftId": d, "recommendationIds": ["r1"]} for i, d in enumerate(ids)]
    in_flight = 0
    peak = 0

    # Measure concurrency at the first awaited step of each child (the web app's context call).
    orig = web.article_context

    async def ctx(aid, body):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        in_flight -= 1
        return await orig(aid, body)

    web.article_context = ctx  # type: ignore[method-assign]
    llm.queue("draft", *[good_changeset() for _ in ids])
    c = memory_container(settings(fanout_concurrency=2), llm=llm, web=web)
    await c.runs.start("weekly_recommendations", {"limit": 10}, "weekly:2026-W46")
    await c.runs.wait("weekly:2026-W46", 30)
    run = await c.runs.get("weekly:2026-W46")
    assert run["status"] == "completed"
    children = run["state"]["children"]
    assert sorted(ch["draft_id"] for ch in children) == sorted(ids)
    assert all(ch["status"] == "interrupted" for ch in children)  # each child waits at its own human_review
    assert peak == 2  # bounded (≤ 2) and actually parallel
    for d in ids:
        assert (await c.runs.get(d))["status"] == "interrupted"


async def test_weekly_rerun_does_not_duplicate_children(llm, web: FakeWebApp) -> None:
    d = "44444444-4444-4444-8444-444444444444"
    web.weekly_items = [{"articleId": "a1", "draftId": d}]
    llm.queue("draft", good_changeset())
    c = memory_container(settings(), llm=llm, web=web)
    await c.runs.start("optimize_article", {"article_id": "a1", "draft_id": d}, d)
    await c.runs.wait(d)
    await c.runs.start("weekly_recommendations", {}, "weekly:x")
    await c.runs.wait("weekly:x", 10)
    assert len(llm.calls) == 1  # the existing open thread was not started again


async def test_weekly_with_nothing_to_do(llm, web: FakeWebApp) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    await c.runs.start("weekly_recommendations", {}, "weekly:empty")
    await c.runs.wait("weekly:empty")
    assert (await c.runs.get("weekly:empty"))["outcome"] == "done"


def test_combine_weights_vector_similarity_and_shared_queries() -> None:
    out = combine([("b", "/blog/b", 0.80), ("c", "/blog/c", 0.60)], {"istio mtls", "istio strict"}, {"/blog/b": set(), "/blog/c": {"istio mtls", "istio strict"}})
    assert [c["path"] for c in out] == ["/blog/c", "/blog/b"]  # shared queries outweigh a small similarity edge
    assert out[0]["sharedQueries"] == ["istio mtls", "istio strict"]


async def test_internal_linking_feeds_the_v2_planner(llm, web: FakeWebApp, retriever) -> None:
    c = memory_container(settings(), llm=llm, web=web, retriever=retriever)
    await c.runs.start("internal_linking", {"article_ids": ["a1"]}, "links:a1")
    await c.runs.wait("links:a1")
    run = await c.runs.get("links:a1")
    assert run["outcome"] == "links_added" and llm.calls == []  # deterministic: no model involved
    (aid, cands), = web.links_planned
    assert aid == "a1" and {c["path"] for c in cands} == {"/blog/istio-minikube", "/blog/terraform-s3-state"}
