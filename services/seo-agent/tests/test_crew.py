"""Editorial crew (CrewAI) with a deterministic model and fake tools, and the new_article graph (Phase 3)."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import replace

from app.crews.editorial import ROLES, EditorialCrew
from app.index import MemoryRetriever
from app.llm import BudgetGuard, FakeLlm, MemorySpendStore
from app.main import memory_container
from app.schemas import NewArticleDraft
from app.tools import ALLOWED_TOOLS
from tests.conftest import ARTICLE, FakeWebApp, hits, settings

DOC_URL = "https://kubernetes.io/docs/concepts/services-networking/ingress/"
BRIEF = {"title": "Rotating cert-manager certificates", "outline": ["Why rotate", "How", "Verify"], "styleGuide": "Sentence case headings.", "supportingQueries": ["cert-manager renew"]}


def final_json(sources: list[str]) -> str:
    return json.dumps(
        {
            "title": "Rotate cert-manager certificates safely",
            "slug_suggestion": "rotate-cert-manager-certificates",
            "meta_description": "How cert-manager renews certificates, how to force a rotation, and how to verify the new certificate is served by your ingress controller.",
            "outline": ["Why rotate", "How", "Verify"],
            "body_mdx": "## Why rotate\n\nCertificates expire.\n\n```bash\nkubectl get certificate -A\n```",
            "code_blocks": [{"lang": "bash", "code": "kubectl get certificate -A", "purpose": "list"}],
            "sources": [{"url": u, "title": "Ingress", "used_for": "ingress basics"} for u in sources],
            "fact_check_flags": [],
            "internal_links": [{"target_path": "/blog/ingress-tls", "anchor": "ingress TLS", "reason": "prerequisite"}],
        }
    )


def scripted(final: str, with_tool: bool = False):
    """Researcher (optionally one tool call), writer, reviewer, SEO editor."""
    steps: list[str] = []
    if with_tool:
        steps.append(f'Thought: I need the official docs.\nAction: fetch_allowlisted_docs\nAction Input: {{"input": "{DOC_URL}"}}')
    steps += [
        "Thought: I now know the final answer\nFinal Answer: Notes: cert-manager renews 30 days before expiry. Sources: " + DOC_URL,
        "Thought: I now know the final answer\nFinal Answer: ## Why rotate\n\nCertificates expire.",
        "Thought: I now know the final answer\nFinal Answer: ## Why rotate\n\nCertificates expire.\n\nneeds_fact_check: none",
        f"Thought: I now know the final answer\nFinal Answer: {final}",
    ]
    return steps


def crew_with(llm: FakeLlm, web: FakeWebApp, **kw) -> EditorialCrew:
    return EditorialCrew(settings(**kw), llm, web, MemoryRetriever(hits()))


async def test_crew_output_validates_against_the_schema_with_a_real_tool_call(llm: FakeLlm, web: FakeWebApp) -> None:
    web.docs[DOC_URL] = "<p>An Ingress may be configured to give Services externally-reachable URLs.</p>"
    llm.queue("crew", *scripted(final_json([DOC_URL]), with_tool=True))
    r = await crew_with(llm, web).run(BRIEF)
    assert r.status == "completed"
    assert isinstance(r.draft, NewArticleDraft) and r.draft.title.startswith("Rotate")
    assert ("fetch_docs", DOC_URL) in web.calls  # went through the web app's SSRF-safe fetcher
    assert r.fetched_sources == [DOC_URL] and r.draft.fact_check_flags == []  # cited source was actually retrieved
    assert r.tokens > 0 and r.cost_usd > 0


async def test_cited_but_unretrieved_sources_are_flagged(llm: FakeLlm, web: FakeWebApp) -> None:
    llm.queue("crew", *scripted(final_json(["https://kubernetes.io/docs/made-up"])))
    r = await crew_with(llm, web).run(BRIEF)
    assert [f.claim for f in r.draft.fact_check_flags] == ["https://kubernetes.io/docs/made-up"]


async def test_token_cap_returns_a_partial_draft_marked_incomplete(web: FakeWebApp) -> None:
    llm = FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1), tokens=(1500, 500))  # 2,000 tokens per call
    llm.queue("crew", *scripted(final_json([])))
    r = await crew_with(llm, web, crew_max_tokens_per_run=3000).run(BRIEF)
    assert r.status == "incomplete" and r.draft.incomplete
    assert "token cap" in (r.draft.incomplete_reason or "")
    assert r.draft.body_mdx.startswith("## Why rotate")  # the writer's completed output is kept
    assert len(llm.calls) == 2  # stopped, not looping


async def test_wall_clock_timeout_returns_incomplete(web: FakeWebApp) -> None:
    llm = FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1))
    llm.queue("crew", *scripted(final_json([])))
    orig = llm.text

    async def slow(spec):
        await asyncio.sleep(3)
        return await orig(spec)

    llm.text = slow  # type: ignore[method-assign]
    r = await crew_with(llm, web, crew_timeout_s=1).run(BRIEF)
    assert r.status == "incomplete" and "wall-clock" in (r.draft.incomplete_reason or "")


async def test_crew_respects_the_monthly_budget(web: FakeWebApp) -> None:
    llm = FakeLlm(BudgetGuard(MemorySpendStore(preexisting_usd=9.9999), 10, 1))
    llm.queue("crew", *scripted(final_json([])))
    r = await crew_with(llm, web).run(BRIEF)
    assert r.status == "incomplete" and llm.calls == []


def test_agents_hold_only_allowlisted_read_only_tools() -> None:
    assert {k: set(v["tools"]) for k, v in ROLES.items()} == {
        "researcher": {"vector_search", "read_article", "fetch_allowlisted_docs"},
        "writer": {"read_article"},
        "reviewer": {"fetch_allowlisted_docs"},
        "seo_editor": {"gsc_queries_for_topic", "vector_search"},
    }
    assert set().union(*(set(v["tools"]) for v in ROLES.values())) <= ALLOWED_TOOLS


async def test_built_crew_agents_match_roles_and_limits(llm: FakeLlm, web: FakeWebApp) -> None:
    from app.crews.editorial import CrewRun
    from app.tools import ToolContext

    s = settings()
    crew = EditorialCrew(s, llm, web, MemoryRetriever())
    built, tasks = crew._build(BRIEF, None, asyncio.get_running_loop(), CrewRun(max_tokens=10), None, ToolContext(web, MemoryRetriever(), s.docs_allowlist))
    assert [a.role for a in built.agents] == ["Researcher", "Technical writer", "Technical reviewer", "SEO editor"]
    assert all(a.max_iter == s.crew_max_iter and a.allow_delegation is False for a in built.agents)
    assert built.memory is False and built.planning is False and len(tasks) == 4 and tasks[-1].output_pydantic is NewArticleDraft


def test_unused_crewai_memory_store_is_not_installed() -> None:
    import importlib.util

    assert importlib.util.find_spec("lancedb") is None and importlib.util.find_spec("pyarrow") is None


def test_third_party_telemetry_is_off() -> None:
    import app.config  # noqa: F401 - sets the flags on import

    assert os.environ["CREWAI_DISABLE_TELEMETRY"] == "true" and os.environ["CREWAI_TRACING_ENABLED"] == "false"
    assert os.environ["LANGSMITH_TRACING"] == "false"
    assert "OTEL_SDK_DISABLED" not in os.environ  # would silence our own tracing


async def test_new_article_graph_pauses_at_human_review_then_publishes_with_approval(llm: FakeLlm, web: FakeWebApp) -> None:
    llm.queue("crew", *scripted(final_json([])))
    draft = "55555555-5555-4555-8555-555555555555"
    c = memory_container(settings(), llm=llm, web=web, crew_factory=lambda: EditorialCrew(settings(), llm, web, MemoryRetriever(hits())))
    await c.runs.start("new_article", {"calendar_id": "cal-1", "draft_id": draft, "article_id": ARTICLE}, draft)
    await c.runs.wait(draft, 60)
    run = await c.runs.get(draft)
    assert run["status"] == "interrupted" and web.drafts[draft]["kind"] == "new_article"
    assert web.drafts[draft]["document"]["title"].startswith("Rotate") and web.published == []
    await c.runs.resume(draft, web.approve(draft))
    await c.runs.wait(draft, 30)
    assert (await c.runs.get(draft))["outcome"] == "published" and web.published == [draft] and web.submitted == [draft]


async def test_new_article_validation_retry_then_generation_failed(llm: FakeLlm, web: FakeWebApp) -> None:
    llm.queue("crew", *scripted(final_json([])), *scripted(final_json([])))
    web.validate_errors = [["body: MDX does not parse"], ["body: MDX does not parse"]]
    draft = "66666666-6666-4666-8666-666666666666"
    c = memory_container(settings(), llm=llm, web=web, crew_factory=lambda: EditorialCrew(settings(), llm, web, MemoryRetriever(hits())))
    await c.runs.start("new_article", {"calendar_id": "cal-1", "draft_id": draft}, draft)
    await c.runs.wait(draft, 60)
    run = await c.runs.get(draft)
    assert run["outcome"] == "generation_failed" and len(llm.calls) == 8  # two crew runs, then stop
    assert "MDX does not parse" in llm.calls[5].user  # second run's writer saw the feedback


_ = replace
