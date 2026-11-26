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

import logging
from functools import partial
from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from ..llm import BudgetExceeded
from ..logs import RUN_ONLY
from ..narrate import count
from ..runs import INSTANCE_ONLY
from ..state import ContentIdeasState, PromotionState
from .base import SeoFlow

log = logging.getLogger("seo_agent.flows.promotion")


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
                log.info("Nothing to do: promotion is switched off in the web app's settings", extra={"event": "promotion_disabled"})
                return
            s.articles = [a for a in (r.get("articles") or []) if isinstance(a, dict)]
            log.info(
                f"{count(len(s.articles), 'article')} to promote" + (f" (asked for article {s.article_id})" if s.article_id else " (the newest without drafted posts)")
                + (f"; Reddit sync {s.reddit.get('status')}" if s.reddit.get("status") else ""),
                extra={"event": "promotion_articles", "articles": len(s.articles)},
            )
            for a in s.articles:
                ch = [str(c.get("channel") or c.get("name") or c) if isinstance(c, dict) else str(c) for c in (a.get("channels") or [])]
                log.info(f"“{a.get('title', '')}”: " + (f"posts for {', '.join(ch)}" if ch else "every channel already has a post"), extra={"event": "promotion_article", "article_id": a.get("articleId")})

    @listen(collect)
    async def draft(self) -> None:
        async with self.step("draft"):
            s = self.state
            if s.outcome:
                return
            todo = [a for a in s.articles if a.get("channels")]
            if not todo:
                s.outcome = "no_drafts_needed"
                log.info("Nothing to draft: every article already has a post for each channel", extra={"event": "promotion_nothing"})
                return
            crew = _crew(self)
            for i, a in enumerate(todo, 1):
                aid = str(a.get("articleId"))
                log.info(f"[{i}/{len(todo)}] The copywriter drafts {count(len(a['channels']), 'post')} for “{a.get('title', '')}”", extra={"event": "promotion_drafting", "article_id": aid})
                try:
                    r = await crew.draft_posts(a)
                except BudgetExceeded as e:
                    self.add_budget_cost(e)
                    s.outcome = "paused_budget"
                    s.errors.append(f"budget: {e.detail}")
                    log.warning(f"Paused: the LLM budget is reached ({e.detail}); the posts drafted so far are still saved", extra={"event": "promotion_budget"})
                    break
                s.add_cost(r.cost_usd, r.tokens)
                s.drafts[aid] = r.posts
                s.results.append({"article_id": aid, "title": str(a.get("title") or "")[:200], "channels": len(a["channels"]), "posts": len(r.posts), "status": r.status, "reason": r.reason})
                log.log(
                    logging.INFO if r.status == "completed" else logging.WARNING,
                    f"[{i}/{len(todo)}] {count(len(r.posts), 'post')} drafted" + (f" ({r.status}: {r.reason})" if r.status != "completed" else ""),
                    extra={"event": "promotion_drafted", "article_id": aid, "posts": len(r.posts), RUN_ONLY: {"posts": [p if isinstance(p, dict) else str(p) for p in r.posts][:10]}},
                )
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
            if s.drafts:
                log.info(f"Saved {count(saved, 'post draft')} for the owner to review and post (nothing is posted automatically)", extra={"event": "promotion_saved", "saved": saved})


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
                log.info("Nothing to do: content ideas are switched off in the web app's settings", extra={"event": "ideas_disabled"})
                return
            gsc = r.get("gsc") or {}
            log.info(
                f"Signals: {count(len(gsc.get('topics') or []), 'Search Console topic')}, {count(len(gsc.get('queries') or []), 'Search Console query', 'Search Console queries')}, {count(len(r.get('reddit') or []), 'Reddit thread')}"
                + (f"; Reddit sync {s.reddit.get('status')}" if s.reddit.get("status") else ""),
                extra={"event": "ideas_signals"},
            )
            if not (gsc.get("topics") or gsc.get("queries") or r.get("reddit")):
                s.outcome = "no_signals"  # nothing synced yet: no evidence to build an idea on
                log.info("Nothing to do: no signal has been synced yet, so there is no evidence to build an idea on", extra={"event": "ideas_no_signals"})
                return
            s.signals = r

    @listen(collect_signals)
    async def ideate(self) -> None:
        async with self.step("ideate"):
            s = self.state
            if s.outcome:
                return
            log.info("The strategist proposes article ideas, each citing evidence from these signals", extra={"event": "ideas_started"})
            try:
                r = await _crew(self).ideas(s.signals)
            except BudgetExceeded as e:
                self.add_budget_cost(e)
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                log.warning(f"Paused: the LLM budget is reached ({e.detail})", extra={"event": "ideas_budget"})
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.ideas = r.ideas
            titles = [str(i.get("title") if isinstance(i, dict) else getattr(i, "title", "")) for i in r.ideas]
            log.info(f"{count(len(r.ideas), 'idea')} proposed" + (f": {'; '.join(t for t in titles[:8] if t)}" if titles else "") + (f" ({r.status}: {r.reason})" if r.status != "completed" else ""), extra={"event": "ideas_proposed", "ideas": len(r.ideas)})
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
            if s.ideas:
                sk = s.result["skipped"]
                log.info(
                    f"The web app checked every piece of evidence against its own data: {count(s.result['saved'], 'idea')} saved for the owner, {len(sk)} left out (evidence it could not verify, or a repeat of existing content)",
                    extra={"event": "ideas_saved", "saved": s.result["saved"], "skipped": len(sk), RUN_ONLY: {"left_out": sk}},
                )
