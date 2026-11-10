"""Editorial Crew (new articles, sequential): Researcher → Technical writer → Technical reviewer → SEO editor.

Output: `NewArticleDraft`. Runs inside `new_article_flow`'s `draft` step. Limits and the Claude adapter are in
crews/common.py. A cited source the crew never retrieved during the run is flagged for the reviewer.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

from ..config import Settings
from ..llm import Llm
from ..schemas import FactCheckFlag, NewArticleDraft
from ..tools import ToolContext, data_block
from .common import AgentDef, CrewRun, build_agents, make_crew, run_crew, task_raw

PROMPT_VERSION = "seo-crew-v2"

AGENTS = [
    AgentDef("researcher", "Researcher", "Collect the facts, related site articles and official documentation the article needs, with sources.", "You research for a one-person technical publication. You only report what the sources say and you list every source URL you used.", ["vector_search", "read_article", "fetch_allowlisted_docs"]),
    AgentDef("writer", "Technical writer", "Write the article draft in MDX following the style guide, with working, minimal code examples.", "You write practical engineering tutorials in the site's voice. You never invent commands, flags, versions or URLs.", ["read_article"]),
    AgentDef("reviewer", "Technical reviewer", "Check every command, flag and version against the sources; mark anything without a source as needs_fact_check.", "You are a careful reviewer. Unsourced technical claims are flagged, not guessed.", ["fetch_allowlisted_docs"]),
    AgentDef("seo_editor", "SEO editor", "Produce the final title, meta description, heading plan and up to three internal links, as the required JSON.", "You edit for search intent without clickbait: titles ≤ 60 characters, meta 120–155 characters, internal links only to existing site paths.", ["gsc_queries_for_topic", "vector_search"]),
]
ROLES = {a.key: {"role": a.role, "tools": a.tools} for a in AGENTS}


def _slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:80] or "draft"


@dataclass
class CrewResult:
    draft: NewArticleDraft
    status: str  # completed | incomplete
    tokens: int
    cost_usd: float
    tool_calls: list[tuple[str, str]]
    fetched_sources: list[str]


class EditorialCrew:
    def __init__(self, settings: Settings, llm: Llm, web: Any, retriever: Any):
        self.settings, self.llm, self.web, self.retriever = settings, llm, web, retriever

    async def run(self, brief: dict[str, Any], *, feedback: str | None = None, draft_id: str | None = None) -> CrewResult:
        from crewai import Task

        fetched: list[str] = []
        ctx = ToolContext(self.web, self.retriever, self.settings.docs_allowlist, on_source=lambda u, _t: fetched.append(u), style=str(brief.get("styleGuide") or ""))

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            agents = build_agents(AGENTS, self.settings, self.llm, loop, run, ctx, draft_id=draft_id, purpose="crew", prompt_version=PROMPT_VERSION, models=brief.get("models") or {})
            b = data_block("brief", {k: brief.get(k) for k in ("title", "gap", "audience", "intent", "outline", "supportingQueries", "codeExamples", "internalLinks", "category")})
            style = data_block("style_guide", brief.get("styleGuide", ""))
            fb = f"\n\nThe previous draft was rejected. Fix these problems:\n{feedback}" if feedback else ""
            research = Task(description=f"Research the article in this brief. Use vector_search and read_article for related site articles and fetch_allowlisted_docs for official documentation. List every source URL.\n\n{b}", expected_output="Research notes with facts, related site article paths and a list of source URLs.", agent=agents["researcher"])
            write = Task(description=f"Write the full article as MDX following the style guide. Use only facts from the research notes. Code examples must be minimal and complete.\n\n{b}\n\n{style}{fb}", expected_output="The complete article body in MDX (no front matter, no H1).", agent=agents["writer"], context=[research])
            review = Task(description="Check every command, flag and version in the draft against the research sources (fetch_allowlisted_docs when needed). List each claim without a source as needs_fact_check with the reason. Return the corrected body and the list.", expected_output="Corrected MDX body, then a list of needs_fact_check items.", agent=agents["reviewer"], context=[research, write])
            seo = Task(
                description=f"Produce the final draft as JSON matching the schema: title (≤ 60 chars), slug_suggestion, meta_description (120–155 chars), outline (H2s), body_mdx (the reviewed body), code_blocks, sources (only URLs from the research), fact_check_flags (from the review), internal_links (≤ 3, only existing site paths from vector_search). Use gsc_queries_for_topic for the target queries.\n\n{b}{fb}",
                expected_output="One JSON object matching NewArticleDraft.",
                agent=agents["seo_editor"],
                context=[research, write, review],
                output_pydantic=NewArticleDraft,
            )
            tasks = [research, write, review, seo]
            return make_crew(agents, tasks, self.settings), tasks

        o = await run_crew("editorial", build, self.settings, ctx)
        draft = self._result(o.output, o.tasks, brief, o.status, o.reason)
        draft = self._check_sources(draft, fetched)
        return CrewResult(draft=draft, status="incomplete" if draft.incomplete else "completed", tokens=o.tokens, cost_usd=o.cost_usd, tool_calls=o.tool_calls, fetched_sources=fetched)

    def _result(self, output: Any, tasks: list[Any], brief: dict[str, Any], status: str, reason: str | None) -> NewArticleDraft:
        final = getattr(output, "pydantic", None) if output is not None else None
        if isinstance(final, NewArticleDraft) and status == "completed":
            return final
        if output is not None and status == "completed":
            m = re.search(r"\{[\s\S]*\}", getattr(output, "raw", "") or "")
            if m:
                try:
                    return NewArticleDraft.model_validate(json.loads(m.group(0)))
                except ValueError:
                    pass
            reason = "the SEO editor's output did not match the schema"
        # Partial: whatever the completed tasks produced. The reviewer's corrected body beats the writer's.
        body = task_raw(tasks[2]) or task_raw(tasks[1])
        title = str(brief.get("title") or "Untitled draft")[:110]
        return NewArticleDraft(title=title, slug_suggestion=_slugify(title), meta_description="", outline=list(brief.get("outline") or []), body_mdx=body, incomplete=True, incomplete_reason=reason or "incomplete")

    @staticmethod
    def _check_sources(d: NewArticleDraft, fetched: list[str]) -> NewArticleDraft:
        got = {u.rstrip("/") for u in fetched}
        flags = list(d.fact_check_flags)
        for s in d.sources:
            if s.url.rstrip("/") not in got and not s.url.startswith("/"):
                flags.append(FactCheckFlag(claim=s.url, reason="source was not retrieved during research; verify it exists and says this", severity="warning"))
        return d.model_copy(update={"fact_check_flags": flags})
