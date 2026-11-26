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

from typing import ClassVar

from crewai.flow import listen, or_, persist, router, start

from .. import seo_intel, site_context
from ..llm import BudgetExceeded
from ..runs import INSTANCE_ONLY
from ..state import NewArticleState
from .base import SeoFlow

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
            b = await self.retry(lambda: web.calendar_brief(s.calendar_id))
            s.brief = b
            s.article_id = b.get("postId") or s.article_id

    @listen(load_brief)
    async def ground(self) -> None:
        async with self.step("ground") as rec:
            s, extra, st = self.state, self.deps.extra, self.deps.settings
            rag = extra.get("rag")
            if rag is None:
                rec.detail["rag"] = "not_configured"
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
                return
            s.rag = {"keyword": report.keyword, "cannibalization": report.out(), "flags": [f.model_dump() for f in report.as_flags()], **g, "internal_links": [x.out() for x in links]}
            rec.detail.update({"rag": "ok", "keyword": report.keyword, "cannibalization_flagged": report.flagged, "seo_intel": len(g["seo_intel"]), "site_articles": len(g["site_articles"]), "link_candidates": len(links)})
            style = str(b.get("styleGuide") or "")
            if style.strip() and extra.get("rag_docs") is not None:
                try:
                    rec.detail["style_guide_sent"] = await seo_intel.put_if_changed(rag, extra["rag_docs"], seo_intel.site_style_guide_doc(style, st.site_url))
                except Exception as e:
                    rec.detail["style_guide_error"] = f"{type(e).__name__}: {str(e)[:200]}"

    @listen(or_(ground, "to_retry"))
    async def draft(self) -> None:
        async with self.step("draft"):
            s = self.state
            s.attempts += 1
            crew = self.deps.editorial_crew() if self.deps.editorial_crew else None
            if crew is None:
                raise RuntimeError("editorial crew is not configured")
            try:
                context = {"rag_context": s.rag} if s.rag and "error" not in s.rag else {}
                r = await crew.run(s.brief, feedback=s.feedback, validator_feedback=s.validator_feedback, feedback_untrusted=s.triggered_by == "mcp", draft_id=s.draft_id, **context)
            except BudgetExceeded as e:
                self.add_budget_cost(e)
                s.outcome = "paused_budget"
                s.errors.append(f"budget: {e.detail}")
                return
            s.add_cost(r.cost_usd, r.tokens)
            s.document = r.draft.model_dump()
            flags = (s.rag or {}).get("flags") or []
            if flags:  # an existing article already covers the keyword: a warning for the reviewer, never a block
                have = {(f.get("claim"), f.get("reason")) for f in s.document.get("fact_check_flags") or []}
                s.document["fact_check_flags"] = [*(s.document.get("fact_check_flags") or []), *(f for f in flags if (f["claim"], f["reason"]) not in have)]
            s.crew = {"status": r.status, "tokens": r.tokens, "tool_calls": len(r.tool_calls), "fetched_sources": r.fetched_sources, "config": getattr(r, "config", None)}

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

    @listen("to_paused")
    async def paused(self) -> None:
        async with self.step("paused"):
            s = self.state
            await self.retry(lambda: self.deps.web.set_draft_status(s.draft_id, "generation_failed", f"Paused: {s.errors[-1] if s.errors else 'LLM budget reached'}"))
