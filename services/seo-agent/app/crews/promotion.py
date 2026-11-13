"""Promotion Crew: text only, for a person to review (docs/seo/PROMOTION.md).

Two single-agent, tool-less crews:

- **copywriter** (`draft_posts`): one post per channel for a published article, from the article's own text and each
  channel's guidance. Which channels, their scores, the tagged links and the matching Reddit threads are decided by the
  web app's deterministic code; the agent only writes.
- **strategist** (`ideas`): article ideas from demand signals (Search Console topics and queries, Reddit threads the
  web app fetched). Every idea must cite evidence copied from the signals; the web app re-checks each item against its
  own data and drops anything it cannot verify.

Neither agent has a tool, so neither can fetch, post or write anywhere. The output is clamped here to the sizes the web
app accepts and filtered to the channels that were asked for. Limits and the Claude adapter are in crews/common.py.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..llm import Llm
from ..tools import ToolContext, data_block
from .common import AgentDef, CrewRun, build_agents, make_crew, run_crew

PROMPT_VERSION = "seo-promotion-crew-v1"
OUTPUT_TOKENS = 6000  # one JSON object with up to eight short posts, or up to fifteen ideas

AGENTS = [
    AgentDef(
        "copywriter",
        "Promotion copywriter",
        "Write one honest, channel-appropriate post per requested channel that makes a practitioner want to read the article.",
        "You write social posts for a one-person engineering publication, in the author's first-person voice. You only state what the article states: no invented results, numbers, quotes or claims. You follow each community's norms and never write clickbait.",
        [],
        OUTPUT_TOKENS,
    ),
    AgentDef(
        "strategist",
        "Content strategist",
        "Propose article ideas that have a real audience, each backed by evidence copied from the signals provided.",
        "You plan content for a one-person engineering publication. You only propose an idea when the signals show people searching for or discussing the subject, and you cite those signals exactly. You never invent a query, a thread or a statistic.",
        [],
        OUTPUT_TOKENS,
    ),
]
ROLES = {a.key: {"role": a.role, "tools": a.tools} for a in AGENTS}

MAX_TITLE, MAX_BODY, MAX_NOTES = 300, 4000, 600
MAX_IDEAS = 20


class PromoPost(BaseModel):
    model_config = ConfigDict(extra="ignore")
    channel: str
    title: str | None = None
    body: str = ""
    notes: str | None = None


class PromoPosts(BaseModel):
    model_config = ConfigDict(extra="ignore")
    posts: list[PromoPost] = Field(default_factory=list)


class IdeaEvidence(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["gsc_query", "gsc_topic", "reddit"]
    value: str


class ContentIdea(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    angle: str = ""
    outline: list[str] = Field(default_factory=list)
    target_query: str | None = None
    channels: list[str] = Field(default_factory=list)
    evidence: list[IdeaEvidence] = Field(default_factory=list)


class ContentIdeas(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ideas: list[ContentIdea] = Field(default_factory=list)


def parse_output[M: BaseModel](output: Any, model: type[M]) -> M | None:
    """The crew's final answer as `model`: CrewAI's parsed object when it has one, else the first JSON object in the text."""
    final = getattr(output, "pydantic", None) if output is not None else None
    if isinstance(final, model):
        return final
    m = re.search(r"\{[\s\S]*\}", getattr(output, "raw", "") or "") if output is not None else None
    if not m:
        return None
    try:
        return model.model_validate(json.loads(m.group(0)))
    except ValueError:
        return None


def clean_posts(parsed: PromoPosts, channels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Only the channels that were asked for, one post each, clamped to what the web app's schema accepts."""
    wanted = {str(c.get("channel")): c for c in channels}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in parsed.posts:
        ch = p.channel.strip().lower()
        body = (p.body or "").strip()[:MAX_BODY]
        if ch not in wanted or ch in seen or not body:
            continue
        seen.add(ch)
        title = (p.title or "").strip()[:MAX_TITLE] if wanted[ch].get("hasTitle") else ""
        notes = (p.notes or "").strip()[:MAX_NOTES]
        out.append({"channel": ch, "title": title or None, "body": body, "notes": notes or None})
    return out


def clean_ideas(parsed: ContentIdeas, limit: int) -> list[dict[str, Any]]:
    """Clamped to what the web app's schema accepts; ideas without a usable title or any evidence are dropped."""
    out: list[dict[str, Any]] = []
    for i in parsed.ideas:
        title = " ".join(i.title.split())[:160]
        evidence = [{"type": e.type, "value": e.value.strip()[:500]} for e in i.evidence if e.value.strip()][:12]
        if len(title) < 10 or not evidence:
            continue
        out.append(
            {
                "title": title,
                "angle": i.angle.strip()[:600],
                "outline": [h.strip()[:200] for h in i.outline if h.strip()][:10],
                "target_query": (i.target_query or "").strip()[:120] or None,
                "channels": [c.strip().lower()[:40] for c in i.channels if c.strip()][:8],
                "evidence": evidence,
            }
        )
        if len(out) >= min(limit, MAX_IDEAS):
            break
    return out


@dataclass
class PromoPostsResult:
    posts: list[dict[str, Any]]
    status: str  # completed | incomplete
    reason: str | None
    tokens: int
    cost_usd: float


@dataclass
class ContentIdeasResult:
    ideas: list[dict[str, Any]]
    status: str  # completed | incomplete
    reason: str | None
    tokens: int
    cost_usd: float


class PromotionCrew:
    def __init__(self, settings: Settings, llm: Llm, web: Any, retriever: Any):
        self.settings, self.llm, self.web, self.retriever = settings, llm, web, retriever

    def _agents(self, key: str, loop: asyncio.AbstractEventLoop, run: CrewRun, ctx: ToolContext) -> dict[str, Any]:
        defs = [a for a in AGENTS if a.key == key]
        return build_agents(defs, self.settings, self.llm, loop, run, ctx, draft_id=None, purpose="crew", prompt_version=PROMPT_VERSION, crew="promotion")

    async def draft_posts(self, article: dict[str, Any]) -> PromoPostsResult:
        """`article` is one entry of the web app's /promotion/collect answer (title, url, excerpt, topQueries, channels)."""
        from crewai import Task

        channels = [c for c in (article.get("channels") or []) if isinstance(c, dict) and c.get("channel")]
        if not channels:
            return PromoPostsResult([], "completed", "no channel to draft", 0, 0.0)
        ctx = ToolContext(self.web, self.retriever, self.settings.docs_allowlist)

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            agents = self._agents("copywriter", loop, run, ctx)
            a = data_block("article", {k: article.get(k) for k in ("title", "url", "description", "excerpt", "topQueries")})
            ch = data_block("channels", [{"channel": c.get("channel"), "name": c.get("label"), "guidance": c.get("guidance"), "max_chars": c.get("maxChars"), "has_title": c.get("hasTitle"), "link_in_text": c.get("linkInBody"), "link": c.get("link"), "threads": [t.get("title") for t in (c.get("threads") or [])][:5]} for c in channels])
            task = Task(
                description=(
                    "Write one promotion post for the article in the article block for EACH channel in the channels block.\n"
                    "Rules:\n"
                    "- Use only facts from the article block. Never invent a result, number, quote, version or claim the article does not make.\n"
                    "- First person, as the article's author. Plain and specific. No hype words, no clickbait, no emoji.\n"
                    "- Follow the channel's guidance and stay under its max_chars.\n"
                    "- Where link_in_text is true, include the channel's link exactly as given, once. Where it is false, do not put any link in the text. Never include any other URL.\n"
                    "- threads (Reddit) are recent discussion titles for context only: do not quote them or mention any user.\n"
                    "- title is null where has_title is false.\n"
                    "- notes is one short sentence for the author: what to check before posting (for example the community's self-promotion rule) or where it fits best.\n"
                    'Return one JSON object: {"posts": [{"channel": "...", "title": "..." or null, "body": "...", "notes": "..."}]} and nothing else.\n\n'
                    f"{a}\n\n{ch}"
                ),
                expected_output='One JSON object {"posts": [...]} with one post per requested channel.',
                agent=agents["copywriter"],
                output_pydantic=PromoPosts,
            )
            return make_crew(agents, [task], self.settings), [task]

        o = await run_crew("promotion", build, self.settings, ctx)
        parsed = parse_output(o.output, PromoPosts)
        posts = clean_posts(parsed, channels) if parsed is not None else []
        status, reason = o.status, o.reason
        if not posts and status == "completed":
            status, reason = "incomplete", "the copywriter's output did not match the schema"
        return PromoPostsResult(posts, status, reason, o.tokens, o.cost_usd)

    async def ideas(self, signals: dict[str, Any]) -> ContentIdeasResult:
        """`signals` is the web app's /promotion/ideas/signals answer (gsc topics and queries, reddit threads, covered, planned)."""
        from crewai import Task

        limit = max(1, min(MAX_IDEAS, int(signals.get("max") or 8)))
        ctx = ToolContext(self.web, self.retriever, self.settings.docs_allowlist)

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            agents = self._agents("strategist", loop, run, ctx)
            gsc = signals.get("gsc") or {}
            blocks = "\n\n".join(
                [
                    data_block("search_console_topics", gsc.get("topics") or []),
                    data_block("search_console_queries", gsc.get("queries") or []),
                    data_block("reddit_threads", signals.get("reddit") or []),
                    data_block("channels", signals.get("channels") or []),
                    data_block("covered", (signals.get("covered") or [])[:200]),
                    data_block("planned", (signals.get("planned") or [])[:200]),
                ]
            )
            task = Task(
                description=(
                    f"Propose up to {limit} ideas for new articles on this site (DevOps, cloud, Kubernetes, platform and AI engineering), chosen because they would be easy to promote: people are already searching for or discussing the subject.\n"
                    "Rules:\n"
                    "- Every idea needs at least one item of evidence copied EXACTLY from the signals: a Search Console query (type gsc_query, value = the query text), a Search Console topic (type gsc_topic, value = the topic) or a Reddit thread (type reddit, value = its url). Prefer ideas backed by both search demand and a discussion.\n"
                    "- Do not propose anything already in covered (published articles) or planned (the calendar and earlier ideas), or a near-duplicate of one.\n"
                    "- title: at most 70 characters, specific, no clickbait. angle: one or two sentences on what would make it worth reading and sharing (first-hand, concrete, a real problem).\n"
                    "- outline: 4 to 7 section headings. target_query: one query from search_console_queries, or null.\n"
                    "- channels: ids from the channels block where the finished article would fit.\n"
                    "- If the signals support fewer ideas, return fewer. Never invent a query, a thread or a number.\n"
                    'Return one JSON object: {"ideas": [{"title": "...", "angle": "...", "outline": ["..."], "target_query": "..." or null, "channels": ["..."], "evidence": [{"type": "...", "value": "..."}]}]} and nothing else.\n\n'
                    f"{blocks}"
                ),
                expected_output='One JSON object {"ideas": [...]}.',
                agent=agents["strategist"],
                output_pydantic=ContentIdeas,
            )
            return make_crew(agents, [task], self.settings), [task]

        o = await run_crew("promotion", build, self.settings, ctx)
        parsed = parse_output(o.output, ContentIdeas)
        ideas = clean_ideas(parsed, limit) if parsed is not None else []
        status, reason = o.status, o.reason
        if parsed is None and status == "completed":
            status, reason = "incomplete", "the strategist's output did not match the schema"
        return ContentIdeasResult(ideas, status, reason, o.tokens, o.cost_usd)
