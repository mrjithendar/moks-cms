"""Dashboard read models for the admin MCP: thin wrappers over the web app's own TypeScript query functions (the same
ones the admin's search and analytics pages render), reached through the internal callback API `/data/*`.

Nothing here computes metrics; it validates arguments (enums, slugs, bounded limits) and trims payloads.
"""

from __future__ import annotations

from typing import Any

from .content import ContentError, check_slug, clamp_limit, decode_cursor, encode_cursor

PERIODS = ("7d", "28d", "90d", "16m")
KEYWORD_VIEWS = ("striking", "low_ctr", "rising", "lost", "cannibalization", "gaps")
SEVERITIES = ("error", "warning", "notice")


def check_period(p: str | None, default: str = "28d") -> str:
    p = p or default
    if p not in PERIODS:
        raise ContentError(f"period must be one of {', '.join(PERIODS)}")
    return p


async def overview(web: Any, period: str | None) -> dict[str, Any]:
    return await web.data("overview", {"period": check_period(period)})


async def explain_traffic_change(web: Any, page_or_query: str, period: str | None) -> dict[str, Any]:
    v = (page_or_query or "").strip()
    if not 2 <= len(v) <= 200:
        raise ContentError("give a page path (/blog/slug) or a search query (2–200 characters)")
    if v.startswith("/"):  # a page path (/blog/slug); anything else is a search query
        slug = check_slug(v)
        col = v.strip("/").split("/")[0] if "/" in v.strip("/") else "blog"
        return await web.data("traffic-change", {"page": f"/{col}/{slug}", "period": check_period(period)})
    return await web.data("traffic-change", {"query": v, "period": check_period(period)})


async def keyword_opportunities(web: Any, view: str | None, filters: dict[str, Any] | None, limit: int | None, cursor: str | None) -> dict[str, Any]:
    v = view or "striking"
    if v not in KEYWORD_VIEWS:
        raise ContentError(f"view must be one of {', '.join(KEYWORD_VIEWS)}")
    f = filters or {}
    allowed: dict[str, str] = {k: str(f[k])[:100] for k in ("q", "brand", "intent", "min_impressions") if k in f and f[k] is not None}
    lim = clamp_limit(limit, 25)
    off = int(decode_cursor(cursor).get("o", 0))
    r = await web.data("keywords", {"view": v, **allowed, "limit": lim, "offset": max(0, off)})
    rows = r.get("rows") or []
    return {**{k: r.get(k) for k in ("view", "source", "period", "total", "notes")}, "rows": rows[:lim], "next_cursor": encode_cursor({"o": off + lim}) if (r.get("total") or 0) > off + lim else None}


async def page_report(web: Any, slug: str) -> dict[str, Any]:
    s = check_slug(slug)
    col = slug.strip("/").split("/")[0] if "/" in slug.strip("/") else "blog"
    return await web.data("page-report", {"path": f"/{col}/{s}"})


async def audit_issues(web: Any, severity: str | None, issue_type: str | None, limit: int | None, cursor: str | None) -> dict[str, Any]:
    if severity and severity not in SEVERITIES:
        raise ContentError(f"severity must be one of {', '.join(SEVERITIES)}")
    if issue_type and not issue_type.replace("_", "").isalnum():
        raise ContentError("invalid issue type")
    lim = clamp_limit(limit, 25)
    off = int(decode_cursor(cursor).get("o", 0))
    r = await web.data("audit-issues", {"severity": severity, "check": issue_type, "limit": lim, "offset": max(0, off)})
    return {**r, "next_cursor": encode_cursor({"o": off + lim}) if (r.get("total") or 0) > off + lim else None}


async def llm_usage(web: Any, guard: Any, period: str | None) -> dict[str, Any]:
    p = period or "month"
    if p not in ("day", "week", "month"):
        raise ContentError("period must be day, week or month")
    r = await web.data("llm-usage", {"period": p})
    return {**r, "budget": await guard.status()}
