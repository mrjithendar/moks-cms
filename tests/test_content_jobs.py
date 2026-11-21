"""Crew-jobs plan PR 3 (2026-11-21): a crew job writes any kind of content, news being one.

- JobConfig.output: a news article (NewsArticle, collection news) or a blog article (Article, collection blog).
- JobConfig.intake: the content sources (the News Desk crew) and/or the content ideas (the web app puts the best
  matching ideas on the editorial calendar and the Editorial crew writes them).
- JobConfig.quality: the job's own quality-gate values on top of the shared ones.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.news import desk as nd
from app.news.config import JobConfig, NewsSettings, Quality
from tests.news_fixtures import JOB, FakeNewsCrew, NewsWeb, good_draft
from tests.test_news_flows import SAFE, news_run, run, setup


def test_job_config_defaults_keep_what_saved_jobs_did() -> None:
    c = JobConfig()
    assert c.output == "news" and c.intake == ["sources"] and c.quality == {}
    assert c.effective_quality(Quality()) == Quality()


def test_job_config_refuses_unknown_or_out_of_range_values() -> None:
    for bad in ({"output": "podcast"}, {"intake": []}, {"intake": ["sources", "sources"]}, {"intake": ["feeds"]}, {"quality": {"no_such_gate": 1}}, {"quality": {"title_max": 5}}):
        with pytest.raises(ValidationError):
            JobConfig.model_validate(bad)


def test_a_job_s_own_quality_values_win_over_the_shared_ones() -> None:
    shared = Quality(title_max=70, max_quote_words=30)
    q = JobConfig.model_validate({"quality": {"title_max": 50}}).effective_quality(shared)
    assert q.title_max == 50 and q.max_quote_words == 30  # a gate the job leaves out keeps the shared value


async def test_the_quality_gates_a_draft_meets_are_the_job_s(llm: Any) -> None:
    _c, _web, store = setup(llm, job_cfg={"quality": {"title_max": 30}})
    d = nd.DeskDeps(store=store, web=None, llm=None, embed=None, retriever=None, settings=None, news=NewsSettings(), clock=lambda: None)  # type: ignore[arg-type]
    job = nd.as_job(store.jobs[JOB])
    assert nd._quality(d, job).title_max == 30
    assert nd._quality(d).title_max == Quality().title_max


async def test_an_article_job_writes_an_evergreen_blog_article(llm: Any) -> None:
    llm.queue("news.vision", SAFE)
    draft = good_draft()
    draft.schema_jsonld = {**draft.schema_jsonld, "@type": "Article"}
    crew = FakeNewsCrew([draft])
    c, web, _store = setup(llm, crew=crew, job_cfg={"output": "article"})
    fr = await run(c, "news_job_flow", {"job_id": JOB})
    assert fr["status"] == "succeeded", fr
    assert crew.runs[0]["brief"]["output"] == "article"
    assert len(web.saved) == 1 and web.saved[0]["output"] == "article"  # moks-cms saves it in the blog collection


async def test_an_article_job_refuses_a_news_article_json_ld(llm: Any) -> None:
    llm.queue("news.vision", SAFE)
    c, web, store = setup(llm, crew=FakeNewsCrew([good_draft()]), job_cfg={"output": "article"})  # good_draft says NewsArticle
    await run(c, "news_job_flow", {"job_id": JOB})
    a = next(iter(store.articles.values()))
    assert a["status"] == "failed_quality" and web.saved == []
    assert "seo" in a["quality"]["failed"]


async def test_a_news_job_still_writes_news(llm: Any) -> None:
    llm.queue("news.vision", SAFE)
    c, web, _store = setup(llm)
    await run(c, "news_job_flow", {"job_id": JOB})
    assert web.saved and web.saved[0]["output"] == "news"


async def test_an_ideas_job_sends_its_best_ideas_to_the_editorial_crew_and_reads_no_feed(llm: Any) -> None:
    web = NewsWeb()
    web.ideas = [{"id": f"i{n}", "title": f"Idea {n}"} for n in range(5)]
    c, web, store = setup(llm, web=web, job_cfg={"intake": ["ideas"], "output": "article"})
    fr = await run(c, "news_job_flow", {"job_id": JOB})
    assert fr["status"] == "succeeded", fr
    assert not any(k == "news_fetch" for k, _ in web.calls)  # no content sources for this job
    assert web.idea_calls[0] == {"jobId": JOB, "runId": fr["state_json"]["news_run_id"], "limit": 3, "dryRun": False}
    ideas = [ch for ch in fr["state_json"]["children"] if ch["mode"] == "idea"]
    assert [ch["outcome"] for ch in ideas] == ["drafting"] * 3 and ideas[0]["result"]["calendar_id"] == "cal-i0"
    assert news_run(store, fr)["status"] == "succeeded"


async def test_ideas_fill_only_the_room_the_sources_left_and_a_dry_run_starts_nothing(llm: Any) -> None:
    llm.queue("news.vision", SAFE)
    web = NewsWeb()
    web.ideas = [{"id": "i1", "title": "Idea 1"}]
    c, web, _store = setup(llm, web=web, job_cfg={"intake": ["sources", "ideas"], "max_articles_per_run": 1})
    fr = await run(c, "news_job_flow", {"job_id": JOB})
    assert len(web.saved) == 1 and web.idea_calls == []  # the one place went to a story from the sources
    c2, web2, _ = setup(llm, web=NewsWeb(ideas=[{"id": "i9", "title": "Idea 9"}]), job_cfg={"intake": ["ideas"]})
    dry = await run(c2, "news_job_flow", {"job_id": JOB, "dry_run": True})
    assert web2.idea_calls[0]["dryRun"] is True
    assert [ch["outcome"] for ch in dry["state_json"]["children"]] == ["dry_run"]
    assert fr["status"] == "succeeded"


async def test_the_playground_tries_a_profile_the_way_the_job_writes(llm: Any) -> None:
    # Crew-jobs plan PR 5: the profile playground follows the job: an article job's trial is an article, with its models.
    crew = FakeNewsCrew()
    c, web, store = setup(llm, crew=crew, job_cfg={"output": "article", "models": {"writer": "claude-haiku-5-5"}})
    await run(c, "news_job_flow", {"job_id": JOB, "dry_run": True, "llm": False})
    cid = next(iter(store.clusters))
    await run(c, "news_playground_flow", {"job_id": JOB, "cluster_id": cid, "profile_key": "news-default", "version_a": 1})
    trial = crew.runs[-1]
    assert trial["brief"]["output"] == "article" and trial["models"] == {"writer": "claude-haiku-5-5"}
    assert web.saved == []
