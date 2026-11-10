"""Optimization Crew (existing articles, sequential): SEO analyst → Editor → Technical reviewer.

Output: `OptimizationResult` = the v2 `ModelChangeSet` (atomic changes with before/after, block location,
rationale, evidence_ref, source_urls) plus the analyst's problem statement and the reviewer's `needs_fact_check`
items. The change set then goes through the web app's own v2 validators, so the existing diff view works unchanged.

The editor's brief is *minimal*: only what the evidence supports, in the site's style. Internal links are never
written by the crew (v2 D-25); they come from the deterministic planner.
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
from ..schemas import FactCheckFlag, ModelChangeSet
from ..tools import ToolContext, data_block
from .common import AgentDef, CrewRun, build_agents, make_crew, run_crew

PROMPT_VERSION = "seo-optimize-crew-v1"


class OptimizationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    problem_statement: str = ""
    change_set: ModelChangeSet
    needs_fact_check: list[FactCheckFlag] = Field(default_factory=list)


AGENTS = [
    AgentDef("analyst", "SEO analyst", "Turn the evidence (Search Console queries, CTR gap against the site's curve, decay) into a short, specific problem statement for this article.", "You analyse search performance for a technical blog. You only state what the numbers show; no guesses about traffic you cannot see.", ["gsc_queries_for_page", "read_article"]),
    AgentDef("editor", "Editor", "Produce a minimal change set (title, meta, headings, paragraph edits, alt text, FAQ paragraphs) that addresses the problem statement, in the site's style.", "You edit existing engineering articles. Fewer, better changes beat rewrites. You keep code untouched unless a command is wrong, and you never add links.", ["read_article", "style_guide"]),
    AgentDef("reviewer", "Technical reviewer", "Check every changed command, version and technical claim against official documentation; anything without a source becomes needs_fact_check.", "You are a careful reviewer. An unsourced claim is flagged, never guessed.", ["fetch_allowlisted_docs"]),
]
ROLES = {a.key: {"role": a.role, "tools": a.tools} for a in AGENTS}

CHANGESET_RULES = (
    "Return ONLY one JSON object: {\"problem_statement\": str, \"change_set\": {\"summary\": str, \"changes\": [{\"type\": "
    "\"title\"|\"meta_description\"|\"heading\"|\"paragraph_edit\"|\"paragraph_add\"|\"code_block\"|\"alt_text\", \"block_id\": "
    "\"b12\" (\"\" for title and meta_description), \"before\": exact current text, \"after\": new text, \"rationale\": str, "
    "\"evidence_ref\": [\"rec:<id>\" or \"query:<text>\"], \"source_urls\": [str]}]}, \"needs_fact_check\": [{\"claim\": str, "
    "\"reason\": str, \"severity\": \"warning\"|\"error\"}]}. `before` must match the article block exactly. No internal links."
)


@dataclass
class OptimizationCrewResult:
    result: OptimizationResult | None
    status: str  # completed | incomplete
    reason: str | None
    tokens: int
    cost_usd: float
    tool_calls: list[tuple[str, str]]


def _parse(raw: str) -> OptimizationResult | None:
    m = re.search(r"\{[\s\S]*\}", raw or "")
    if not m:
        return None
    try:
        return OptimizationResult.model_validate(json.loads(m.group(0)))
    except ValueError:
        return None


class OptimizationCrew:
    def __init__(self, settings: Settings, llm: Llm, web: Any, retriever: Any):
        self.settings, self.llm, self.web, self.retriever = settings, llm, web, retriever

    async def run(self, context: dict[str, Any], *, article_id: str, related: list[dict[str, Any]] | None = None, feedback: str | None = None, draft_id: str | None = None, recommendation_ids: list[str] | None = None) -> OptimizationCrewResult:
        from crewai import Task

        prompt = context.get("prompt") or {}
        ctx = ToolContext(self.web, self.retriever, self.settings.docs_allowlist, article_id=article_id, style=str(prompt.get("styleGuide") or ""))
        recs = [r for r in context.get("recommendations", []) if not recommendation_ids or r.get("id") in recommendation_ids]

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            agents = build_agents(AGENTS, self.settings, self.llm, loop, run, ctx, draft_id=draft_id, purpose="draft" if not feedback else "regenerate", prompt_version=PROMPT_VERSION, models=context.get("models") or {})
            evidence = data_block("evidence", {"recommendations": recs, "metrics_28d": context.get("metrics") or {}, "ga4_engagement_28d": context.get("ga4") or {}, "related_site_articles": related or []})
            # v2's own prompt (article blocks with ids). The web app already wraps article text in data blocks; it is
            # wrapped again here so a closing tag inside the article can never end the data section (defence in depth).
            article = data_block("article_and_recommendations", str(prompt.get("user") or ""))
            rules = data_block("draft_rules", prompt.get("rules") or "")
            fb = f"\n\nReviewer or validator feedback on the previous attempt (fix every point):\n{feedback[:4000]}" if feedback else ""
            analyse = Task(description=f"Read the evidence and the article. Use gsc_queries_for_page for the queries this page ranks for. Write a problem statement of at most 5 sentences: which queries, what gap, which part of the article.\n\n{evidence}", expected_output="A short problem statement grounded in the evidence.", agent=agents["analyst"])
            edit = Task(description=f"Write the minimal change set for the problem statement. Follow the rules and the style guide (style_guide tool). Every change names its block id and quotes `before` exactly.\n\n{rules}\n\n{article}{fb}\n\n{CHANGESET_RULES}", expected_output="The JSON object described above.", agent=agents["editor"], context=[analyse])
            review = Task(description=f"Check every command, version or technical claim the editor changed against official documentation (fetch_allowlisted_docs). Remove or fix any change you can prove wrong; list anything you cannot verify in needs_fact_check. Return the final JSON object.\n\n{CHANGESET_RULES}", expected_output="The final JSON object.", agent=agents["reviewer"], context=[analyse, edit], output_pydantic=OptimizationResult)
            tasks = [analyse, edit, review]
            return make_crew(agents, tasks, self.settings), tasks

        o = await run_crew("optimization", build, self.settings, ctx)
        result: OptimizationResult | None = None
        status, reason = o.status, o.reason
        if status == "completed":
            final = getattr(o.output, "pydantic", None)
            result = final if isinstance(final, OptimizationResult) else _parse(getattr(o.output, "raw", "") or "")
            if result is None:
                status, reason = "incomplete", "the reviewer's output did not match the schema"
        if result is None:
            # Partial: the editor's change set without the review is still useful as a validator retry input,
            # but it is marked unreviewed: every change gets a needs_fact_check flag.
            edit_out = getattr(o.tasks[1], "output", None) if len(o.tasks) > 1 else None
            partial = _parse(str(getattr(edit_out, "raw", "") or "")) if edit_out is not None else None
            if partial is not None:
                partial.needs_fact_check.append(FactCheckFlag(claim="all changes", reason=f"technical review did not finish ({reason}); verify before approving", severity="warning"))
                result = partial
        return OptimizationCrewResult(result, status, reason, o.tokens, o.cost_usd, o.tool_calls)
