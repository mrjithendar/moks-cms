"""weekly_recommendations_flow: rules → scoring → top N auto-eligible → one optimize_article_flow per article.

`prepare` calls the web app, which checks Search Console/GA4 freshness, refreshes the v1 rules and scores, picks the
top N articles with auto-eligible recommendations and **no open draft**, and reserves one draft per article (a
partial unique index guarantees one open draft per article). `fan_out` kicks off `optimize_article_flow` per draft
through the run manager with at most SEO_AGENT_FANOUT_CONCURRENCY (2) running at once; each child ends at its own
draft. A rerun is safe: articles with an open draft are not picked again, and a child already running for a draft
is reported as existing, not started twice.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from ..narrate import count
from ..runs import INSTANCE_ONLY
from ..state import WeeklyState
from .base import SeoFlow

log = logging.getLogger("seo_agent.flows.weekly")


@persist(INSTANCE_ONLY)
class WeeklyRecommendationsFlow(SeoFlow[WeeklyState]):
    FLOW: ClassVar[str] = "weekly_recommendations_flow"

    @start()
    async def prepare(self) -> None:
        async with self.step("prepare"):
            limit = int(self.state.limit or self.deps.settings.weekly_max_articles)
            log.info(f"Asking the web app for up to {count(limit, 'article')} with recommendations that can be applied automatically and no open draft", extra={"event": "weekly_request", "limit": limit})
            self.state.prepared = p = await self.retry(lambda: self.deps.web.weekly_candidates(limit))
            recs = p.get("recommendations") or {}
            if not p.get("fresh", True):
                log.info("Search Console data is older than 3 days: the web app queued a Search Console sync (this run uses what is there)", extra={"event": "weekly_stale_data"})
            if recs:
                log.info(f"Recommendations refreshed: {recs.get('created', 0)} new, {recs.get('refreshed', 0)} updated", extra={"event": "weekly_recommendations", **{k: v for k, v in recs.items() if isinstance(v, int)}})
            items = p.get("items") or []
            log.info(
                f"Picked {count(len(items), 'article')}; a draft was reserved for each" if items else "Nothing to do: no article has recommendations that can be applied automatically without an open draft",
                extra={"event": "weekly_picked", "articles": len(items)},
            )
            for it in items:
                log.info(f"Article {it.get('articleId')}: draft {it.get('draftId')}, {count(len(it.get('recommendationIds') or []), 'recommendation')}", extra={"event": "weekly_item", "article_id": it.get("articleId"), "draft_id": it.get("draftId")})

    @listen(prepare)
    async def fan_out(self) -> None:
        async with self.step("fan_out"):
            items = self.state.prepared.get("items", [])
            runner = self.deps.runner
            sem = asyncio.Semaphore(self.deps.settings.fanout_concurrency)
            if items:
                log.info(f"Starting optimize_article_flow for each of the {count(len(items), 'article')}, {self.deps.settings.fanout_concurrency} at a time; each one ends at its draft in the review queue", extra={"event": "weekly_fan_out", "articles": len(items)})

            async def one(it: dict[str, Any]) -> dict[str, Any]:
                async with sem:
                    started = await runner.kickoff("optimize_article_flow", {"article_id": it["articleId"], "draft_id": it["draftId"], "recommendation_ids": it.get("recommendationIds", []), "trigger": "weekly"}, triggered_by="flow", correlation_id=self.state.id)
                    done = started if started.get("existing") else await runner.wait(started["run_id"])
                    child_state = done.get("outputs") if isinstance(done.get("outputs"), dict) else {}
                    log.info(
                        f"Article {it['articleId']}: optimize_article_flow run {done.get('run_id') or started.get('run_id')} "
                        + ("was already running" if started.get("existing") else f"{done.get('status')}, outcome {(child_state or {}).get('outcome') or 'none'}"),
                        extra={"event": "weekly_child", "article_id": it["articleId"], "child_run_id": str(done.get("run_id") or started.get("run_id")), "status": done.get("status")},
                    )
                    # Children's cost stays on the children's own runs (summing runs must not count it twice).
                    return {"article_id": it["articleId"], "draft_id": it["draftId"], "run_id": str(done.get("run_id") or started.get("run_id")), "status": done.get("status"), "outcome": (child_state or {}).get("outcome"), "cost_usd": float(done.get("cost_usd") or 0)}

            results = await asyncio.gather(*(one(it) for it in items), return_exceptions=True)
            children = []
            for it, r in zip(items, results, strict=True):
                if isinstance(r, BaseException):
                    log.warning(f"Article {it['articleId']}: could not run optimize_article_flow: {type(r).__name__}: {str(r)[:200]}", extra={"event": "weekly_child_failed", "article_id": it["articleId"]})
                    self.state.errors.append(f"{it['draftId']}: {type(r).__name__}")
                    children.append({"article_id": it["articleId"], "draft_id": it["draftId"], "status": "failed"})
                else:
                    children.append(r)
            self.state.children = children
            self.state.outcome = "done"
