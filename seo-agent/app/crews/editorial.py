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

v5 prompt (seo-crew-v5): the researcher's notes have a length budget (about 1,500 words, at most 3,000). With no
budget, after ten documentation fetches it tried to copy them into its final answer and ran past its 8,192-token cap.

Improve (2026-11-18): when the brief carries `currentDraft` (the item's CMS draft as the editor left it), the writer
revises that draft instead of writing a new one (REVISE_TASK), and the researcher is told to check its claims. The
reviewer and SEO editor work as before on the writer's result.

v6 prompt (seo-crew-v6): notes for the editor never go in the body. The site renders bodies as plain Markdown
(moks-cms/src/lib/mdx/compile.ts, `format: "md"`), so a `{/* TODO(owner): … */}` the writer added was printed in the
review preview and would have been published. The writer and reviewer now list such notes under NEEDS_FACT_CHECK, and
`extract_editor_notes` moves any that are still in the body (MDX or HTML comments, <Todo>; never inside code) into
fact-check flags, which the review page lists. It also takes `{ /* … */ }`, a comment that never closes (to the end of
its paragraph), and a line or [bracket] that starts with TODO(…): or FIXME:.

v7 prompt (seo-crew-v7, 2026-11-18): an article on Prometheus, Kubernetes and OpenTelemetry stopped at the 300,000-token
cap inside the SEO editor step, with 19 notes, many of them "the fetch returned no content" or "navigation only". The
fetch tool now reads a page's <main> content, and a cut page ends with the anchors of its later sections; the
researcher is told to fetch `url#anchor` instead of trying other pages. When the crew stops after the technical review
(a limit in the SEO editor step, or an editor answer that does not match the schema), one short call without tools
writes the title and meta description (`fallback_metadata`): the outline is the reviewed body's H2s and the sources are
the pages retrieved during the run. The draft stays incomplete (no internal links, no SEO editor review), but it is no
longer saved with an empty meta description. A cited source matches a retrieved page without its #fragment.

moks-rag context (2026-11-26): when new_article_flow's `ground` step retrieved context from the shared moks-rag
service (app/site_context.py), `run(rag_context=…)` adds it as data blocks: the researcher gets seo_intel (keyword
clusters, Search Console performance, competitor briefs, brand/style guidelines) and site_articles (what the site's
published articles say on the topic), the writer site_articles, the SEO editor seo_intel and the existing articles to
link to; when an article already covers the keyword, the researcher and the writer are told to differ from it and link
to it. Without that context the prompts are exactly as before.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..llm import CallSpec, InvalidOutput, Llm, Usage
from ..runs import CURRENT_RUN_ID
from ..schemas import CodeBlock, FactCheckFlag, InternalLinkSuggestion, NewArticleDraft, Source
from ..tools import ToolContext, data_block
from . import config as crew_config
from .common import UNTRUSTED, AgentDef, CrewRun, build_agents, feedback_section, make_crew, run_crew, task_raw
from .config import CrewDef, TaskDef
from .skills import editorial_tags

PROMPT_VERSION = "seo-crew-v7"

log = logging.getLogger("seo_agent.crews")

AGENTS = [
    AgentDef("researcher", "Researcher", "Collect the facts, related site articles and official documentation the article needs, with sources, in enough detail that the writer never has to guess.", "You research for a one-person technical publication. You only report what the sources say, you copy commands, flags, versions and defaults exactly, and you list every source URL you used.", ["vector_search", "read_article", "fetch_allowlisted_docs"], max_tokens=8192),  # detailed notes: 4,096 cut them off
    AgentDef("writer", "Technical writer", "Write a complete, specific article in MDX that an experienced engineer would learn from, following the style guide, with working, minimal code examples.", "You write practical engineering tutorials in the site's voice: first person where the author did the work, the reason before the steps, real commands and their output, trade-offs and failure modes. You never invent commands, flags, versions, numbers or URLs, and you never pad.", ["read_article"]),
    AgentDef("reviewer", "Technical reviewer", "Check every command, flag and version against the sources; mark anything without a source as needs_fact_check.", "You are a careful reviewer. Unsourced technical claims are flagged, not guessed.", ["fetch_allowlisted_docs"]),
    AgentDef("seo_editor", "SEO editor", "Produce the final title, meta description, heading plan and up to three internal links, as the required JSON. You never rewrite the body.", "You edit for search intent without clickbait: titles ≤ 60 characters, meta 120–155 characters, internal links only to existing site paths.", ["gsc_queries_for_topic", "vector_search"]),
]
ROLES = {a.key: {"role": a.role, "tools": a.tools} for a in AGENTS}

BRIEF_KEYS = ("title", "gap", "audience", "intent", "outline", "supportingQueries", "codeExamples", "diagrams", "readingTimeMinutes", "internalLinks", "category", "notes")
AUTHOR_NOTES_CHARS = 6000
RAG_NOTE = (
    "Retrieved for this brief from the site's shared knowledge base: seo_intel holds keyword clusters, Search Console "
    "performance, competitor briefs and brand and style guidelines; site_articles holds what this site's published "
    "articles already say on the topic. Use them to target the right queries and to stay consistent with the site and "
    "not repeat it. They are not research sources: never cite them as sources."
)
EXAMPLE_CHARS = 12_000  # per example article; the web app sends at most two

RESEARCH_TASK = (
    "Research the article in this brief so the writer can write it without guessing.\n"
    "1. vector_search and read_article: what this site has already published on the topic (to link to and not repeat).\n"
    "2. fetch_allowlisted_docs: the official documentation for every tool, command and feature in the outline. Open the specific pages (install, configuration reference, CLI reference, release notes), not only the landing page; a refused or failed fetch is a reason to try the next most specific official page. A long page is cut and ends with the anchors of its later sections: fetch the same URL with the anchor you need (url#anchor) rather than another page.\n"
    "Report, per outline section, as short bullets: the facts the writer needs with their source URL, the exact commands, flags, defaults and current version numbers as written in the source, and the known limits and common failure modes. Say plainly which outline sections you found no source for. End with the list of every source URL you retrieved.\n"
    "Keep the notes compact, about 1,500 words in total and never more than 3,000: they are notes for the writer, not a copy of the documentation. Quote a command or config snippet only when the article will use it, and only the lines that matter; summarise everything else in one line with its URL. Stop fetching once each outline section has a source."
)
FACT_CHECK_MARKER = "NEEDS_FACT_CHECK:"
NOTES_RULE = (
    "Notes for the editor never go in the body: the site renders it as plain Markdown, so a comment ({/* */} or <!-- -->), JSX or a TODO line is published as text. "
    f"Put what the editor must check or add (an unsourced claim, real command output to capture, a link to confirm) after the body: a line `{FACT_CHECK_MARKER}` followed by one `- claim | reason` line each. Move any such note already in a draft there."
)
WRITE_INSTRUCTIONS = (
    "Write the full article as MDX following the style guide.\n"
    "Facts: use only the research notes and the author's first-hand notes. The author's notes are their own experience (what they built, ran, measured or decided): write those parts in the first person and keep their commands, versions and numbers exactly. Where neither has what a section needs, say less rather than invent.\n"
    "Depth: cover every heading in the brief's outline. Each section explains why before how, shows the command or configuration with the output or result to expect, and names the trade-off, limit or failure mode an engineer would hit. Prefer one worked example carried through the article over several disconnected snippets. Use a table for a comparison, a list for steps, and a mermaid diagram where the brief asks for one. Aim for the brief's reading time (about 220 words a minute); without one, write 1,500 to 2,500 words of prose.\n"
    "Opening and ending: open with the concrete problem or result in two or three sentences, with no generic introduction; end with what to check or do next, not a recap.\n"
    "Code: every block declares its language and is complete enough to copy and run; no placeholders that hide the hard part.\n"
    "The example articles show the voice, depth and structure to match. Take nothing factual from them and do not reuse their sentences."
)
REVISE_INSTRUCTIONS = (
    "Revise the current draft (the current_draft block) into the best version of this article, following the style guide. Do not start over.\n"
    "Keep: its structure and headings unless the outline needs a section it lacks, the author's voice, every first-hand passage, and everything that is correct.\n"
    "Fix: commands, flags, versions and facts that the research notes contradict; sections that are missing, thin or vague (cover every heading in the brief's outline, why before how, with the output or result to expect and the trade-off an engineer would hit); code that is incomplete, inconsistent or not runnable.\n"
    "Cut: padding, repetition and generic introductions or recaps.\n"
    "Facts: use only the research notes, the author's first-hand notes and what the current draft already says correctly; where none has what a section needs, say less rather than invent.\n"
    "Return the complete revised article body in MDX (no front matter, no H1), not a list of changes."
)
WRITE_TASK = f"{WRITE_INSTRUCTIONS}\n{NOTES_RULE}"
REVISE_TASK = f"{REVISE_INSTRUCTIONS}\n{NOTES_RULE}"
CURRENT_DRAFT_CHARS = 60_000  # the web app sends at most this much
REVIEW_TASK = (
    "Check every command, flag and version in the draft against the research sources (fetch_allowlisted_docs when needed). Statements that come from the author's first-hand notes are the author's own experience: keep them and do not flag them unless they contradict a source. "
    "Correct what is wrong; do not shorten, summarise or restyle the article, and keep every section and code block. "
    "Leave no note for the editor in the body (a {/* */} or <!-- --> comment, JSX, a TODO line): the site renders plain Markdown and would publish it as text."
)

RESEARCH_OUTPUT = "Compact research notes (about 1,500 words, at most 3,000), as bullets per outline section: facts, exact commands and versions, related site article paths, gaps, and a list of source URLs."
REVIEW_CONTRACT = (
    "Return the complete corrected MDX body (this is the body that will be published; do not shorten it), then a line "
    f"`{FACT_CHECK_MARKER}` followed by one line per claim you could not verify and per note for the editor (the writer's list after its body, "
    "and any note left in the body), as `- claim | reason` (or `- none`)."
)
SEO_TASK = (
    "Produce the article's metadata as JSON matching the schema: title (≤ 60 chars), slug_suggestion, meta_description (120–155 chars), "
    "outline (the H2s of the reviewed body), sources (only URLs from the research), fact_check_flags (from the review), internal_links "
    "(≤ 3, only existing site paths from vector_search). Use gsc_queries_for_topic for the target queries. Do NOT include the article body: "
    "it is taken from the technical review unchanged."
)
# The crew's editable configuration (crews/config.py, CrewAI console → Crews). The brief, author notes, examples, style
# guide and feedback blocks, the rule that editor notes never go in the body, the review's output format and the SEO
# editor's schema stay in code.
CREW = CrewDef(
    crew="editorial",
    label="Editorial crew",
    description="Researches, writes, reviews and edits a new article from a calendar item (or revises its current draft); the draft waits for review.",
    prompt_version=PROMPT_VERSION,
    agents=tuple(AGENTS),
    tasks=(
        TaskDef("research", "researcher", "Research", RESEARCH_TASK, RESEARCH_OUTPUT, contract="Then the brief block and the author's first-hand notes."),
        TaskDef("write", "writer", "Write (new article)", WRITE_INSTRUCTIONS, "The complete article body in MDX (no front matter, no H1).", contract=f"{NOTES_RULE}\nThen the brief, the author's notes, the style guide, the example articles and any feedback."),
        TaskDef("revise", "writer", "Revise (Improve)", REVISE_INSTRUCTIONS, "The complete article body in MDX (no front matter, no H1).", contract=f"{NOTES_RULE}\nThen the brief, the author's notes, the current draft, the style guide, the example articles and any feedback."),
        TaskDef("review", "reviewer", "Technical review", REVIEW_TASK, f"The complete corrected MDX body, then {FACT_CHECK_MARKER} and the list.", contract=f"Then the author's notes, and: {REVIEW_CONTRACT}", output_editable=False),
        TaskDef("seo", "seo_editor", "SEO metadata", SEO_TASK, "One JSON object with title, slug_suggestion, meta_description, outline, sources, fact_check_flags and internal_links (no body).", contract="Then the brief and any feedback. The answer is parsed as SeoMetadata (title, slug, meta description, outline, sources, flags, internal links)."),
    ),
    replay=("new_article_flow",),
)

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


class FallbackMetadata(BaseModel):
    """The fallback call's answer when the SEO editor did not finish (see EditorialCrew.fallback_metadata)."""

    model_config = ConfigDict(extra="ignore")
    title: str
    meta_description: str


FALLBACK_BODY_CHARS = 6000  # the opening of the reviewed body: enough for the topic, small next to the 300k crew cap
FALLBACK_MAX_TOKENS = 1024
FALLBACK_TASK = (
    "The SEO editor did not finish on this article. Write its search metadata as JSON: title (at most 60 characters, "
    "the article's subject and the reader's goal, no clickbait) and meta_description (120 to 155 characters: what the "
    "reader learns or can do, specific to this article). Use only the brief, the article's headings and its opening."
)
_H2_RE = re.compile(r"^##[ \t]+(.+?)[ \t#]*$", re.M)


def h2_outline(body: str) -> list[str]:
    """The body's H2 headings outside code blocks (what the SEO editor's outline is)."""
    prose = re.sub(r"^```[\s\S]*?^```", "", body, flags=re.M)
    return [h.strip() for h in _H2_RE.findall(prose)][:30]


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
        if not item or item.lower().rstrip(".") in ("none", "n/a", "nothing") or _MARKER_RE.match(item):
            continue  # a second marker line: the reviewer copied the writer's list, then wrote its own
        claim, reason = _split_flag(item)
        flags.append(FactCheckFlag(claim=claim[:500], reason=(reason or "the technical reviewer could not verify this against a source")[:500], severity="warning"))
    return body, merge_flags(flags)[:30]


def _split_flag(item: str) -> tuple[str, str]:
    """`claim | reason` → (claim, reason). The separator is the last `|` that is not escaped and not inside a `code`
    span, so a shell pipe in the claim (`ps -eo stat,cmd \\| awk ...`) stays in the claim. With unbalanced backticks
    the spans cannot be trusted and the last unescaped `|` is used."""
    seps: list[int] = []
    spans: list[int] = []
    code = False
    for i, ch in enumerate(item):
        if ch == "`":
            code = not code
        elif ch == "|" and (i == 0 or item[i - 1] != "\\"):
            seps.append(i)
            if not code:
                spans.append(i)
    cut = (seps if code else spans)[-1:] or [-1]
    claim, reason = (item, "") if cut[0] == -1 else (item[: cut[0]], item[cut[0] + 1 :])
    return claim.replace("\\|", "|").strip(), reason.strip()


def _words(s: str) -> str:
    """Text without its formatting (backticks, `->` for `→`, a comma, case): what two copies of a flag share."""
    return " ".join(re.findall(r"[a-z0-9]+", s.lower()))


def _starts_alike(a: str, b: str) -> bool:
    return a == b or a.startswith(f"{b} ") or b.startswith(f"{a} ")


def merge_flags(*groups: list[FactCheckFlag]) -> list[FactCheckFlag]:
    """Each flag once. The SEO editor copies the reviewer's flags with the formatting changed and sometimes a sentence
    added, so an exact comparison listed most claims twice. A copy has the claim's words and the reason's words or
    their start; the first wording and the fuller reason are kept, and an error outranks a warning. Flags that share a
    claim but give another reason (one per note left in a draft) all stay."""
    out: list[FactCheckFlag] = []
    for f in (f for g in groups for f in g):
        claim, reason = _words(f.claim) or f.claim, _words(f.reason)
        i = next((i for i, o in enumerate(out) if (_words(o.claim) or o.claim) == claim and _starts_alike(_words(o.reason), reason)), None)
        if i is None:
            out.append(f)
            continue
        kept = out[i]
        update: dict[str, str] = {}
        if len(reason) > len(_words(kept.reason)):
            update["reason"] = f.reason
        if f.severity == "error":
            update["severity"] = "error"
        out[i] = kept.model_copy(update=update) if update else kept
    return out


# A note for the editor left in the body. In order: inline code (kept, group 1); an MDX comment, also `{ /* … */ }`; an
# HTML comment; <Todo>…</Todo>; a comment that never closes (the writer was cut off or forgot `*/}`), to the end of its
# paragraph; a line, or a [bracket], that starts with TODO(…): or FIXME:. A comment never runs past the start of another
# one, so an unclosed `{/*` cannot swallow the article up to a later note's `*/}`.
_PARAGRAPH = r"[^\n]*(?:\n(?![ \t]*(?:\n|\Z))[^\n]*)*"
_TODO_LEAD = r"(?:TODO|FIXME)(?:\([^)\n]*\))?[*_]{0,2}[ \t]*:[*_]{0,2}[ \t]*"
_NOTE_RE = re.compile(
    r"(`+)[^\n]*?\1"
    r"|\{[ \t]*/\*((?:(?!\{[ \t]*/\*)[\s\S])*?)\*/[ \t]*\}"
    r"|<!--((?:(?!<!--)[\s\S])*?)-->"
    r"|<Todo>([\s\S]*?)</Todo>"
    rf"|(?:\{{[ \t]*/\*|<!--)({_PARAGRAPH})"
    rf"|^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+)?[*_]{{0,2}}{_TODO_LEAD}([^\n]*)$"
    rf"|\[[ \t]*{_TODO_LEAD}([^\]\n]*)\]",
    re.M,
)
_FENCE_LINE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_NOTE_ITEM_RE = re.compile(r"(?:^|\s)\(\d{1,2}\)\s+")
_NOTE_PREFIX_RE = re.compile(r"^(?:TODO|NOTE|FIXME)(?:\([^)]*\))?\s*:\s*", re.I)
_BLANK_RUN_RE = re.compile(r"\n(?:[ \t]*\n){2,}")
NOTE_CLAIM = "Note left in the draft"
MAX_NOTE_FLAGS = 10


def _note_items(note: str) -> list[str]:
    """A note → its numbered items ("(1) … (2) …"), or the whole note; a lead-in that ends with ':' is dropped."""
    text = " ".join(_NOTE_PREFIX_RE.sub("", note.strip()).split())
    parts = [p.strip() for p in _NOTE_ITEM_RE.split(text)]
    if len(parts) < 3:
        return [text] if text else []
    lead, items = parts[0], [p for p in parts[1:] if p]
    return items if not lead or lead.endswith(":") else [lead, *items]


def extract_editor_notes(body: str) -> tuple[str, list[FactCheckFlag]]:
    """Body → (the body without notes for the editor, one fact-check flag per note item). The site renders plain
    Markdown, where an MDX comment, the text inside <Todo> and a TODO line are printed on the page. Code (fenced or
    inline) is kept."""
    notes: list[str] = []

    def take(m: re.Match[str]) -> str:
        if m.group(1) is not None:
            return m.group(0)
        notes.append(next(g for g in m.groups()[1:] if g is not None))
        return ""

    segments: list[tuple[bool, list[str]]] = [(False, [])]
    fence = ""
    for line in body.split("\n"):
        f = _FENCE_LINE_RE.match(line)
        if not fence and f:
            fence = f.group(1)
            segments.append((True, [line]))
        elif fence and f and f.group(1)[0] == fence[0] and len(f.group(1)) >= len(fence) and not f.group(2).strip():
            segments[-1][1].append(line)
            fence = ""
            segments.append((False, []))
        else:
            segments[-1][1].append(line)
    out = []
    for code, lines in segments:
        text = "\n".join(lines)
        if not code:
            cleaned = _NOTE_RE.sub(take, text)
            text = _BLANK_RUN_RE.sub("\n\n", cleaned) if cleaned != text else text
        out.append(text)
    if not notes:
        return body, []
    items = [i for n in notes for i in _note_items(n)]
    flags = [FactCheckFlag(claim=NOTE_CLAIM, reason=i[:500], severity="warning") for i in items[:MAX_NOTE_FLAGS]]
    if len(items) > MAX_NOTE_FLAGS:
        flags[-1] = FactCheckFlag(claim=NOTE_CLAIM, reason=f"{len(items) - MAX_NOTE_FLAGS + 1} more notes were removed from the body; regenerate or check the whole draft", severity="warning")
    return "\n".join(out).strip(), flags


def current_draft_block(brief: dict[str, Any]) -> str:
    """The editor's current draft to improve, as a data block ("" for a new article)."""
    text = str(brief.get("currentDraft") or "").strip()
    return f"\n\n{data_block('current_draft', text[:CURRENT_DRAFT_CHARS])}" if text else ""


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


def rag_sections(ctx: dict[str, Any] | None) -> dict[str, str]:
    """The moks-rag context (new_article_flow's ground step) as text for each task; all empty without it."""
    out = {"research": "", "write": "", "seo": ""}
    if not ctx:
        return out
    intel = data_block("seo_intel", ctx["seo_intel"]) if ctx.get("seo_intel") else ""
    site = data_block("site_articles", ctx["site_articles"]) if ctx.get("site_articles") else ""
    covered = [m for m in ((ctx.get("cannibalization") or {}).get("matches") or []) if m.get("flagged")]
    links = ctx.get("internal_links") or []
    warn = ""
    if covered:
        warn = (
            "\n\nThe site already has an article on this keyword (existing_coverage): make this one clearly different in angle, depth or audience, "
            "do not repeat what that article says, and link to it.\n\n"
            + data_block("existing_coverage", [{"title": m.get("title"), "url": m.get("url"), "why": "; ".join(m.get("reasons") or [])} for m in covered])
        )
    if intel or site or warn:
        out["research"] = f"\n\n{RAG_NOTE}" + "".join(f"\n\n{x}" for x in (intel, site) if x) + warn
    if site or warn:
        out["write"] = f"\n\n{RAG_NOTE}" + (f"\n\n{site}" if site else "") + warn
    cands = [{"path": c.get("path"), "title": c.get("title"), "anchors": c.get("anchors") or [], "fits_under": c.get("matched_heading") or ""} for c in links if c.get("path")]
    if intel or cands:
        out["seo"] = f"\n\n{RAG_NOTE}" + (f"\n\n{intel}" if intel else "")
        if cands:
            out["seo"] += "\n\nPublished articles of this site that match the brief (internal_link_candidates): internal_links may link to these paths, with one of their anchors where the body already uses those words.\n\n" + data_block("internal_link_candidates", cands)
    return out


@dataclass
class CrewResult:
    draft: NewArticleDraft
    status: str  # completed | incomplete
    tokens: int
    cost_usd: float
    tool_calls: list[tuple[str, str]]
    fetched_sources: list[str]
    config: dict[str, Any] | None = None  # which crew configuration ran (crews/config.py Effective.summary)


class EditorialCrew:
    def __init__(self, settings: Settings, llm: Llm, web: Any, retriever: Any):
        self.settings, self.llm, self.web, self.retriever = settings, llm, web, retriever

    async def run(self, brief: dict[str, Any], *, feedback: str | None = None, validator_feedback: str | None = None, feedback_untrusted: bool = False, draft_id: str | None = None, rag_context: dict[str, Any] | None = None) -> CrewResult:
        from crewai import Task

        fetched: list[str] = []
        titles: dict[str, str] = {}

        def on_source(url: str, title: str) -> None:
            fetched.append(url)
            titles.setdefault(url, title)

        ctx = ToolContext(self.web, self.retriever, self.settings.docs_allowlist, on_source=on_source, style=str(brief.get("styleGuide") or ""))
        cfg = await crew_config.load("editorial", self.web)

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            agents = build_agents(cfg.agents(), self.settings, self.llm, loop, run, ctx, draft_id=draft_id, purpose="crew", prompt_version=cfg.prompt_version, crew="editorial", models=brief.get("models") or {})
            b = data_block("brief", {k: brief.get(k) for k in BRIEF_KEYS})
            style = data_block("style_guide", brief.get("styleGuide", ""))
            notes = author_notes_block(brief)
            examples = examples_block(brief)
            fb = feedback_section(feedback, validator_feedback, untrusted=feedback_untrusted)
            current = current_draft_block(brief)
            check = "\n\nThe article already has a draft that will be revised: research the outline as usual, so the writer can check its commands, versions and facts." if current else ""
            rag = rag_sections(rag_context)
            research = Task(description=f"{cfg.instructions('research')}{check}\n\n{b}{notes}{rag['research']}", expected_output=cfg.expected_output("research"), agent=agents["researcher"])
            key = "revise" if current else "write"
            write = Task(description=f"{cfg.instructions(key)}\n{NOTES_RULE}\n\n{b}{notes}{current}\n\n{style}{examples}{rag['write']}{fb}", expected_output=cfg.expected_output(key), agent=agents["writer"], context=[research])
            review = Task(
                description=f"{cfg.instructions('review')}{notes}\n\n{REVIEW_CONTRACT}",
                expected_output=cfg.expected_output("review"),
                agent=agents["reviewer"],
                context=[research, write],
            )
            seo = Task(
                description=f"{cfg.instructions('seo')}\n\n{b}{rag['seo']}{fb}",
                expected_output=cfg.expected_output("seo"),
                agent=agents["seo_editor"],
                context=[research, review],
                output_pydantic=SeoMetadata,
            )
            tasks = [research, write, review, seo]
            return make_crew(agents, tasks, self.settings), tasks

        o = await run_crew("editorial", build, self.settings, ctx, tags=editorial_tags(brief))
        draft = self._result(o.output, o.tasks, brief, o.status, o.reason)
        tokens, cost = o.tokens, o.cost_usd
        if draft.incomplete and not draft.meta_description and draft.body_mdx and self._reviewed(o.tasks):
            draft, usage = await self.fallback_metadata(draft, brief, titles, draft_id=draft_id)
            if usage is not None:
                tokens, cost = tokens + usage.total_tokens, round(cost + usage.cost_usd(), 6)
        draft = self._check_sources(draft, fetched)
        return CrewResult(draft=draft, status="incomplete" if draft.incomplete else "completed", tokens=tokens, cost_usd=cost, tool_calls=o.tool_calls, fetched_sources=fetched, config=cfg.summary())

    @staticmethod
    def _reviewed(tasks: list[Any]) -> bool:
        """The technical review finished: the draft's body is the reviewed one, only the SEO editor's part is missing."""
        return len(tasks) > 2 and bool(split_review(task_raw(tasks[2]))[0])

    async def fallback_metadata(self, draft: NewArticleDraft, brief: dict[str, Any], titles: dict[str, str], *, draft_id: str | None) -> tuple[NewArticleDraft, Usage | None]:
        """The crew stopped after the technical review (a limit in the SEO editor step, or an editor answer that did
        not match the schema). One call without tools, outside the crew's token cap (at most ~2,500 tokens in,
        FALLBACK_MAX_TOKENS out), writes the title and meta description; the outline is the body's H2s and the
        sources are the pages retrieved during the run. The draft stays incomplete: no internal links were suggested
        and no SEO editor checked it. Any error (budget, invalid answer) keeps the draft as it was."""
        model = (brief.get("models") or {}).get("seo_editor") or self.settings.crew_models.get("editorial.seo_editor") or self.settings.llm_model
        facts = {k: brief.get(k) for k in ("title", "gap", "audience", "intent", "supportingQueries")}
        user = f"{FALLBACK_TASK}\n\n{data_block('brief', facts)}\n\n{data_block('article_headings', h2_outline(draft.body_mdx))}\n\n{data_block('article_opening', draft.body_mdx[:FALLBACK_BODY_CHARS])}"
        spec = CallSpec(model=model, purpose="crew", prompt_version=f"{PROMPT_VERSION}-meta", cached_system=[UNTRUSTED], user=user, max_tokens=FALLBACK_MAX_TOKENS, draft_id=draft_id, run_id=CURRENT_RUN_ID.get(), agent="seo_editor")
        try:
            meta, usage = await self.llm.structured(spec, FallbackMetadata)
        except InvalidOutput as e:
            log.warning("fallback metadata rejected", extra={"event": "crew_meta_fallback", "status": "invalid", "error": str(e)[:200]})
            return draft, e.usage
        except Exception as e:  # BudgetExceeded included: the reviewed draft is still saved, without metadata
            log.warning("fallback metadata failed", extra={"event": "crew_meta_fallback", "status": "error", "error": f"{type(e).__name__}: {str(e)[:200]}"})
            return draft, None
        title = meta.title.strip()[:110] or draft.title
        reason = f"{draft.incomplete_reason or 'the crew stopped'} after the technical review: the body is reviewed, but the SEO editor did not finish. The title and meta description come from a short fallback call and no internal links were suggested; check them"
        update = {
            "title": title,
            "slug_suggestion": _slugify(title),
            "meta_description": " ".join(meta.meta_description.split())[:300],
            "outline": h2_outline(draft.body_mdx) or draft.outline,
            "sources": [Source(url=u, title=t[:200], used_for="retrieved during research") for u, t in titles.items()][:30],
            "incomplete_reason": reason,
        }
        log.info("fallback metadata written", extra={"event": "crew_meta_fallback", "status": "ok", "tokens": usage.total_tokens})
        return draft.model_copy(update=update), usage

    def _result(self, output: Any, tasks: list[Any], brief: dict[str, Any], status: str, reason: str | None) -> NewArticleDraft:
        review_raw = task_raw(tasks[2]) if len(tasks) > 2 else ""
        body, review_flags = split_review(review_raw)
        flags = list(review_flags)
        if not body:
            # No technical review finished: the writer's body is kept for the human, marked unreviewed, with the
            # writer's own NEEDS_FACT_CHECK notes split off.
            body, writer_flags = split_review(task_raw(tasks[1]) if len(tasks) > 1 else "")
            flags += writer_flags
            if body:
                flags.append(FactCheckFlag(claim="whole article", reason="the technical review did not finish; verify every command and version", severity="warning"))
            if status == "completed":
                status, reason = "incomplete", "the technical reviewer returned no body"
        body, note_flags = extract_editor_notes(body)
        flags += note_flags
        meta = _parse_meta(output) if status == "completed" else None
        if status == "completed" and meta is None:
            status, reason = "incomplete", "the SEO editor's output did not match the schema"
        if meta is not None and status == "completed":
            merged = merge_flags(meta.fact_check_flags, flags)
            return NewArticleDraft(title=meta.title, slug_suggestion=meta.slug_suggestion, meta_description=meta.meta_description, outline=meta.outline, body_mdx=body, code_blocks=code_blocks_of(body), sources=meta.sources, fact_check_flags=merged, internal_links=meta.internal_links)
        # Partial: whatever the completed tasks produced (the reviewer's corrected body beats the writer's).
        title = str(brief.get("title") or "Untitled draft")[:110]
        return NewArticleDraft(title=title, slug_suggestion=_slugify(title), meta_description="", outline=list(brief.get("outline") or []), body_mdx=body, code_blocks=code_blocks_of(body), fact_check_flags=flags, incomplete=True, incomplete_reason=reason or "incomplete")

    @staticmethod
    def _check_sources(d: NewArticleDraft, fetched: list[str]) -> NewArticleDraft:
        def page(u: str) -> str:  # a cited section (url#anchor) is retrieved when its page was
            return u.split("#", 1)[0].rstrip("/")

        got = {page(u) for u in fetched}
        missing = [FactCheckFlag(claim=s.url, reason="source was not retrieved during research; verify it exists and says this", severity="warning") for s in d.sources if page(s.url) not in got and not s.url.startswith("/")]
        return d.model_copy(update={"fact_check_flags": merge_flags(d.fact_check_flags, missing)})
