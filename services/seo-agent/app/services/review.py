"""Review and flow operations shared by the internal HTTP API (the admin UI's proxy) and the admin MCP server.

There is deliberately **no approve function here**. Approval exists in exactly one place: the authenticated web
review UI, which records the approval and then calls `POST /review/{id}/decision` (`decide`). MCP tools can read the
queue and diffs, reject, add notes and start the allowlisted flows; none of them can reach `decide(approve)`,
publish_flow, rollback or submission (a static test of the tool registry enforces this).
"""

from __future__ import annotations

import re
from typing import Any

from ..flows import DRAFTING_FLOWS
from ..runs import FlowRunner, RunError, view
from .content import ContentError, clamp_limit, decode_cursor, encode_cursor, untrusted

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def check_uuid(v: str, what: str = "id") -> str:
    s = (v or "").strip().lower()
    if not UUID.match(s):
        raise ContentError(f"invalid {what}")
    return s


def review_link(site: str, draft_id: str) -> str:
    return f"{site}/admin/seo/review/{draft_id}"


async def decide(runner: FlowRunner, web: Any, draft_id: str, decision: str, *, approval_id: str | None = None, accepted_change_ids: list[str] | None = None, edits: dict[str, str] | None = None, feedback: str | None = None, actor: str | None = None) -> dict[str, Any]:
    """The split-flow human gate (D-56). Called only by the web app's review routes (service token).

    approve    → publish_flow with the approval the web app just recorded (it re-checks it before publishing)
    reject     → cancel any drafting run for the draft; close the draft (idempotent in the web app)
    regenerate → a new drafting run (optimize_article_flow or new_article_flow) with the reviewer's feedback
    """
    draft_id = check_uuid(draft_id, "draft id")
    if decision == "approve":
        if not approval_id or not accepted_change_ids:
            raise RunError(400, "approve needs the approval_id and accepted_change_ids the web app recorded")
        await runner.cancel_for_draft(draft_id, DRAFTING_FLOWS)
        return await runner.kickoff("publish_flow", {"draft_id": draft_id, "approval_id": approval_id, "accepted_change_ids": accepted_change_ids, "edits": edits or {}, "actor": actor}, triggered_by="approval", actor=actor)
    if decision == "reject":
        cancelled = await runner.cancel_for_draft(draft_id, DRAFTING_FLOWS)
        r = await web.reject_draft(draft_id, feedback, actor or "admin")
        return {"draft_id": draft_id, "status": r.get("status", "rejected"), "cancelled_runs": cancelled}
    if decision == "regenerate":
        d = await web.draft_summary(draft_id)
        await runner.cancel_for_draft(draft_id, DRAFTING_FLOWS)
        fb = (feedback or "The reviewer asked for a fresh set of changes.")[:2000]
        if d.get("kind") == "new_article":
            return await runner.kickoff("new_article_flow", {"draft_id": draft_id, "calendar_id": d["calendarId"], "article_id": d.get("articleId"), "feedback": fb}, triggered_by="manual", actor=actor)
        return await runner.kickoff("optimize_article_flow", {"draft_id": draft_id, "article_id": d["articleId"], "recommendation_ids": d.get("recommendationIds") or [], "feedback": fb, "trigger": "regenerate"}, triggered_by="manual", actor=actor)
    raise RunError(400, "decision must be approve, reject or regenerate")


# --- Read models for the admin MCP -----------------------------------------------------------------------------------


async def review_queue(web: Any, site: str, *, sort: str | None, kind: str | None, priority: str | None, limit: int | None, cursor: str | None) -> dict[str, Any]:
    lim = clamp_limit(limit, 20)
    off = int(decode_cursor(cursor).get("o", 0))
    params = {"sort": sort if sort in ("priority", "age", "changes") else "priority", "kind": kind if kind in ("optimize", "new_article", "news") else None, "priority": priority if priority in ("high", "medium", "low") else None, "limit": lim + 1, "offset": max(0, off)}
    r = await web.review_queue(params)
    rows = r.get("items") or []
    items = [{**{k: x.get(k) for k in ("id", "title", "path", "kind", "priority", "status", "changes", "accepted", "flags", "createdAt", "summary")}, "review_url": review_link(site, str(x.get("id")))} for x in rows[:lim]]
    return {"items": items, "total": r.get("total"), "next_cursor": encode_cursor({"o": off + lim}) if len(rows) > lim else None}


async def draft_diff(web: Any, site: str, draft_id: str, fmt: str | None, cursor: str | None) -> dict[str, Any]:
    draft_id = check_uuid(draft_id, "draft id")
    d = await web.draft_diff(draft_id)
    changes = d.get("changes") or []
    off = int(decode_cursor(cursor).get("o", 0))
    page = changes[off : off + 25]
    full = fmt == "full"

    def one(c: dict[str, Any]) -> dict[str, Any]:
        cap = 4000 if full else 600
        return {
            "id": c.get("id"),
            "type": c.get("type"),
            "location": c.get("location"),
            "decision": c.get("decision"),
            "before": untrusted(str(c.get("before") or "")[:cap]),
            "after": untrusted(str(c.get("after") or "")[:cap]),
            "diff": untrusted(str(c.get("diffText") or "")[:cap]) if c.get("diffText") else None,
            "rationale": c.get("rationale"),
            "evidence": c.get("evidence"),
            "flags": c.get("flags"),
        }

    return {
        "draft_id": draft_id,
        "title": d.get("title"),
        "status": d.get("status"),
        "summary": d.get("summary"),
        "flags": d.get("flags"),
        "notes": d.get("notes") or [],
        "changes": [one(c) for c in page],
        "total_changes": len(changes),
        "next_cursor": encode_cursor({"o": off + 25}) if len(changes) > off + 25 else None,
        "review_url": review_link(site, draft_id),
        "approve_in": "Approval is only possible in the web review page (review_url).",
    }


async def reject_draft(runner: FlowRunner, web: Any, site: str, draft_id: str, reason: str, actor: str) -> dict[str, Any]:
    draft_id = check_uuid(draft_id, "draft id")
    reason = (reason or "").strip()[:1000]
    if len(reason) < 3:
        raise ContentError("a reason is required")
    r = await decide(runner, web, draft_id, "reject", feedback=reason, actor=actor)
    return {**r, "review_url": review_link(site, draft_id), "reversible": "Regenerate the draft from the review page to try again."}


async def add_review_note(web: Any, site: str, draft_id: str, note: str, actor: str) -> dict[str, Any]:
    draft_id = check_uuid(draft_id, "draft id")
    note = (note or "").strip()
    if not 1 <= len(note) <= 2000:
        raise ContentError("a note is 1–2000 characters")
    r = await web.add_review_note(draft_id, note, actor)
    return {"draft_id": draft_id, "note_id": r.get("id"), "review_url": review_link(site, draft_id)}


async def list_runs(store: Any, *, flow: str | None, status: str | None, limit: int | None, cursor: str | None) -> dict[str, Any]:
    lim = clamp_limit(limit, 20)
    before = decode_cursor(cursor).get("b")
    rows = await store.list_runs(flow=flow, status=status, limit=lim + 1, before=before)
    items = [view(r) for r in rows[:lim]]
    return {"items": items, "next_cursor": encode_cursor({"b": items[-1]["started_at"]}) if len(rows) > lim and items else None}


async def get_run(store: Any, site: str, run_id: str) -> dict[str, Any]:
    run_id = check_uuid(run_id, "run id")
    r = await store.get(run_id)
    if not r:
        raise ContentError("run not found")
    v = view(r)
    if v.get("draft_id"):
        v["review_url"] = review_link(site, v["draft_id"])
    return v
