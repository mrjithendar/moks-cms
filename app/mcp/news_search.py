"""Public MCP tool `search_news`: published news articles on the site (title, URL, date, short description, labelled
untrusted). Published news are CMS posts (collection `news`), so this tool stays with the public MCP server here when
the news desk itself moved to the news agent (mrjithendar/newsroom, 2026-11-21). The news desk's admin MCP tools did
not move: the admin MCP server was off, and the news agent has no MCP server.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from ..services import content
from ..services.content import ContentError
from .common import Guard, guarded

NEWS_PUBLIC_TOOLS = ("search_news",)


class PgPublishedNews:
    def __init__(self, pool: Any):
        self.pool = pool

    async def search(self, query: str, since: datetime | None, limit: int) -> list[dict[str, Any]]:
        q = f"%{query.replace('%', '').replace('_', ' ')[:120]}%"
        async with self.pool.connection() as c:
            cur = await c.execute(
                """select title, '/' || collection || '/' || slug as path, description, published_at, updated_at from post
                   where collection = 'news' and status = 'published' and deleted_at is null and noindex = false and (%(since)s::timestamptz is null or published_at >= %(since)s)
                     and (title ilike %(q)s or description ilike %(q)s or body ilike %(q)s) order by published_at desc limit %(n)s""",
                {"q": q, "since": since, "n": max(1, min(limit, 20))},
            )
            return [dict(r) for r in await cur.fetchall()]


@dataclass
class MemoryPublishedNews:
    posts: dict[str, dict[str, Any]] = field(default_factory=dict)

    async def search(self, query: str, since: datetime | None, limit: int) -> list[dict[str, Any]]:
        q = query.lower()
        out = [p for p in self.posts.values() if p.get("collection") == "news" and p.get("status") == "published" and (since is None or p["published_at"] >= since) and (q in p["title"].lower() or q in p.get("body", "").lower())]
        return sorted(out, key=lambda p: p["published_at"], reverse=True)[:limit]


def _iso(v: Any) -> Any:
    return v.isoformat() if hasattr(v, "isoformat") else v


def register_public(mcp: FastMCP, c: Any, guard: Guard, site: str) -> None:
    store = c.deps.extra["published_news"]
    read_open = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)

    @mcp.tool(name="search_news", title="Search news", annotations=read_open)
    @guarded(guard, "search_news", scope=None)
    async def search_news(query: Annotated[str, Field(min_length=2, max_length=120)], since: Annotated[str | None, Field(description="ISO date (YYYY-MM-DD); default: last 30 days")] = None) -> dict[str, Any]:
        """Published news on jithendar.com matching the query (title, URL, date, description as untrusted content)."""
        try:
            after = datetime.fromisoformat(since).replace(tzinfo=UTC) if since else datetime.now(UTC) - timedelta(days=30)
        except ValueError:
            raise ContentError("since must be YYYY-MM-DD") from None
        rows = await store.search(query, after, 10)
        return {"results": [{"title": r["title"], "url": f"{site}{r['path']}", "published_at": _iso(r.get("published_at")), "updated_at": _iso(r.get("updated_at")), "description": content.untrusted(str(r.get("description") or ""))} for r in rows]}
