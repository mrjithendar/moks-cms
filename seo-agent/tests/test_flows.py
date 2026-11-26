"""CrewAI Flows end to end with the in-memory run manager, fake web app and fake/deterministic crews (no API calls)."""

from __future__ import annotations

import ast
import asyncio
import pathlib
from typing import Any

import pytest

from app.crews.optimization import OptimizationResult
from app.crews.report import ReportCrewResult
from app.llm import BudgetExceeded
from app.main import memory_container
from app.runs import RunError
from app.services import review
from tests.conftest import ARTICLE, CALENDAR, DRAFT, FakeOptimizationCrew, FakeWebApp, fact_flag, good_changeset, settings

OPT = {"article_id": ARTICLE, "draft_id": DRAFT, "recommendation_ids": ["r1"]}


def container(llm: Any, web: FakeWebApp, crew: FakeOptimizationCrew | None = None, **kw: Any) -> Any:
    c = memory_container(settings(**kw), llm=llm, web=web, optimization_crew=(lambda: crew) if crew else None)
    return c


async def run(c: Any, name: str, inputs: dict[str, Any], trigger: str = "manual") -> dict[str, Any]:
    r = await c.runner.kickoff(name, inputs, triggered_by=trigger)
    return await c.runner.wait(r["run_id"], 30)


# --- optimize_article_flow -----------------------------------------------------------------------------------------


async def test_optimize_happy_path_ends_at_draft_awaiting_review(llm, web) -> None:
    crew = FakeOptimizationCrew([OptimizationResult(problem_statement="CTR gap", change_set=good_changeset(), needs_fact_check=[fact_flag()])])
    c = container(llm, web, crew)
    r = await run(c, "optimize_article_flow", OPT)
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "draft_ready"
    assert web.drafts[DRAFT]["status"] == "ready_for_review"
    assert [x for x in web.calls if x[0] == "publish"] == [] and web.published == [] and web.submitted == []
    flags = web.drafts[DRAFT]["flags"]
    assert any(f["code"] == "needs_fact_check" for f in flags)  # the reviewer's flags reach the human
    assert r["state_json"]["changes"] and r["current_step"] == "save_draft"  # CrewAI persisted the final state
    assert r["cost_usd"] > 0 and r["tokens"] == 3000


async def test_validation_failure_retries_once_then_succeeds(llm, web) -> None:
    web.validate_errors = [["before text not found in b4"]]
    crew = FakeOptimizationCrew()
    c = container(llm, web, crew)
    r = await run(c, "optimize_article_flow", OPT)
    assert r["outputs"]["outcome"] == "draft_ready" and len(crew.runs) == 2
    assert "before text not found in b4" in (crew.runs[1]["validator_feedback"] or "") and crew.runs[1]["feedback"] is None


async def test_validation_failure_twice_fails_the_draft(llm, web) -> None:
    web.validate_errors = [["bad 1"], ["bad 2"]]
    crew = FakeOptimizationCrew()
    c = container(llm, web, crew)
    r = await run(c, "optimize_article_flow", OPT)
    assert r["status"] == "failed" and r["outputs"]["outcome"] == "generation_failed" and len(crew.runs) == 2
    assert ("status", (DRAFT, "generation_failed", "Validation failed: bad 2")) in web.calls


async def test_crew_without_output_counts_as_a_failed_attempt(llm, web) -> None:
    crew = FakeOptimizationCrew([None, None])
    r = await run(container(llm, web, crew), "optimize_article_flow", OPT)
    assert r["outputs"]["outcome"] == "generation_failed" and len(crew.runs) == 2


async def test_budget_pauses_the_run(llm, web) -> None:
    crew = FakeOptimizationCrew([BudgetExceeded("monthly", "monthly LLM budget $10.00 would be exceeded")])
    r = await run(container(llm, web, crew), "optimize_article_flow", OPT)
    assert r["status"] == "paused_budget"
    assert web.drafts[DRAFT]["status"] == "generation_failed"


async def test_unpublished_article_is_skipped(llm, web) -> None:
    web.article_status = "draft"
    crew = FakeOptimizationCrew()
    r = await run(container(llm, web, crew), "optimize_article_flow", OPT)
    assert r["outputs"]["outcome"] == "no_changes" and crew.runs == []


async def test_rerun_while_running_returns_the_existing_run(llm, web) -> None:
    gate = asyncio.Event()

    class Slow(FakeOptimizationCrew):
        async def run(self, context: dict[str, Any], **kw: Any) -> Any:
            await gate.wait()
            return await super().run(context, **kw)

    c = container(llm, web, Slow())
    a = await c.runner.kickoff("optimize_article_flow", OPT)
    b = await c.runner.kickoff("optimize_article_flow", OPT)
    assert b["existing"] and b["run_id"] == a["run_id"]  # one active run per flow + target
    gate.set()
    assert (await c.runner.wait(a["run_id"], 10))["status"] == "succeeded"
    again = await run(c, "optimize_article_flow", OPT)  # idempotent rerun: upserts the same draft
    assert again["status"] == "succeeded" and len([x for x in web.calls if x == ("save", DRAFT)]) == 2


async def test_advisory_lock_held_elsewhere_cancels_the_run(llm, web) -> None:
    c = container(llm, web, FakeOptimizationCrew())
    await c.runner.locks.acquire(f"optimize_article_flow:{DRAFT}")  # e.g. a second process
    r = await run(c, "optimize_article_flow", OPT)
    assert r["status"] == "cancelled" and "lock" in r["error"] and web.drafts == {}


async def test_inputs_are_validated_strictly(llm, web) -> None:
    c = container(llm, web, FakeOptimizationCrew())
    with pytest.raises(RunError) as e:
        await c.runner.kickoff("optimize_article_flow", {**OPT, "draft_id": "../../etc"})
    assert e.value.status == 422
    with pytest.raises(RunError):
        await c.runner.kickoff("optimize_article_flow", {**OPT, "shell": "rm -rf /"})


# --- split-flow approval -------------------------------------------------------------------------------------------


async def draft_ready(llm: Any, web: FakeWebApp) -> Any:
    c = container(llm, web, FakeOptimizationCrew())
    assert (await run(c, "optimize_article_flow", OPT))["outputs"]["outcome"] == "draft_ready"
    return c


async def test_approve_starts_publish_flow_which_publishes_verifies_submits_and_reindexes(llm, web) -> None:
    c = await draft_ready(llm, web)
    d = web.approve(DRAFT)  # what the web review route records before calling the decision endpoint
    r = await review.decide(c.runner, web, DRAFT, "approve", approval_id=d["approval_id"], accepted_change_ids=d["accepted_change_ids"], actor="admin@example.com")
    done = await c.runner.wait(r["run_id"], 30)
    assert done["flow_name"] == "publish_flow" and done["triggered_by"] == "approval"
    assert done["status"] == "succeeded" and done["outputs"]["outcome"] == "published"
    assert web.published == [DRAFT] and web.submitted == [DRAFT]
    assert done["state_json"]["reindex"] is not None and done["state_json"]["measurement"]["windows_days"] == [28, 56]


async def test_reject_publishes_nothing(llm, web) -> None:
    c = await draft_ready(llm, web)
    r = await review.decide(c.runner, web, DRAFT, "reject", feedback="Not needed", actor="admin")
    assert r["status"] == "rejected" and web.rejected == [(DRAFT, "Not needed")]
    await asyncio.sleep(0)
    assert web.published == [] and all(x["flow_name"] != "publish_flow" for x in c.store.rows.values())


async def test_regenerate_starts_a_new_drafting_run_with_feedback(llm, web) -> None:
    crew = FakeOptimizationCrew()
    c = container(llm, web, crew)
    await run(c, "optimize_article_flow", OPT)
    r = await review.decide(c.runner, web, DRAFT, "regenerate", feedback="Shorter title please", actor="admin")
    done = await c.runner.wait(r["run_id"], 30)
    assert done["flow_name"] == "optimize_article_flow" and done["outputs"]["outcome"] == "draft_ready"
    assert "Shorter title please" in (crew.runs[-1]["feedback"] or "")
    assert ("status", (DRAFT, "generating", None)) in web.calls


async def test_a_forged_or_reused_approval_never_publishes(llm, web) -> None:
    c = await draft_ready(llm, web)
    r = await review.decide(c.runner, web, DRAFT, "approve", approval_id="forged", accepted_change_ids=["c1", "c2"])
    done = await c.runner.wait(r["run_id"], 30)
    assert done["outputs"]["outcome"] == "publish_failed" and web.published == []
    d = web.approve(DRAFT)
    first = await c.runner.wait((await review.decide(c.runner, web, DRAFT, "approve", approval_id=d["approval_id"], accepted_change_ids=d["accepted_change_ids"]))["run_id"], 30)
    second = await c.runner.wait((await review.decide(c.runner, web, DRAFT, "approve", approval_id=d["approval_id"], accepted_change_ids=d["accepted_change_ids"]))["run_id"], 30)
    assert first["outputs"]["outcome"] == "published" and second["outputs"]["outcome"] == "publish_failed" and web.published == [DRAFT]


async def test_verification_failure_offers_rollback_and_submits_nothing(llm, web) -> None:
    web.verify_states = ["failed", "failed", "failed"]
    c = await draft_ready(llm, web)
    d = web.approve(DRAFT)
    done = await c.runner.wait((await review.decide(c.runner, web, DRAFT, "approve", approval_id=d["approval_id"], accepted_change_ids=d["accepted_change_ids"]))["run_id"], 30)
    assert done["status"] == "failed" and done["outputs"]["outcome"] == "verify_failed"
    assert web.alerts == [DRAFT] and web.submitted == []


@pytest.mark.parametrize("trigger", ["manual", "cron", "flow", "mcp"])
async def test_publish_flow_cannot_be_started_without_an_approval(llm, web, trigger: str) -> None:
    c = await draft_ready(llm, web)
    d = web.approve(DRAFT)
    with pytest.raises(RunError) as e:
        await c.runner.kickoff("publish_flow", {"draft_id": DRAFT, "approval_id": d["approval_id"], "accepted_change_ids": d["accepted_change_ids"]}, triggered_by=trigger)
    assert e.value.status == 403 and web.published == []


def test_no_drafting_code_path_reaches_publish() -> None:
    """Static: only flows/publish.py calls the web app's publish/verify/submit callbacks, and the string
    "publish_flow" (the only way to start it) appears only in its own definition, the registry and the review
    decision service. Crews, tools, other flows and the MCP servers contain neither."""
    root = pathlib.Path(__file__).parent.parent / "app"
    allowed_name = {root / "flows" / "publish.py", root / "flows" / "__init__.py", root / "services" / "review.py", root / "metrics.py"}  # metrics: a fixed label set
    for f in root.rglob("*.py"):
        tree = ast.parse(f.read_text())
        calls = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        names = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and n.value == "publish_flow"}
        if f.name != "publish.py" and f.parent.name in ("flows", "crews", "tools", "mcp", "services"):
            assert not calls & {"publish", "verify", "submit"}, f"{f} calls a publishing callback"
        if f not in allowed_name:
            assert not names, f"{f} names publish_flow"


# --- other flows ---------------------------------------------------------------------------------------------------


async def test_weekly_fans_out_with_at_most_two_concurrent_children(llm, web) -> None:
    drafts = [f"2222222{i}-2222-4222-8222-222222222222" for i in range(5)]
    web.weekly_items = [{"articleId": ARTICLE, "draftId": d, "recommendationIds": ["r1"]} for d in drafts]
    live, peak = 0, 0

    class Counting(FakeOptimizationCrew):
        async def run(self, context: dict[str, Any], **kw: Any) -> Any:
            nonlocal live, peak
            live += 1
            peak = max(peak, live)
            await asyncio.sleep(0.01)
            live -= 1
            return await super().run(context, **kw)

    c = container(llm, web, Counting())
    r = await run(c, "weekly_recommendations_flow", {}, "cron")
    assert r["status"] == "succeeded" and len(r["outputs"]["children"]) == 5
    assert peak <= 2 and all(ch["outcome"] == "draft_ready" for ch in r["outputs"]["children"])
    assert web.published == []


@pytest.mark.parametrize(("flow", "job"), [("gsc_sync_flow", "gsc_sync"), ("ga4_sync_flow", "ga4_sync"), ("tech_audit_flow", "technical_scan")])
async def test_job_flows_wrap_the_existing_v1_jobs(llm, web, flow: str, job: str) -> None:
    r = await run(container(llm, web), flow, {}, "cron")
    assert r["status"] == "succeeded" and web.jobs[0][0] == job and web.jobs[0][2] == "schedule" and web.jobs[0][1]  # dated slot
    web.job_status = "failed"
    assert (await run(container(llm, web), flow, {}, "manual"))["status"] == "failed"


async def test_internal_linking_merges_into_open_drafts(llm, web, retriever) -> None:
    c = memory_container(settings(), llm=llm, web=web, retriever=retriever)
    r = await run(c, "internal_linking_flow", {}, "cron")
    assert r["outputs"]["outcome"] == "links_added" and web.links_planned[0][0] == ARTICLE


async def test_reindex_and_ask_gaps_flows(llm, web) -> None:
    c = container(llm, web)
    assert (await run(c, "reindex_flow", {"full": False}, "cron"))["status"] == "succeeded"
    assert (await run(c, "ask_gaps_flow", {}, "cron"))["outputs"]["result"] == {"clustered": 3}


async def test_new_article_flow_saves_a_draft(llm, web) -> None:
    from app.crews.editorial import CrewResult
    from app.schemas import NewArticleDraft

    class Ed:
        async def run(self, brief: dict[str, Any], **kw: Any) -> CrewResult:
            d = NewArticleDraft(title="Rotate cert-manager certificates", slug_suggestion="rotate", meta_description="m" * 130, outline=["a"], body_mdx="## a\n\nb")
            return CrewResult(d, "completed", 9000, 0.05, [], [])

    c = memory_container(settings(), llm=llm, web=web, editorial_crew=lambda: Ed())
    r = await run(c, "new_article_flow", {"draft_id": DRAFT, "calendar_id": CALENDAR})
    assert r["outputs"]["outcome"] == "draft_ready" and web.drafts[DRAFT]["kind"] == "new_article" and web.published == []


# --- report_flow ---------------------------------------------------------------------------------------------------


class FakeReportCrew:
    def __init__(self, text: str):
        self.text = text

    async def run(self, report: dict[str, Any], facts: list[dict[str, str]]) -> ReportCrewResult:
        return ReportCrewResult(self.text, "completed", None, 1200, 0.001)


async def test_report_flow_stores_narrative_saves_pdf_and_notifies(llm, web) -> None:
    c = memory_container(settings(), llm=llm, web=web, report_crew=lambda: FakeReportCrew("Clicks rose 14.1% to 665; impressions reached 24,310 (+6.2%)."))
    r = await run(c, "report_flow", {"period": "weekly"}, "cron")
    assert r["status"] == "succeeded" and web.reports["rep-weekly"]["narrative"].startswith("Clicks rose")
    pdf = web.pdfs["rep-weekly"]
    assert pdf.startswith(b"%PDF-") and len(pdf) > 3000
    assert r["outputs"]["pdf"]["with_narrative"] is True and web.notified == ["rep-weekly"]


async def test_report_number_mismatch_fails_the_report(llm, web) -> None:
    c = memory_container(settings(), llm=llm, web=web, report_crew=lambda: FakeReportCrew("Clicks rose 18% to 700."))
    r = await run(c, "report_flow", {"period": "monthly"}, "cron")
    assert r["status"] == "failed" and r["outputs"]["outcome"] == "report_mismatch"
    assert "narrative" not in web.reports["rep-monthly"] and web.notified == []
    assert r["outputs"]["pdf"]["with_narrative"] is False  # the numbers-only PDF is still saved


# --- restarts and persistence --------------------------------------------------------------------------------------


async def test_orphaned_runs_are_failed_on_startup_and_their_draft_marked(llm, web) -> None:
    c = container(llm, web, FakeOptimizationCrew())
    await c.store.create({"run_id": "r-1", "flow_name": "optimize_article_flow", "target_id": DRAFT, "draft_id": DRAFT, "status": "running", "inputs": OPT, "triggered_by": "manual"})
    assert await c.runner.recover() == ["r-1"]
    assert c.store.rows["r-1"]["status"] == "failed" and web.drafts[DRAFT]["status"] == "generation_failed"


async def test_no_sqlite_or_crewai_memory_is_created(llm, web, tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CREWAI_STORAGE_DIR", str(tmp_path / "crewai"))
    await run(container(llm, web, FakeOptimizationCrew()), "optimize_article_flow", OPT)
    assert not [p for p in tmp_path.rglob("*") if p.suffix in (".db", ".sqlite", ".sqlite3", ".lance")]


def test_combine_weights_vector_similarity_and_shared_queries() -> None:
    from app.flows.maintenance import combine

    out = combine([("b", "/blog/b", 0.80), ("c", "/blog/c", 0.60)], {"istio mtls", "istio strict"}, {"/blog/b": set(), "/blog/c": {"istio mtls", "istio strict"}})
    assert [c["path"] for c in out] == ["/blog/c", "/blog/b"]  # shared queries outweigh a small similarity edge
    assert out[0]["sharedQueries"] == ["istio mtls", "istio strict"]
