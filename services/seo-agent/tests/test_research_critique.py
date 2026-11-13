"""Editorial Crew v5: web search for the researcher, the critique-and-rewrite pass, and the admin-saved budget."""

from __future__ import annotations

import json
from typing import Any

import anthropic
import httpx2
import pytest

from app.crews.editorial import AGENTS, CRITIC, EditorialCrew, agents_for
from app.index import MemoryRetriever
from app.llm import AnthropicLlm, BudgetExceeded, BudgetGuard, CallSpec, FakeLlm, MemorySpendStore, Usage, web_search_fee_usd
from app.runtime import apply_overrides, monthly_budget
from app.tools import ToolContext
from tests.conftest import FakeWebApp, hits, settings
from tests.test_crews import BRIEF, DOC_URL, final_json

FINAL = "Thought: I now know the final answer\nFinal Answer: "
POST_URL = "https://example.org/blog/cert-manager-renewal"


def crew(llm: FakeLlm, web: FakeWebApp, **kw: Any) -> EditorialCrew:
    return EditorialCrew(settings(**kw), llm, web, MemoryRetriever(hits()))


def test_optional_agents_and_tools_follow_the_settings() -> None:
    base = agents_for(settings())
    assert [a.key for a in base] == [a.key for a in AGENTS] and "web_search" not in base[0].tools
    full = agents_for(settings(research_web_search=True, editorial_critique=True))
    assert [a.key for a in full] == ["researcher", "writer", "reviewer", "seo_editor", "critic"]
    assert full[0].tools == ["vector_search", "read_article", "fetch_allowlisted_docs", "web_search"]
    assert CRITIC.tools == [] and all("web_search" not in a.tools for a in full[1:])  # only the researcher searches


async def test_critique_and_rewrite_the_reviewer_checks_the_revised_body(llm: FakeLlm, web: FakeWebApp) -> None:
    llm.queue(
        "crew",
        FINAL + "Notes: cert-manager renews 30 days before expiry. Sources: " + DOC_URL,
        FINAL + "## Why rotate\n\nFIRST-DRAFT certificates expire.",
        FINAL + "1. Why rotate: generic opening ('certificates expire'); say what breaks when one does.\nVERDICT: revise",
        FINAL + "## Why rotate\n\nREVISED an expired certificate takes the ingress down.",
        FINAL + "## Why rotate\n\nREVISED an expired certificate takes the ingress down.\n\nNEEDS_FACT_CHECK:\n- none",
        FINAL + final_json([]),
    )
    r = await crew(llm, web, editorial_critique=True).run(BRIEF)
    assert r.status == "completed" and "REVISED" in r.draft.body_mdx and "FIRST-DRAFT" not in r.draft.body_mdx
    _research, _write, critique, revise, review, _seo = llm.calls
    assert [c.agent for c in llm.calls] == ["researcher", "writer", "critic", "writer", "reviewer", "seo_editor"]
    assert "VERDICT: revise" in critique.user and "FIRST-DRAFT" in critique.user  # the editor reads the first draft
    assert "generic opening" in revise.user and "do not invent" in revise.user  # the writer gets the critique
    assert "REVISED" in review.user and "FIRST-DRAFT" not in review.user  # the technical review sees only the revision
    assert all(c.prompt_version == "seo-crew-v5" for c in llm.calls)


def test_without_a_finished_review_the_revised_body_is_kept_not_the_first_draft(llm: FakeLlm, web: FakeWebApp) -> None:
    from types import SimpleNamespace

    def task(raw: str) -> Any:
        return SimpleNamespace(output=SimpleNamespace(raw=raw))

    order = ["research", "write", "critique", "revise", "review", "seo"]
    tasks = [task("Notes."), task("## A\n\nFIRST-DRAFT"), task("1. A: thin.\nVERDICT: revise"), task("## A\n\nREVISED body"), SimpleNamespace(output=None), SimpleNamespace(output=None)]
    d = crew(llm, web, editorial_critique=True)._result(None, tasks, BRIEF, "incomplete", "crew timed out", order)
    assert d.incomplete and d.body_mdx == "## A\n\nREVISED body"
    assert any("technical review did not finish" in f.reason for f in d.fact_check_flags)
    # Without the critique step the same call falls back to the writer's draft, as before.
    plain = crew(llm, web)._result(None, [task("Notes."), task("## A\n\nFIRST-DRAFT"), SimpleNamespace(output=None), SimpleNamespace(output=None)], BRIEF, "incomplete", "crew timed out")
    assert plain.body_mdx == "## A\n\nFIRST-DRAFT"


async def test_researcher_web_search_is_metered_and_its_unopened_sources_are_flagged(llm: FakeLlm, web: FakeWebApp) -> None:
    llm.queue("web_search", {"text": "cert-manager 1.19 renews at two thirds of the lifetime (" + POST_URL + ").", "sources": [{"url": POST_URL, "title": "Renewal in practice"}]})
    llm.queue(
        "crew",
        'Thought: I need current release facts.\nAction: web_search\nAction Input: {"input": "cert-manager renewal window current release"}',
        FINAL + "Notes: renews at two thirds of the lifetime. Sources: " + POST_URL,
        FINAL + "## Why rotate\n\nCertificates expire.",
        FINAL + "## Why rotate\n\nCertificates expire.\n\nNEEDS_FACT_CHECK:\n- none",
        FINAL + final_json([POST_URL]),
    )
    r = await crew(llm, web, research_web_search=True).run(BRIEF)
    assert r.status == "completed" and ("web_search", "cert-manager renewal window current release") in r.tool_calls
    search = next(c for c in llm.calls if c.user.startswith("Search query: "))
    assert search.agent == "researcher" and search.max_tokens == 1500 and "report only what the results say" in search.cached_system[-1]
    researcher_second = llm.calls[llm.calls.index(search) + 1]
    assert '<data name="web_search">' in researcher_second.user and POST_URL in researcher_second.user  # results come back as untrusted data
    assert "web_search" in llm.calls[0].user + " ".join(llm.calls[0].cached_system)  # the researcher is offered the tool
    assert [f.reason for f in r.draft.fact_check_flags if f.claim == POST_URL] == ["found by web search but not opened by the crew; read the page before relying on it"]
    tokens_only = sum(Usage(c.model, input_tokens=1200, output_tokens=300).cost_usd() for c in llm.calls)
    assert r.cost_usd == pytest.approx(tokens_only + web_search_fee_usd(1))  # the per-search fee is part of the run's cost


async def test_a_failing_search_is_reported_to_the_researcher_and_the_run_goes_on(llm: FakeLlm, web: FakeWebApp) -> None:
    llm.queue("web_search", RuntimeError("web search is not enabled for this organization"))
    llm.queue(
        "crew",
        'Thought: search.\nAction: web_search\nAction Input: {"input": "cert-manager renewal"}',
        'Thought: again.\nAction: web_search\nAction Input: {"input": "cert-manager renewal window"}',
        FINAL + "Notes from the documentation only.",
        FINAL + "## Why rotate\n\nCertificates expire.",
        FINAL + "## Why rotate\n\nCertificates expire.\n\nNEEDS_FACT_CHECK:\n- none",
        FINAL + final_json([]),
    )
    r = await crew(llm, web, research_web_search=True, crew_max_iter=5).run(BRIEF)
    assert r.status == "completed"
    assert sum(1 for c in llm.calls if c.user.startswith("Search query: ")) == 1  # after one failure search stays off for the run
    assert "web search is not available in this run (RuntimeError)" in llm.calls[-4].user


async def test_the_search_limit_and_unsafe_queries_are_refused(web: FakeWebApp) -> None:
    ctx = ToolContext(web, MemoryRetriever(hits()), ("kubernetes.io",))
    assert "web search is switched off" in await ctx.web_search("anything")
    seen: list[str] = []

    async def searcher(q: str) -> str:
        seen.append(q)
        return "ok"

    ctx.searcher = searcher
    assert "contains an email address" in await ctx.web_search("who is jane@example.com")
    assert await ctx.web_search("  kong   gateway\n3.9 ") == "ok" and seen == ["kong gateway 3.9"]
    assert [c[0] for c in ctx.calls] == ["web_search"] * 3


def search_client(replies: list[dict[str, Any]], seen: list[dict[str, Any]]) -> anthropic.AsyncAnthropic:
    def handler(req: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(req.content))
        return httpx2.Response(200, json=replies[min(len(seen), len(replies)) - 1], headers={"request-id": "req_1"})

    return anthropic.AsyncAnthropic(api_key="sk-ant-test", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), max_retries=0)


def reply(content: list[dict[str, Any]], stop: str = "end_turn", searches: int = 1) -> dict[str, Any]:
    return {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 4000, "output_tokens": 200, "server_tool_use": {"web_search_requests": searches}}}


RESULT = {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [{"type": "web_search_result", "url": POST_URL, "title": "Renewal in practice", "encrypted_content": "x", "page_age": None}, {"type": "web_search_result", "url": "http://insecure.example/x", "title": "skipped", "encrypted_content": "x", "page_age": None}]}
USE = {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {"query": "cert-manager renewal"}}


async def test_sdk_web_search_request_shape_sources_and_fee() -> None:
    seen: list[dict[str, Any]] = []
    store = MemorySpendStore()
    llm = AnthropicLlm("k", BudgetGuard(store, 10, 1), client=search_client([reply([USE, RESULT, {"type": "text", "text": "Renews at two thirds of the lifetime."}])], seen))
    r = await llm.web_search(CallSpec(model="claude-haiku-5-5", purpose="crew", prompt_version="v", cached_system=["S"], user="Search query: cert-manager renewal", max_tokens=1500), max_uses=2)
    assert seen[0]["tools"] == [{"type": "web_search_20250305", "name": "web_search", "max_uses": 2}]
    assert r.text == "Renews at two thirds of the lifetime." and r.sources == [{"url": POST_URL, "title": "Renewal in practice"}] and r.searches == 1  # https only
    assert r.usage.extra_usd == pytest.approx(0.01) and store.rows[0]["cost_usd"] == pytest.approx(r.usage.cost_usd())
    assert r.usage.cost_usd() == pytest.approx(Usage("claude-haiku-5-5", input_tokens=4000, output_tokens=200).cost_usd() + 0.01)


async def test_sdk_web_search_continues_a_paused_turn_and_survives_a_search_error() -> None:
    seen: list[dict[str, Any]] = []
    error = {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": {"type": "web_search_tool_result_error", "error_code": "max_uses_exceeded"}}
    llm = AnthropicLlm("k", BudgetGuard(MemorySpendStore(), 10, 1), client=search_client([reply([USE, RESULT], stop="pause_turn"), reply([USE, error, {"type": "text", "text": "Done."}], searches=0)], seen))
    r = await llm.web_search(CallSpec(model="claude-haiku-5-5", purpose="crew", prompt_version="v", cached_system=[], user="Search query: x", max_tokens=500), max_uses=1)
    assert len(seen) == 2 and seen[1]["messages"][-1]["role"] == "assistant"  # the paused turn is sent back as is
    assert r.text == "Done." and [s["url"] for s in r.sources] == [POST_URL] and r.searches == 1
    assert (r.usage.input_tokens, r.usage.output_tokens) == (8000, 400)  # both requests are billed


async def test_the_admin_saved_budget_replaces_the_deployments_and_clearing_it_restores_it() -> None:
    store = MemorySpendStore(preexisting_usd=5.0)
    guard = BudgetGuard(store, monthly_usd=10.0, ask_daily_usd=1.0)
    saved: list[Any] = [3.0]

    async def provider() -> float | None:
        if saved[0] == "boom":
            raise RuntimeError("web app down")
        return saved[0]

    guard.monthly_provider = provider
    with pytest.raises(BudgetExceeded, match=r"\$3\.00"):
        await guard.ensure("claude-haiku-5-5", 100, 100, "crew")  # $5 spent > the admin's $3
    assert (await guard.status())["monthly_budget_usd"] == 3.0
    saved[0] = 50.0
    await guard.ensure("claude-haiku-5-5", 100, 100, "crew")
    saved[0] = "boom"
    await guard.ensure("claude-haiku-5-5", 100, 100, "crew")  # a failed lookup keeps the last known budget
    assert guard.monthly_usd == 50.0
    saved[0] = None
    await guard.ensure("claude-haiku-5-5", 100, 100, "crew")
    assert guard.monthly_usd == 10.0  # cleared in the admin: back to the deployment's


def test_runtime_overrides_for_the_new_options() -> None:
    s = settings()
    o = apply_overrides(s, {"SEO_RESEARCH_WEB_SEARCH": "true", "SEO_RESEARCH_WEB_SEARCH_MAX": "8", "SEO_EDITORIAL_CRITIQUE": "TRUE"})
    assert (o.research_web_search, o.research_web_search_max, o.editorial_critique) == (True, 8, True)
    on = settings(research_web_search=True, editorial_critique=True)
    off = apply_overrides(on, {"SEO_RESEARCH_WEB_SEARCH": "false", "SEO_EDITORIAL_CRITIQUE": "false", "SEO_RESEARCH_WEB_SEARCH_MAX": "99"})
    assert (off.research_web_search, off.research_web_search_max, off.editorial_critique) == (False, on.research_web_search_max, False)
    assert apply_overrides(s, {"SEO_RESEARCH_WEB_SEARCH": "maybe"}) is s
    assert [monthly_budget({"SEO_LLM_MONTHLY_BUDGET_USD": v}) for v in ("40", "12.5", "0", "-1", "abc", "", "99999")] == [40.0, 12.5, None, None, None, None, None]
    assert monthly_budget({}) is None
