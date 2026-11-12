"""promotion_flow and content_ideas_flow (docs/seo/PROMOTION.md): text for a person to review, never a post.

promotion_flow: collect → draft → save
    collect  the web app refreshes the Reddit threads (read-only; skipped when Reddit is not configured), scores every
             enabled channel for the target articles with its deterministic rules and returns what to draft: one
             article (input article_id) or the newest published articles without opportunities.
    draft    Promotion Crew copywriter: one post per channel that scored above the threshold, per article.
    save     the drafts go to the web app, which checks them (length, links) and stores them as "drafted".
A person edits, copies and posts each one by hand on the channel and marks it as posted. Nothing is posted here.

content_ideas_flow: collect_signals → ideate → save
    collect_signals  Search Console topics and page-two queries, the fetched Reddit threads, and what the site has
                     already published or planned (the web app).
    ideate           Promotion Crew strategist: ideas that cite evidence copied from those signals.
    save             the web app verifies every piece of evidence against its own data, drops what it cannot verify
                     or what repeats existing content, and stores the rest as ideas for the owner (who may send one to
                     the editorial calendar, where the existing new_article_flow takes over).

Both end `paused_budget` when the monthly budget refuses a call; what was drafted before that is still saved.
"""

from __future__ import annotations

from functools import partial
from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from ..llm import BudgetExceeded
from ..runs import INSTANCE_ONLY
from ..state import ContentIdeasState, PromotionState
from .base import SeoFlow


def _crew(flow: SeoFlow[Any]) -> Any:
    crew = flow.deps.promotion_crew() if flow.deps.promotion_crew else None
    if crew is None:
        raise RuntimeError("promotion crew is not configured")
    return crew


@persist(INSTANCE_ONLY)
class PromotionFlow(SeoFlow[PromotionState]):
    FLOW: ClassVar[str] = "promotion_flow"

    @start()
    async def collect(self) -> None:
        async with self.step("collect"):
            s = self.state
            r = await self.retry(lambda: self.deps.web.promo_collect(s.article_id, s.limit))
            s.reddit = r.get("reddit") or {}
            if not r.get("enabled"):
                s.outcome = "disabled"
                return
            s.articles = [a for a in (r.get("articles") or []) if isinstance(a, dict)]

    @listen(collect)
    async def draft(self) -> None:
        async with self.step("draft"):
            s = self.state
            if s.outcome:
                return
            todo = [a for a in s.articles if a.get("channels")]
            if not todo:
                s.outcome = "no_drafts_needed"
                return
            crew = _crew(self)
            for a in todo:
                aid = str(a.get("articleId"))
                try:
                    r = await crew.draft_posts(a)
                except BudgetExceeded as e:
                    self.add_budget_cost(e)
                    s.outcome = "paused_budget"
                    s.errors.append(f"budget: {e.detail}")
                    break
                s.add_cost(r.cost_usd, r.tokens)
                s.drafts[aid] = r.posts
                s.results.append({"article_id": aid, "title": str(a.get("title") or "")[:200], "channels": len(a["channels"]), "posts": len(r.posts), "status": r.status, "reason": r.reason})
                if r.status != "completed":
                    s.errors.append(f"{aid}: {r.reason or 'incomplete'}")

    @listen(draft)
    async def save(self) -> None:
        async with self.step("save"):
            s = self.state
            saved = 0
            for aid, posts in s.drafts.items():
                if not posts:
                    continue
                r = await self.retry(partial(self.deps.web.promo_save_drafts, aid, posts, s.id))
                saved += int(r.get("saved") or 0)
            s.result = {"articles": len(s.articles), "drafted": saved, "reddit": s.reddit.get("status")}
            s.outcome = s.outcome or ("drafts_ready" if saved else "no_drafts")


@persist(INSTANCE_ONLY)
class ContentIdeasFlow(SeoFlow[ContentIdeasState]):
    FLOW: ClassVar[str] = "content_ideas_flow"

    @start()
    async def collect_signals(self) -> None:
        async with self.step("collect_signals"):
            s = self.state
            r = await self.retry(lambda: self.deps.web.promo_idea_signals())
            s.reddit = r.get("redditSync") or {}
            if not r.get("enabled"):
                s.outcome = "disabled"
                return
            gsc = r.get("gsc") or {}
            if not (gsc.get("topics") or gsc.get("queries") or r.get("reddit")):
                s.outcome = "no_signals"  # nothing synced yet: no evidence to build an idea on
                return
            s.signals = r

    @listen(collect_signals)
    async def ideate(self) -> None:
        async with self.step("ideate"):
            s = self.state
            if s.outcome:
                return
            try:
                r = await _crew(self).ideas(s.signals)
            except BudgetExceeded as e:
                self.add_budget_cost(e)
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.ideas = r.ideas
            s.crew = {"status": r.status, "reason": r.reason, "tokens": r.tokens}
            if r.status != "completed":
                s.errors.append(f"ideas: {r.reason or 'incomplete'}")

    @listen(ideate)
    async def save(self) -> None:
        async with self.step("save"):
            s = self.state
            saved: dict[str, Any] = {"saved": 0, "skipped": []}
            if s.ideas:
                saved = await self.retry(partial(self.deps.web.promo_save_ideas, s.ideas, s.id))
            gsc = s.signals.get("gsc") or {}
            s.result = {
                "proposed": len(s.ideas),
                "saved": int(saved.get("saved") or 0),
                "skipped": list(saved.get("skipped") or [])[:20],
                "signals": {"topics": len(gsc.get("topics") or []), "queries": len(gsc.get("queries") or []), "threads": len(s.signals.get("reddit") or [])},
                "reddit": s.reddit.get("status"),
            }
            s.outcome = s.outcome or ("ideas_ready" if s.result["saved"] else "no_ideas")
