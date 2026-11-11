"""Editorial Crew (new articles, sequential): Researcher → Technical writer → Technical reviewer → SEO editor.

Output: `NewArticleDraft`, assembled in code: the **body is the technical reviewer's corrected body**, and the SEO
editor returns metadata only (`SeoMetadata`: title, slug, meta description, outline, sources, fact-check flags,
internal links). The editor never re-emits the body, so a long article cannot be truncated inside its JSON and no
body rewrite can slip in after the technical review. Code blocks are extracted from the reviewed body. Runs inside
`new_article_flow`'s `draft` step. Limits and the Claude adapter are in crews/common.py. A cited source the crew never
retrieved during the run is flagged for the reviewer.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..llm import Llm
from ..schemas import CodeBlock, FactCheckFlag, InternalLinkSuggestion, NewArticleDraft, Source
from ..tools import ToolContext, data_block
from .common import AgentDef, CrewRun, build_agents, feedback_section, make_crew, run_crew, task_raw

PROMPT_VERSION = "seo-crew-v3"

AGENTS = [
    AgentDef("researcher", "Researcher", "Collect the facts, related site articles and official documentation the article needs, with sources.", "You research for a one-person technical publication. You only report what the sources say and you list every source URL you used.", ["vector_search", "read_article", "fetch_allowlisted_docs"]),
    AgentDef("writer", "Technical writer", "Write the article draft in MDX following the style guide, with working, minimal code examples.", "You write practical engineering tutorials in the site's voice. You never invent commands, flags, versions or URLs.", ["read_article"]),
    AgentDef("reviewer", "Technical reviewer", "Check every command, flag and version against the sources; mark anything without a source as needs_fact_check.", "You are a careful reviewer. Unsourced technical claims are flagged, not guessed.", ["fetch_allowlisted_docs"]),
    AgentDef("seo_editor", "SEO editor", "Produce the final title, meta description, heading plan and up to three internal links, as the required JSON. You never rewrite the body.", "You edit for search intent without clickbait: titles ≤ 60 characters, meta 120–155 characters, internal links only to existing site paths.", ["gsc_queries_for_topic", "vector_search"]),
]
ROLES = {a.key: {"role": a.role, "tools": a.tools} for a in AGENTS}

FACT_CHECK_MARKER = "NEEDS_FACT_CHECK:"
_MARKER_RE = re.compile(r"^\s*(?:\**\s*needs[_ ]fact[_ ]check\s*\**\s*:|#{1,6}\s*needs[_ ]fact[_ ]check\b[^\n]*$)", re.I | re.M)
_FENCE_RE = re.compile(r"^```(?:mdx|markdown|md)?[ \t]*\n([\s\S]*?)\n```[ \t]*$")
_OPEN_FENCE_RE = re.compile(r"^```(?:mdx|markdown|md)[ \t]*$", re.I | re.M)
_PREAMBLE_RE = re.compile(r"^#{1,6}\s*corrected\b[^\n]*\n+", re.I)
_CODE_RE = re.compile(r"```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```")


class SeoMetadata(BaseModel):
    """What the SEO editor returns. Extra keys (a body the model emitted anyway) are ignored, never used."""

    model_config = ConfigDict(extra="ignore")
    title: str
    slug_suggestion: str
    meta_description: str
    outline: list[str] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    fact_check_flags: list[FactCheckFlag] = Field(default_factory=list)
    internal_links: list[InternalLinkSuggestion] = Field(default_factory=list)


def _slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:80] or "draft"


def _unwrap_mdx(body: str) -> str:
    """Drop a reviewer preamble and an outer ```mdx wrapper. Inner code blocks come in pairs of fence lines, so with an
    odd count after the opening the last bare ``` closes the wrapper; with an even count the wrapper was cut off."""
    o = _OPEN_FENCE_RE.search(body)
    if not o:
        return _PREAMBLE_RE.sub("", body).strip()
    lines = body[o.end() :].strip("\n").split("\n")
    fences = [i for i, ln in enumerate(lines) if ln.strip().startswith("```")]
    if len(fences) % 2 == 1 and lines[fences[-1]].strip() == "```":
        lines = lines[: fences[-1]]
    return "\n".join(lines).strip()


def split_review(raw: str) -> tuple[str, list[FactCheckFlag]]:
    """The reviewer's answer → (corrected body, needs_fact_check items). The body is everything before the
    NEEDS_FACT_CHECK: line, with one wrapping ```mdx fence removed; items are `- claim | reason` lines after it."""
    text = (raw or "").strip()
    m = _MARKER_RE.search(text)
    body, rest = (text[: m.start()], text[m.end() :]) if m else (text, "")
    body = body.strip()
    f = _FENCE_RE.match(body)
    if f:
        body = f.group(1).strip()
    else:
        # "## Corrected MDX body", reviewer notes, then the body in a ```mdx fence: keep only the fenced body
        # (from the opening ```mdx line to the last bare ``` line; inner code blocks stay intact).
        body = _unwrap_mdx(body)
    flags: list[FactCheckFlag] = []
    for line in rest.splitlines():
        item = line.strip().lstrip("-*• ").strip()
        if not item or item.lower().rstrip(".") in ("none", "n/a", "nothing"):
            continue
        claim, _, reason = item.partition("|")
        flags.append(FactCheckFlag(claim=claim.strip()[:500], reason=(reason.strip() or "the technical reviewer could not verify this against a source")[:500], severity="warning"))
    return body, flags[:30]


def code_blocks_of(body: str) -> list[CodeBlock]:
    return [CodeBlock(lang=lang or "text", code=code.rstrip("\n")) for lang, code in _CODE_RE.findall(body or "")][:30]


def _parse_meta(output: Any) -> SeoMetadata | None:
    final = getattr(output, "pydantic", None) if output is not None else None
    if isinstance(final, SeoMetadata):
        return final
    m = re.search(r"\{[\s\S]*\}", getattr(output, "raw", "") or "") if output is not None else None
    if not m:
        return None
    try:
        return SeoMetadata.model_validate(json.loads(m.group(0)))
    except ValueError:
        return None


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

    async def run(self, brief: dict[str, Any], *, feedback: str | None = None, validator_feedback: str | None = None, feedback_untrusted: bool = False, draft_id: str | None = None) -> CrewResult:
        from crewai import Task

        fetched: list[str] = []
        ctx = ToolContext(self.web, self.retriever, self.settings.docs_allowlist, on_source=lambda u, _t: fetched.append(u), style=str(brief.get("styleGuide") or ""))

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            agents = build_agents(AGENTS, self.settings, self.llm, loop, run, ctx, draft_id=draft_id, purpose="crew", prompt_version=PROMPT_VERSION, crew="editorial", models=brief.get("models") or {})
            b = data_block("brief", {k: brief.get(k) for k in ("title", "gap", "audience", "intent", "outline", "supportingQueries", "codeExamples", "internalLinks", "category")})
            style = data_block("style_guide", brief.get("styleGuide", ""))
            fb = feedback_section(feedback, validator_feedback, untrusted=feedback_untrusted)
            research = Task(description=f"Research the article in this brief. Use vector_search and read_article for related site articles and fetch_allowlisted_docs for official documentation. List every source URL.\n\n{b}", expected_output="Research notes with facts, related site article paths and a list of source URLs.", agent=agents["researcher"])
            write = Task(description=f"Write the full article as MDX following the style guide. Use only facts from the research notes. Code examples must be minimal and complete.\n\n{b}\n\n{style}{fb}", expected_output="The complete article body in MDX (no front matter, no H1).", agent=agents["writer"], context=[research])
            review = Task(
                description=f"Check every command, flag and version in the draft against the research sources (fetch_allowlisted_docs when needed). Return the complete corrected MDX body (this is the body that will be published; do not shorten it), then a line `{FACT_CHECK_MARKER}` followed by one line per claim you could not verify, as `- claim | reason` (or `- none`).",
                expected_output=f"The complete corrected MDX body, then {FACT_CHECK_MARKER} and the list.",
                agent=agents["reviewer"],
                context=[research, write],
            )
            seo = Task(
                description=f"Produce the article's metadata as JSON matching the schema: title (≤ 60 chars), slug_suggestion, meta_description (120–155 chars), outline (the H2s of the reviewed body), sources (only URLs from the research), fact_check_flags (from the review), internal_links (≤ 3, only existing site paths from vector_search). Use gsc_queries_for_topic for the target queries. Do NOT include the article body: it is taken from the technical review unchanged.\n\n{b}{fb}",
                expected_output="One JSON object with title, slug_suggestion, meta_description, outline, sources, fact_check_flags and internal_links (no body).",
                agent=agents["seo_editor"],
                context=[research, review],
                output_pydantic=SeoMetadata,
            )
            tasks = [research, write, review, seo]
            return make_crew(agents, tasks, self.settings), tasks

        o = await run_crew("editorial", build, self.settings, ctx)
        draft = self._result(o.output, o.tasks, brief, o.status, o.reason)
        draft = self._check_sources(draft, fetched)
        return CrewResult(draft=draft, status="incomplete" if draft.incomplete else "completed", tokens=o.tokens, cost_usd=o.cost_usd, tool_calls=o.tool_calls, fetched_sources=fetched)

    def _result(self, output: Any, tasks: list[Any], brief: dict[str, Any], status: str, reason: str | None) -> NewArticleDraft:
        review_raw = task_raw(tasks[2]) if len(tasks) > 2 else ""
        body, review_flags = split_review(review_raw)
        flags = list(review_flags)
        if not body:
            # No technical review finished: the writer's body is kept for the human, marked unreviewed.
            body = (task_raw(tasks[1]) if len(tasks) > 1 else "").strip()
            if body:
                flags.append(FactCheckFlag(claim="whole article", reason="the technical review did not finish; verify every command and version", severity="warning"))
            if status == "completed":
                status, reason = "incomplete", "the technical reviewer returned no body"
        meta = _parse_meta(output) if status == "completed" else None
        if status == "completed" and meta is None:
            status, reason = "incomplete", "the SEO editor's output did not match the schema"
        if meta is not None and status == "completed":
            claims = {f.claim for f in meta.fact_check_flags}
            merged = [*meta.fact_check_flags, *(f for f in flags if f.claim not in claims)]
            return NewArticleDraft(title=meta.title, slug_suggestion=meta.slug_suggestion, meta_description=meta.meta_description, outline=meta.outline, body_mdx=body, code_blocks=code_blocks_of(body), sources=meta.sources, fact_check_flags=merged, internal_links=meta.internal_links)
        # Partial: whatever the completed tasks produced (the reviewer's corrected body beats the writer's).
        title = str(brief.get("title") or "Untitled draft")[:110]
        return NewArticleDraft(title=title, slug_suggestion=_slugify(title), meta_description="", outline=list(brief.get("outline") or []), body_mdx=body, code_blocks=code_blocks_of(body), fact_check_flags=flags, incomplete=True, incomplete_reason=reason or "incomplete")

    @staticmethod
    def _check_sources(d: NewArticleDraft, fetched: list[str]) -> NewArticleDraft:
        got = {u.rstrip("/") for u in fetched}
        flags = list(d.fact_check_flags)
        for s in d.sources:
            if s.url.rstrip("/") not in got and not s.url.startswith("/"):
                flags.append(FactCheckFlag(claim=s.url, reason="source was not retrieved during research; verify it exists and says this", severity="warning"))
        return d.model_copy(update={"fact_check_flags": flags})
