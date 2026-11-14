"""Editorial Crew (new articles, sequential): Researcher → Technical writer → Technical reviewer → SEO editor.

Output: `NewArticleDraft`, assembled in code: the **body is the technical reviewer's corrected body**, and the SEO
editor returns metadata only (`SeoMetadata`: title, slug, meta description, outline, sources, fact-check flags,
internal links). The editor never re-emits the body, so a long article cannot be truncated inside its JSON and no
body rewrite can slip in after the technical review. Code blocks are extracted from the reviewed body. Runs inside
`new_article_flow`'s `draft` step. Limits and the Claude adapter are in crews/common.py. A cited source the crew never
retrieved during the run is flagged for the reviewer.

v4 prompt (seo-crew-v4): the writer also gets the author's first-hand notes (brief.authorNotes, the only facts allowed
without a research source), up to two published articles as examples of voice and depth (brief.examples, form only),
and an explicit depth target; the brief block now carries diagrams, reading time and the item's notes.

v5 prompt (seo-crew-v5), two optional steps (Settings, also Admin → Advanced settings → Editorial crew):
- research_web_search: the researcher also holds `web_search` (Anthropic's server-side web search through the model
  API, at most research_web_search_max searches a run). A cited page that search found but the crew never opened is
  flagged for the human reviewer.
- editorial_critique: Researcher → Writer → Developmental editor (critique) → Writer (revision) → Technical reviewer →
  SEO editor. The editor lists concrete problems against a rubric; the writer revises once; the technical review then
  checks the revised body.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..llm import CallSpec, Llm
from ..schemas import CodeBlock, FactCheckFlag, InternalLinkSuggestion, NewArticleDraft, Source
from ..tools import ToolContext, data_block
from .common import UNTRUSTED, AgentDef, CrewRun, build_agents, feedback_section, make_crew, run_crew, task_raw

PROMPT_VERSION = "seo-crew-v5"

AGENTS = [
    AgentDef("researcher", "Researcher", "Collect the facts, related site articles and official documentation the article needs, with sources, in enough detail that the writer never has to guess.", "You research for a one-person technical publication. You only report what the sources say, you copy commands, flags, versions and defaults exactly, and you list every source URL you used.", ["vector_search", "read_article", "fetch_allowlisted_docs"]),
    AgentDef("writer", "Technical writer", "Write a complete, specific article in MDX that an experienced engineer would learn from, following the style guide, with working, minimal code examples.", "You write practical engineering tutorials in the site's voice: first person where the author did the work, the reason before the steps, real commands and their output, trade-offs and failure modes. You never invent commands, flags, versions, numbers or URLs, and you never pad.", ["read_article"]),
    AgentDef("reviewer", "Technical reviewer", "Check every command, flag and version against the sources; mark anything without a source as needs_fact_check.", "You are a careful reviewer. Unsourced technical claims are flagged, not guessed.", ["fetch_allowlisted_docs"]),
    AgentDef("seo_editor", "SEO editor", "Produce the final title, meta description, heading plan and up to three internal links, as the required JSON. You never rewrite the body.", "You edit for search intent without clickbait: titles ≤ 60 characters, meta 120–155 characters, internal links only to existing site paths.", ["gsc_queries_for_topic", "vector_search"]),
]
ROLES = {a.key: {"role": a.role, "tools": a.tools} for a in AGENTS}
# Optional fifth agent (settings.editorial_critique): reads the draft like a demanding editor, holds no tools.
CRITIC = AgentDef("critic", "Developmental editor", "Find what would make an experienced engineer stop reading or distrust the article, and say exactly what to change.", "You edit technical articles for a one-person engineering publication. You are specific and blunt: every point names the section, the problem and the fix. You never rewrite the article yourself and you never ask for padding.", [])


def agents_for(settings: Settings) -> list[AgentDef]:
    """The crew for this run: the four base agents, the researcher with web_search and the critic when switched on."""
    out = [AgentDef(a.key, a.role, a.goal, a.backstory, [*a.tools, "web_search"], a.max_tokens) if a.key == "researcher" and settings.research_web_search else a for a in AGENTS]
    return [*out, CRITIC] if settings.editorial_critique else out


BRIEF_KEYS = ("title", "gap", "audience", "intent", "outline", "supportingQueries", "codeExamples", "diagrams", "readingTimeMinutes", "internalLinks", "category", "notes")
AUTHOR_NOTES_CHARS = 6000
EXAMPLE_CHARS = 12_000  # per example article; the web app sends at most two

RESEARCH_TASK = (
    "Research the article in this brief so the writer can write it without guessing.\n"
    "1. vector_search and read_article: what this site has already published on the topic (to link to and not repeat).\n"
    "2. fetch_allowlisted_docs: the official documentation for every tool, command and feature in the outline. Open the specific pages (install, configuration reference, CLI reference, release notes), not only the landing page; a refused or failed fetch is a reason to try the next most specific official page.\n"
    "Report, per outline section: the facts with their source URL, exact commands, flags, defaults and current version numbers as written in the source, known limits and common failure modes. Say plainly which outline sections you found no source for. End with the list of every source URL you retrieved."
)
WRITE_TASK = (
    "Write the full article as MDX following the style guide.\n"
    "Facts: use only the research notes and the author's first-hand notes. The author's notes are their own experience (what they built, ran, measured or decided): write those parts in the first person and keep their commands, versions and numbers exactly. Where neither has what a section needs, say less rather than invent.\n"
    "Depth: cover every heading in the brief's outline. Each section explains why before how, shows the command or configuration with the output or result to expect, and names the trade-off, limit or failure mode an engineer would hit. Prefer one worked example carried through the article over several disconnected snippets. Use a table for a comparison, a list for steps, and a mermaid diagram where the brief asks for one. Aim for the brief's reading time (about 220 words a minute); without one, write 1,500 to 2,500 words of prose.\n"
    "Opening and ending: open with the concrete problem or result in two or three sentences, with no generic introduction; end with what to check or do next, not a recap.\n"
    "Code: every block declares its language and is complete enough to copy and run; no placeholders that hide the hard part.\n"
    "The example articles show the voice, depth and structure to match. Take nothing factual from them and do not reuse their sentences."
)
WEB_SEARCH_STEP = (
    "\n3. web_search: for what the official documentation does not settle (current release and version numbers, recent changes, known issues, how practitioners solved it). Use specific queries, a few searches at most. "
    "Treat search results as leads: prefer the official page they point to and open it with fetch_allowlisted_docs when its domain allows; say which facts rest only on a search result."
)
CRITIQUE_TASK = (
    "Read the draft as the article's first demanding reader and list what must change. Judge it against:\n"
    "1. Substance: does every section teach something specific (a command, a configuration, a number, a decision and its reason)? Name each generic or padded passage.\n"
    "2. Accuracy to the notes: anything stated that is neither in the research notes nor in the author's first-hand notes? Anything in the research that the draft got wrong or left out and the reader needs?\n"
    "3. Completeness: is every outline heading covered, with the result to expect and the failure mode an engineer would hit?\n"
    "4. Order and flow: does it open with the concrete problem or result, explain why before how, and end with what to do next?\n"
    "5. Code: is every block complete enough to copy and run, with its language declared and no placeholder hiding the hard part?\n"
    "6. Voice: the style guide, first person only where the author did the work, no filler or sales language.\n"
    "Return a numbered list, most important first, at most 12 points. Each point: the section heading, what is wrong (quote a few words), and the exact change to make. "
    "Do not rewrite the article and do not ask for length for its own sake. Last line: `VERDICT: revise` or, only if nothing above applies, `VERDICT: ready`."
)
REVISE_TASK = (
    "Revise your draft using the editor's critique. Apply every point that is right; where a point asks for a fact that is in neither the research notes nor the author's first-hand notes, do not invent it: cut the claim or say less. "
    "Keep what the critique did not fault, keep every code block that is correct, and keep the style guide. If the verdict is `VERDICT: ready`, return the draft unchanged. "
    "Return the complete revised article body in MDX (no front matter, no H1, no commentary about the changes)."
)
SEARCH_SYSTEM = (
    "You are the web search step of a researcher for a technical publication. Search the web for the query and report only what the results say: "
    "the facts, each with the URL it came from; commands, flags and version numbers exactly as written; dates of releases and changes. "
    "Prefer official documentation, release notes and maintainers' posts over forums and aggregators. Say when results disagree or when nothing reliable was found. "
    "Do not answer from memory and do not add advice. Plain text, at most 300 words."
)
REVIEW_TASK = (
    "Check every command, flag and version in the draft against the research sources (fetch_allowlisted_docs when needed). Statements that come from the author's first-hand notes are the author's own experience: keep them and do not flag them unless they contradict a source. "
    "Correct what is wrong; do not shorten, summarise or restyle the article, and keep every section and code block."
)

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


def author_notes_block(brief: dict[str, Any]) -> str:
    """The author's first-hand notes as a data block ("" when there are none)."""
    text = str(brief.get("authorNotes") or "").strip()
    return f"\n\n{data_block('author_first_hand_notes', text[:AUTHOR_NOTES_CHARS])}" if text else ""


def examples_block(brief: dict[str, Any]) -> str:
    """Up to two published articles (title, path, body) as examples of form ("" when the web app sent none)."""
    rows = [e for e in (brief.get("examples") or []) if isinstance(e, dict) and str(e.get("body") or "").strip()][:2]
    if not rows:
        return ""
    return "\n\n" + data_block("example_articles", [{"title": str(e.get("title") or "")[:200], "path": str(e.get("path") or "")[:300], "body": str(e["body"])[:EXAMPLE_CHARS]} for e in rows])


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

        from ..runtime import effective_settings

        settings = await effective_settings(self.settings, self.web)  # admin-saved crew options, if any
        fetched: list[str] = []
        found: list[str] = []  # pages web search returned (not opened by the crew)
        order: list[str] = []  # task keys in run order, for _result
        ctx = ToolContext(self.web, self.retriever, settings.docs_allowlist, on_source=lambda u, _t: fetched.append(u), style=str(brief.get("styleGuide") or ""))
        search = settings.research_web_search and hasattr(self.llm, "web_search")
        critique_on = settings.editorial_critique

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            if search:
                ctx.searcher = self._searcher(settings, run, found, draft_id, (brief.get("models") or {}).get("web_search"))
            agents = build_agents(agents_for(settings), settings, self.llm, loop, run, ctx, draft_id=draft_id, purpose="crew", prompt_version=PROMPT_VERSION, crew="editorial", models=brief.get("models") or {})
            b = data_block("brief", {k: brief.get(k) for k in BRIEF_KEYS})
            style = data_block("style_guide", brief.get("styleGuide", ""))
            notes = author_notes_block(brief)
            examples = examples_block(brief)
            fb = feedback_section(feedback, validator_feedback, untrusted=feedback_untrusted)
            research = Task(description=f"{RESEARCH_TASK}{WEB_SEARCH_STEP if search else ''}\n\n{b}{notes}", expected_output="Research notes per outline section with facts, exact commands and versions, related site article paths, gaps, and a list of source URLs.", agent=agents["researcher"])
            write = Task(description=f"{WRITE_TASK}\n\n{b}{notes}\n\n{style}{examples}{fb}", expected_output="The complete article body in MDX (no front matter, no H1).", agent=agents["writer"], context=[research])
            draft_task = write
            extra: list[Any] = []
            if critique_on:
                critique = Task(description=f"{CRITIQUE_TASK}\n\n{b}{notes}\n\n{style}", expected_output="A numbered list of at most 12 concrete changes (section, problem, fix), then a VERDICT line.", agent=agents["critic"], context=[research, write])
                revise = Task(description=f"{REVISE_TASK}\n\n{b}{notes}\n\n{style}", expected_output="The complete revised article body in MDX (no front matter, no H1).", agent=agents["writer"], context=[research, write, critique])
                extra, draft_task = [critique, revise], revise
            review = Task(
                description=f"{REVIEW_TASK}{notes}\n\nReturn the complete corrected MDX body (this is the body that will be published; do not shorten it), then a line `{FACT_CHECK_MARKER}` followed by one line per claim you could not verify, as `- claim | reason` (or `- none`).",
                expected_output=f"The complete corrected MDX body, then {FACT_CHECK_MARKER} and the list.",
                agent=agents["reviewer"],
                context=[research, draft_task],
            )
            seo = Task(
                description=f"Produce the article's metadata as JSON matching the schema: title (≤ 60 chars), slug_suggestion, meta_description (120–155 chars), outline (the H2s of the reviewed body), sources (only URLs from the research), fact_check_flags (from the review), internal_links (≤ 3, only existing site paths from vector_search). Use gsc_queries_for_topic for the target queries. Do NOT include the article body: it is taken from the technical review unchanged.\n\n{b}{fb}",
                expected_output="One JSON object with title, slug_suggestion, meta_description, outline, sources, fact_check_flags and internal_links (no body).",
                agent=agents["seo_editor"],
                context=[research, review],
                output_pydantic=SeoMetadata,
            )
            tasks = [research, write, *extra, review, seo]
            order[:] = ["research", "write", *(["critique", "revise"] if critique_on else []), "review", "seo"]
            return make_crew(agents, tasks, settings), tasks

        o = await run_crew("editorial", build, settings, ctx)
        draft = self._result(o.output, o.tasks, brief, o.status, o.reason, order)
        draft = self._check_sources(draft, fetched, found)
        return CrewResult(draft=draft, status="incomplete" if draft.incomplete else "completed", tokens=o.tokens, cost_usd=o.cost_usd, tool_calls=o.tool_calls, fetched_sources=fetched)

    def _searcher(self, settings: Settings, run: CrewRun, found: list[str], draft_id: str | None, model: str | None) -> Any:
        """The researcher's web_search: one small model call with Anthropic's server-side search per query, counted
        against the run's token cap and the monthly budget, at most research_web_search_max a run. Any failure (the
        tool not enabled for the organization, a timeout, the budget) becomes a refusal the researcher can read, and
        search stays off for the rest of the run: the crew carries on with the documentation."""
        used = [0]
        off = [""]
        limit = settings.research_web_search_max

        async def search(query: str) -> str:
            if off[0]:
                return data_block("search_refused", {"reason": off[0]})
            if used[0] >= limit:
                return data_block("search_refused", {"reason": f"the limit of {limit} web searches for this run is reached"})
            run.check()
            used[0] += 1
            spec = CallSpec(model=model or settings.crew_models.get("editorial.web_search") or settings.draft_model, purpose="crew", prompt_version=PROMPT_VERSION, cached_system=[UNTRUSTED, SEARCH_SYSTEM], user=f"Search query: {query}", max_tokens=1500, draft_id=draft_id, run_id=run.run_id, agent="researcher")
            try:
                r = await asyncio.wait_for(self.llm.web_search(spec, max_uses=2), timeout=50)  # type: ignore[attr-defined]
            except Exception as e:  # search is optional: report it to the researcher and carry on
                off[0] = f"web search is not available in this run ({type(e).__name__})"
                return data_block("search_refused", {"reason": off[0]})
            run.add(r.usage)
            for s in r.sources:
                found.append(s["url"])
            return data_block("web_search", {"query": query, "report": r.text[:6000], "results": r.sources[:10]})

        return search

    def _result(self, output: Any, tasks: list[Any], brief: dict[str, Any], status: str, reason: str | None, order: list[str] | None = None) -> NewArticleDraft:
        keys = order or ["research", "write", "review", "seo"]
        raw = {k: task_raw(t) for k, t in zip(keys, tasks, strict=False)}
        body, review_flags = split_review(raw.get("review", ""))
        flags = list(review_flags)
        if not body:
            # No technical review finished: the latest body (revised, else the first draft) is kept for the human,
            # marked unreviewed.
            body = (raw.get("revise") or raw.get("write") or "").strip()
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
    def _check_sources(d: NewArticleDraft, fetched: list[str], found: list[str] | None = None) -> NewArticleDraft:
        got = {u.rstrip("/") for u in fetched}
        searched = {u.rstrip("/") for u in (found or [])}
        flags = list(d.fact_check_flags)
        for s in d.sources:
            url = s.url.rstrip("/")
            if url in got or s.url.startswith("/"):
                continue
            if url in searched:
                flags.append(FactCheckFlag(claim=s.url, reason="found by web search but not opened by the crew; read the page before relying on it", severity="warning"))
            else:
                flags.append(FactCheckFlag(claim=s.url, reason="source was not retrieved during research; verify it exists and says this", severity="warning"))
        return d.model_copy(update={"fact_check_flags": flags})
