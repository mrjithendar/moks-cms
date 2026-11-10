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
from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from ..runs import INSTANCE_ONLY
from ..state import WeeklyState
from .base import SeoFlow


@persist(INSTANCE_ONLY)
class WeeklyRecommendationsFlow(SeoFlow[WeeklyState]):
    FLOW: ClassVar[str] = "weekly_recommendations_flow"

    @start()
    async def prepare(self) -> None:
        async with self.step("prepare"):
            limit = int(self.state.limit or self.deps.settings.weekly_max_articles)
            self.state.prepared = await self.retry(lambda: self.deps.web.weekly_candidates(limit))

    @listen(prepare)
    async def fan_out(self) -> None:
        async with self.step("fan_out"):
            items = self.state.prepared.get("items", [])
            runner = self.deps.runner
            sem = asyncio.Semaphore(self.deps.settings.fanout_concurrency)

            async def one(it: dict[str, Any]) -> dict[str, Any]:
                async with sem:
                    started = await runner.kickoff("optimize_article_flow", {"article_id": it["articleId"], "draft_id": it["draftId"], "recommendation_ids": it.get("recommendationIds", []), "trigger": "weekly"}, triggered_by="flow", correlation_id=self.state.id)
                    done = started if started.get("existing") else await runner.wait(started["run_id"])
                    child_state = done.get("outputs") if isinstance(done.get("outputs"), dict) else {}
                    # Children's cost stays on the children's own runs (summing runs must not count it twice).
                    return {"article_id": it["articleId"], "draft_id": it["draftId"], "run_id": str(done.get("run_id") or started.get("run_id")), "status": done.get("status"), "outcome": (child_state or {}).get("outcome"), "cost_usd": float(done.get("cost_usd") or 0)}

            results = await asyncio.gather(*(one(it) for it in items), return_exceptions=True)
            children = []
            for it, r in zip(items, results, strict=True):
                if isinstance(r, BaseException):
                    self.state.errors.append(f"{it['draftId']}: {type(r).__name__}")
                    children.append({"article_id": it["articleId"], "draft_id": it["draftId"], "status": "failed"})
                else:
                    children.append(r)
            self.state.children = children
            self.state.outcome = "done"
