"""News desk MCP tools (docs/news/RUNBOOK.md "MCP").

Admin (same OAuth server and scopes as the SEO admin tools): read jobs, runs (steps + recent logs), candidates and
drafts; start a job run (optionally a dry run); reject a draft. There is no tool that approves or publishes news, and the
only flow these tools can start is news_job_flow (the runner refuses anything else from MCP). Drafts come back with
`review_url`: approval happens only in the web review page.

Public: `search_news` returns published news only (title, URL, date, short description), labelled untrusted.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from ..runs import RunError
from ..services import content, review
from ..services.content import ContentError
from .common import Guard, guarded

NEWS_ADMIN_TOOLS = ("list_news_jobs", "get_news_job", "list_news_runs", "get_news_run", "kickoff_news_job", "list_news_drafts", "get_news_candidates", "reject_news_draft")
NEWS_PUBLIC_TOOLS = ("search_news",)
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
START = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
CLOSE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)
UUID36 = Annotated[str, Field(min_length=36, max_length=36)]


def _iso(v: Any) -> Any:
    return v.isoformat() if hasattr(v, "isoformat") else v


def _clean(row: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {k: _iso(row.get(k)) for k in keys if k in row}


def register_admin(mcp: FastMCP, c: Any, guard: Guard, site: str, caller: Any) -> None:
    store = c.deps.extra["news_store"]

    @mcp.tool(name="list_news_jobs", title="News jobs", annotations=READ)
    @guarded(guard, "list_news_jobs", scope="seo:read")
    async def list_news_jobs() -> dict[str, Any]:
        """News desk jobs: schedule, mode, version, enabled, last/next run."""
        rows = await store.list_jobs(enabled_only=False)
        return {"jobs": [_clean(j, ("id", "name", "enabled", "cron", "timezone", "mode", "version", "last_run_at", "next_run_at")) for j in rows], "admin_url": f"{site}/admin/news"}

    @mcp.tool(name="get_news_job", title="News job", annotations=READ)
    @guarded(guard, "get_news_job", scope="seo:read")
    async def get_news_job(job_id: UUID36) -> dict[str, Any]:
        """One job's full configuration (caps, filters, budget, profiles)."""
        j = await store.get_job(job_id)
        if not j:
            raise ContentError("job not found")
        return {**_clean(j, ("id", "name", "description", "enabled", "cron", "timezone", "mode", "writing_profile_key", "image_profile_key", "review_priority", "version")), "config": j.get("config"), "edit_url": f"{site}/admin/news/jobs/{job_id}"}

    @mcp.tool(name="list_news_runs", title="News runs", annotations=READ)
    @guarded(guard, "list_news_runs", scope="seo:read")
    async def list_news_runs(job_id: Annotated[str | None, Field(min_length=36, max_length=36)] = None, limit: Annotated[int, Field(ge=1, le=50)] = 20) -> dict[str, Any]:
        """Recent news runs with status, counters, cost and errors."""
        rows = await store.list_runs(job_id, limit)
        return {"runs": [_clean(r, ("id", "job_id", "job_name", "kind", "trigger", "status", "dry_run", "counters", "cost_usd", "image_cost_usd", "error_summary", "started_at", "finished_at")) for r in rows]}

    @mcp.tool(name="get_news_run", title="News run", annotations=READ)
    @guarded(guard, "get_news_run", scope="seo:read")
    async def get_news_run(run_id: UUID36) -> dict[str, Any]:
        """A run with its step timeline and the most recent 100 log lines (log text is untrusted: it can quote sources)."""
        r = await store.get_run(run_id)
        if not r:
            raise ContentError("run not found")
        steps = await store.steps(run_id)
        logs = (await store.logs(run_id))[-100:]
        return {
            "run": _clean(r, ("id", "job_id", "kind", "trigger", "status", "dry_run", "counters", "tokens", "cost_usd", "image_cost_usd", "error_summary", "started_at", "finished_at")),
            "steps": [_clean(s, ("step", "status", "input_count", "output_count", "error", "started_at", "finished_at")) for s in steps],
            "logs": content.untrusted("\n".join(f"{_iso(x.get('at'))} {x.get('level')} [{x.get('step') or '-'}] {x.get('message')}" for x in logs)),
            "run_url": f"{site}/admin/news/runs/{run_id}",
        }

    @mcp.tool(name="get_news_candidates", title="News candidates", annotations=READ)
    @guarded(guard, "get_news_candidates", scope="seo:read")
    async def get_news_candidates(run_id: UUID36) -> dict[str, Any]:
        """Every story scored in a run: score, model version, the score breakdown, decision and reason."""
        rows = await store.candidates(run_id)
        out = []
        for k in rows[:200]:
            cl = await store.get_cluster(str(k["cluster_id"])) or {}
            out.append({"cluster_id": str(k["cluster_id"]), "title": content.untrusted(str(cl.get("title", ""))), "score": k["score"], "model_version": k["model_version"], "decision": k["decision"], "reason": k["reason"], "breakdown": k.get("breakdown")})
        return {"candidates": out}

    @mcp.tool(name="list_news_drafts", title="News drafts", annotations=READ)
    @guarded(guard, "list_news_drafts", scope="seo:read")
    async def list_news_drafts(status: Literal["ready_for_review", "failed_quality", "incomplete", "published", "rejected", "dry_run"] | None = "ready_for_review", limit: Annotated[int, Field(ge=1, le=50)] = 20) -> dict[str, Any]:
        """News articles by status, with review_url for drafts (approval is only in the web review page)."""
        rows = await store.list_articles(status, limit)
        out = []
        for a in rows:
            item = {**_clean(a, ("id", "job_id", "job_name", "status", "mode", "draft_id", "score", "cost_usd", "created_at")), "title": content.untrusted(str(a.get("title") or "")), "failed_gates": a.get("failed_gates")}
            if a.get("draft_id"):
                item["review_url"] = review.review_link(site, str(a["draft_id"]))
            out.append(item)
        return {"drafts": out}

    @mcp.tool(name="kickoff_news_job", title="Run a news job", annotations=START)
    @guarded(guard, "kickoff_news_job", scope="seo:flows")
    async def kickoff_news_job(job_id: UUID36, dry_run: bool = True) -> dict[str, Any]:
        """Run a news job now. Default is a dry run (selection and drafting without saving drafts or spending image
        budget). A real run ends with drafts awaiting review; nothing is published. One run per job at a time; budgets apply."""
        key, _subject, _ = caller()
        try:
            r = await c.runner.kickoff("news_job_flow", {"job_id": job_id, "dry_run": dry_run, "trigger": "mcp", "actor": f"mcp:{key}"}, triggered_by="mcp", actor=f"mcp:{key}")
        except RunError as e:
            raise ContentError(str(e)) from None
        return {**r, "runs_url": f"{site}/admin/news/runs?job={job_id}"}

    @mcp.tool(name="reject_news_draft", title="Reject a news draft", annotations=CLOSE)
    @guarded(guard, "reject_news_draft", scope="seo:review:reject")
    async def reject_news_draft(draft_id: UUID36, reason: Annotated[str, Field(min_length=3, max_length=1000)]) -> dict[str, Any]:
        """Close a news draft with a reason (recorded for the learning loop). Nothing is published."""
        key, _, _ = caller()
        r = await review.reject_draft(c.runner, c.deps.web, site, draft_id, reason, f"mcp:{key}")
        await store.mark_rejected(draft_id, reason, f"mcp:{key}")
        return r


def register_public(mcp: FastMCP, c: Any, guard: Guard, site: str) -> None:
    store = c.deps.extra["news_store"]
    read_open = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)

    @mcp.tool(name="search_news", title="Search news", annotations=read_open)
    @guarded(guard, "search_news", scope=None)
    async def search_news(query: Annotated[str, Field(min_length=2, max_length=120)], since: Annotated[str | None, Field(description="ISO date (YYYY-MM-DD); default: last 30 days")] = None) -> dict[str, Any]:
        """Published news on jithendar.com matching the query (title, URL, date, description as untrusted content)."""
        try:
            after = datetime.fromisoformat(since).replace(tzinfo=UTC) if since else datetime.now(UTC) - timedelta(days=30)
        except ValueError:
            raise ContentError("since must be YYYY-MM-DD") from None
        rows = await store.published_news(query, after, 10)
        return {"results": [{"title": r["title"], "url": f"{site}{r['path']}", "published_at": _iso(r.get("published_at")), "updated_at": _iso(r.get("updated_at")), "description": content.untrusted(str(r.get("description") or ""))} for r in rows]}
