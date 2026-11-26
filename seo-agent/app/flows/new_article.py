"""new_article_flow: an approved calendar idea → Editorial Crew → validate → **draft awaiting review**.

    load_brief → ground → draft (Editorial Crew) ─┬─ budget → paused
                            ▲                     └─ validate ─┬─ ok (or incomplete crew result) → save_draft (draft_ready)
                            └── errors, first try ─────────────┤
                                                               └─ errors after retry → failed

Starts when an admin creates a draft from an approved content-gap idea (the web app creates the CMS draft post and
reserves a `new_article` draft first). An incomplete crew result is still saved for the reviewer, marked incomplete,
with approval blocked by its error flags. Publishing happens only in publish_flow after a human approval.

`ground` (2026-11-26) asks the shared moks-rag service (app/site_context.py), when it is configured: is the brief's
target keyword already covered by a published article (cannibalization; each such article becomes a warning flag on
the draft), what seo_intel and the site's articles say on the topic, and which existing articles to link to. The crew
gets all of it as data (crews/editorial.py rag_sections). It also keeps the site's style guide current in seo_intel.
Best effort: without moks-rag, or when it fails, the step records why and the crew drafts as before.
"""

from __future__ import annotations

import logging
from typing import ClassVar

from crewai.flow import listen, or_, persist, router, start

from .. import seo_intel, site_context
from ..llm import BudgetExceeded
from ..logs import RUN_ONLY
from ..narrate import count
from ..runs import INSTANCE_ONLY
from ..state import NewArticleState
from .base import SeoFlow, log_validation

log = logging.getLogger("seo_agent.flows.new_article")

PROMPT_VERSION = "seo-crew-v7"
MAX_ATTEMPTS = 2


@persist(INSTANCE_ONLY)
class NewArticleFlow(SeoFlow[NewArticleState]):
    FLOW: ClassVar[str] = "new_article_flow"

    @start()
    async def load_brief(self) -> None:
        async with self.step("load_brief"):
            s, web = self.state, self.deps.web
            if s.feedback:
                await self.retry(lambda: web.set_draft_status(s.draft_id, "generating", None))
            if s.feedback:
                log.info(f"Writing again with the reviewer's feedback ({len(s.feedback):,} characters)", extra={"event": "draft_feedback", RUN_ONLY: {"feedback": s.feedback[:2000]}})
            b = await self.retry(lambda: web.calendar_brief(s.calendar_id))
            s.brief = b
            s.article_id = b.get("postId") or s.article_id
            outline = [h for h in (b.get("outline") or []) if isinstance(h, str)]
            log.info(
                f"Brief: “{b.get('title', '')}” ({b.get('kind') or 'article'}" + (f", category {b['category']}" if b.get("category") else "") + f"), {count(len(outline), 'outline heading')}"
                + (", the current draft is rewritten" if b.get("currentDraft") else ", written from scratch"),
                extra={"event": "brief_loaded", "calendar_id": s.calendar_id, RUN_ONLY: {"outline": outline[:30], "target_keyword": b.get("targetKeyword"), "examples": len(b.get("examples") or [])}},
            )

    @listen(load_brief)
    async def ground(self) -> None:
        async with self.step("ground") as rec:
            s, extra, st = self.state, self.deps.extra, self.deps.settings
            rag = extra.get("rag")
            if rag is None:
                rec.detail["rag"] = "not_configured"
                log.info("No grounding: the shared knowledge base (moks-rag) is not configured; the crew writes from the brief alone", extra={"event": "ground_skipped"})
                return
            b = s.brief
            exclude = [str(v) for v in (b.get("path"), b.get("url")) if isinstance(v, str) and v]
            try:
                report = await site_context.cannibalization(rag, keyword=site_context.target_keyword(b), topic=str(b.get("title") or ""), site_url=st.site_url, exclude=exclude, embed=extra.get("ml_embed"), min_similarity=st.rag_cannibalization_min_similarity)
                g = await site_context.grounding(rag, b, site_url=st.site_url, exclude=exclude)
                links = await site_context.internal_links(rag, title=str(b.get("title") or ""), headings=[str(h) for h in (b.get("outline") or []) if isinstance(h, str)], site_url=st.site_url, exclude=exclude)
            except Exception as e:  # moks-rag down, token refused, embeddings failed: draft without it
                s.rag = {"error": f"{type(e).__name__}: {str(e)[:300]}"}
                rec.detail.update({"rag": "failed", "error": s.rag["error"]})
                log.warning(f"No grounding: moks-rag failed ({s.rag['error']}); the crew writes from the brief alone", extra={"event": "ground_failed"})
                return
            s.rag = {"keyword": report.keyword, "cannibalization": report.out(), "flags": [f.model_dump() for f in report.as_flags()], **g, "internal_links": [x.out() for x in links]}
            rec.detail.update({"rag": "ok", "keyword": report.keyword, "cannibalization_flagged": report.flagged, "seo_intel": len(g["seo_intel"]), "site_articles": len(g["site_articles"]), "link_candidates": len(links)})
            log.info(
                f"Grounding from moks-rag for “{report.keyword}”: {count(len(g['seo_intel']), 'passage')} of SEO knowledge (seo_intel), {count(len(g['site_articles']), 'related site article')}, {count(len(links), 'internal link candidate')}",
                extra={"event": "ground_result", RUN_ONLY: {"internal_links": [x.out() for x in links][:10]}},
            )
            flags = s.rag["flags"]
            log.log(
                logging.WARNING if flags else logging.INFO,
                f"Cannibalization check: {count(len(flags), 'published article')} may already cover this keyword (a warning for the reviewer, not a block)" if flags else "Cannibalization check: no published article covers this keyword",
                extra={"event": "cannibalization", "flagged": len(flags), RUN_ONLY: {"flags": flags[:10]}},
            )
            style = str(b.get("styleGuide") or "")
            if style.strip() and extra.get("rag_docs") is not None:
                try:
                    rec.detail["style_guide_sent"] = sent = await seo_intel.put_if_changed(rag, extra["rag_docs"], seo_intel.site_style_guide_doc(style, st.site_url))
                    log.info("Site style guide sent to seo_intel (it changed)" if sent else "Site style guide unchanged in seo_intel", extra={"event": "style_guide"})
                except Exception as e:
                    rec.detail["style_guide_error"] = f"{type(e).__name__}: {str(e)[:200]}"
                    log.warning(f"Site style guide not sent to seo_intel: {rec.detail['style_guide_error']}", extra={"event": "style_guide_failed"})

    @listen(or_(ground, "to_retry"))
    async def draft(self) -> None:
        async with self.step("draft"):
            s = self.state
            s.attempts += 1
            crew = self.deps.editorial_crew() if self.deps.editorial_crew else None
            if crew is None:
                raise RuntimeError("editorial crew is not configured")
            log.info(
                f"Attempt {s.attempts} of {MAX_ATTEMPTS}: the editorial crew researches, writes, reviews and checks the SEO of the draft"
                + (" (fixing the validator's errors from the last attempt)" if s.validator_feedback else ""),
                extra={"event": "draft_attempt", "attempt": s.attempts},
            )
            try:
                context = {"rag_context": s.rag} if s.rag and "error" not in s.rag else {}
                r = await crew.run(s.brief, feedback=s.feedback, validator_feedback=s.validator_feedback, feedback_untrusted=s.triggered_by == "mcp", draft_id=s.draft_id, **context)
            except BudgetExceeded as e:
                self.add_budget_cost(e)
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                log.warning(f"Paused: the LLM budget is reached ({e.detail}). The draft is marked failed; run it again when there is budget", extra={"event": "draft_budget"})
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.document = r.draft.model_dump()
            flags = (s.rag or {}).get("flags") or []
            if flags:  # an existing article already covers the keyword: a warning for the reviewer, never a block
                have = {(f.get("claim"), f.get("reason")) for f in s.document.get("fact_check_flags") or []}
                s.document["fact_check_flags"] = [*(s.document.get("fact_check_flags") or []), *(f for f in flags if (f["claim"], f["reason"]) not in have)]
            s.crew = {"status": r.status, "tokens": r.tokens, "tool_calls": len(r.tool_calls), "fetched_sources": r.fetched_sources, "config": getattr(r, "config", None)}
            doc = s.document
            log.info(
                f"Draft written: “{doc.get('title', '')}”, {count(len(str(doc.get('body_mdx') or '').split()), 'word')}, {count(len(doc.get('fact_check_flags') or []), 'fact-check flag')}"
                + (", marked incomplete" if doc.get("incomplete") else "")
                + (f"; {count(len(r.fetched_sources or []), 'source')} fetched" if r.fetched_sources else ""),
                extra={"event": "draft_written", RUN_ONLY: {"meta_description": doc.get("meta_description"), "fact_check_flags": (doc.get("fact_check_flags") or [])[:10]}},
            )

    @router(draft)
    def after_draft(self) -> str:
        return "to_paused" if self.state.outcome == "paused_budget" else "to_validate"

    @listen("to_validate")
    async def validate_draft(self) -> None:
        async with self.step("validate_draft"):
            s = self.state
            doc = s.document or {}
            report = await self.retry(lambda: self.deps.web.validate(str(s.article_id), {"draftId": s.draft_id, "kind": "new_article", "document": doc}))
            s.validation_report = report
            log_validation(log, report, retry=bool(report.get("errors")) and s.attempts < MAX_ATTEMPTS and not doc.get("incomplete"))
            if report.get("errors") and s.attempts < MAX_ATTEMPTS and not doc.get("incomplete"):
                # Kept apart from the reviewer's feedback, which the retry must still address.
                s.validator_feedback = "- " + "\n- ".join(list(report["errors"])[:20])

    @router(validate_draft)
    def after_validate(self) -> str:
        s = self.state
        errors = s.validation_report.get("errors")
        incomplete = bool((s.document or {}).get("incomplete"))
        if errors and not incomplete:
            return "to_retry" if s.attempts < MAX_ATTEMPTS else "to_fail"
        return "to_ok"

    @listen("to_ok")
    async def save_draft(self) -> None:
        async with self.step("save_draft"):
            s = self.state
            doc = s.document or {}
            r = s.validation_report
            await self.retry(lambda: self.deps.web.save_draft(s.draft_id, {"kind": "new_article", "document": doc, "changes": r.get("changes") or [], "flags": r.get("flags") or [], "summary": f"New article: {doc.get('title', '')}", "model": self._body_model(), "promptVersion": (s.crew.get("config") or {}).get("prompt_version") or PROMPT_VERSION, "threadId": s.draft_id, "runId": s.id}))
            s.feedback = s.validator_feedback = None
            s.outcome = "draft_ready"
            log.info(f"Saved for review: draft {s.draft_id} “{doc.get('title', '')}” waits in the review queue (nothing is published without a person)", extra={"event": "draft_saved", "draft_id": s.draft_id})

    def _body_model(self) -> str:
        """The model recorded on the draft: the one that wrote the body (per-run override, SEO_CREW_MODELS, default)."""
        st = self.deps.settings
        return str(((self.state.brief or {}).get("models") or {}).get("writer") or st.crew_models.get("editorial.writer") or st.draft_model)

    @listen("to_fail")
    async def failed(self) -> None:
        async with self.step("failed"):
            s = self.state
            reason = f"Validation failed: {'; '.join(list(s.validation_report.get('errors') or [])[:5])}"[:1000]
            await self.retry(lambda: self.deps.web.set_draft_status(s.draft_id, "generation_failed", reason))
            s.errors.append(reason)
            s.outcome = "generation_failed"
            log.warning(f"Gave up after {count(s.attempts, 'attempt')}: {reason}. The draft is marked failed in the review queue", extra={"event": "draft_failed"})

    @listen("to_paused")
    async def paused(self) -> None:
        async with self.step("paused"):
            s = self.state
            await self.retry(lambda: self.deps.web.set_draft_status(s.draft_id, "generation_failed", f"Paused: {s.errors[-1] if s.errors else 'LLM budget reached'}"))
