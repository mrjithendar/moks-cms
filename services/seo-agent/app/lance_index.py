"""The article index in LanceDB (D-93; D-91 step 3, first half): a copy of pgvector's `seo_article_chunks`.

pgvector stays the index Ask the Blog and the crews search. After every reindex that changed something (and once at
startup, when the table is missing) the published articles' chunks are copied, with the vectors pgvector already holds,
into the LanceDB table `article_chunks` on R2 (`s3://<media bucket>/jithendar/seo-agent/lancedb`, D-92). Nothing is
embedded twice. A LanceDB retriever and the RAG evaluation on both stores come next (D-91 step 3, second half).

- The copy is whole: each sync rewrites the table (one new version) from Postgres, so it never drifts; an edit made in
  /admin/lancedb on this table lasts until the next sync. Versions older than KEEP_VERSIONS are cleaned up, so R2
  holds about one copy of the index.
- An empty result never replaces a filled table (the reindex guard's idea: a broken query must not wipe the copy).
- A failed sync is logged and never fails the reindex: pgvector is the source of truth.
- Only seo-agent writes to LanceDB (D-91: one writer); syncs run under the container's reindex lock.
- `LANCEDB_ARTICLE_INDEX=false` turns it off.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .index import LIVE_TABLE

log = logging.getLogger("seo_agent.lance_index")

TABLE = "article_chunks"
KEEP_VERSIONS = dt.timedelta(hours=1)  # a browser page still reading the previous version keeps working

# Published articles only, like the searches (index.CHUNK_SELECT). `embedding::text` is pgvector's "[x,y,…]".
SELECT = f"""select ch.article_id::text || ':' || ch.chunk_index as id, ch.article_id::text as article_id, ch.chunk_index,
       p.title, '/' || p.collection || '/' || p.slug as path, coalesce(p.category, '') as category, ch.heading_path,
       coalesce(ch.anchor, '') as anchor, ch.content, ch.content_hash, ch.model, ch.updated_at, ch.embedding::text as embedding
     from {LIVE_TABLE} ch join post p on p.id = ch.article_id
     where p.status = 'published' and p.deleted_at is null
     order by p.title, ch.article_id, ch.chunk_index"""  # noqa: S608 - constant table name

COLUMNS = ("id", "article_id", "chunk_index", "title", "path", "category", "heading_path", "anchor", "content", "content_hash", "model", "updated_at")


def fetch_from(pool: Any) -> Callable[[], Awaitable[list[dict[str, Any]]]]:
    async def fetch() -> list[dict[str, Any]]:
        async with pool.connection() as c:
            cur = await c.execute(SELECT)
            return list(await cur.fetchall())

    return fetch


def to_arrow(rows: list[dict[str, Any]]) -> Any:
    """Rows → an Arrow table with a fixed-size float32 `vector` column (what LanceDB searches)."""
    import pyarrow as pa

    vectors = [json.loads(r["embedding"]) if isinstance(r["embedding"], str) else list(r["embedding"]) for r in rows]
    dims = {len(v) for v in vectors}
    if len(dims) != 1:
        raise ValueError(f"chunks have mixed embedding sizes {sorted(dims)}")
    (dim,) = dims
    stamps = [r["updated_at"].astimezone(dt.UTC).replace(tzinfo=None) if r["updated_at"].tzinfo else r["updated_at"] for r in rows]
    schema = pa.schema(
        [
            ("id", pa.string()),
            ("article_id", pa.string()),
            ("chunk_index", pa.int32()),
            ("title", pa.string()),
            ("path", pa.string()),
            ("category", pa.string()),
            ("heading_path", pa.string()),
            ("anchor", pa.string()),
            ("content", pa.string()),
            ("content_hash", pa.string()),
            ("model", pa.string()),
            ("updated_at", pa.timestamp("us")),
            ("vector", pa.list_(pa.float32(), dim)),
        ]
    )
    data = {k: [r[k] for r in rows] for k in COLUMNS if k != "updated_at"}
    data["updated_at"] = stamps
    data["vector"] = vectors
    return pa.Table.from_pydict(data, schema=schema)


@dataclass
class ArticleMirror:
    admin: Any  # app.lance_admin.LanceAdmin: the one LanceDB connection of this service
    fetch: Callable[[], Awaitable[list[dict[str, Any]]]]
    enabled: bool = True

    def _exists(self) -> bool:
        return TABLE in self.admin._names()

    def _write(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        db = self.admin._conn()
        if not rows:
            if TABLE in self.admin._names() and db.open_table(TABLE).count_rows():
                log.warning("lancedb article index: no chunks in Postgres, keeping the existing copy", extra={"event": "lancedb_index_empty"})
                return {"synced": False, "reason": "no chunks in Postgres; kept the existing copy"}
            return {"synced": False, "reason": "no chunks in Postgres yet (run a reindex)"}
        t = db.create_table(TABLE, data=to_arrow(rows), mode="overwrite")
        try:
            t.optimize(cleanup_older_than=KEEP_VERSIONS)
        except Exception as e:  # cleanup is housekeeping: the new version is written either way
            log.warning("lancedb article index: cleanup failed", extra={"event": "lancedb_index_cleanup_failed", "error": type(e).__name__})
        return {"synced": True, "rows": t.count_rows(), "articles": len({r["article_id"] for r in rows}), "version": t.version}

    async def sync(self, *, only_if_missing: bool = False) -> dict[str, Any]:
        if not self.enabled:
            return {"synced": False, "reason": "off (LANCEDB_ARTICLE_INDEX=false)"}
        await self.admin.ensure()
        if not self.admin.configured:
            return {"synced": False, "reason": "LanceDB storage is not configured (Admin → Storage)"}
        if only_if_missing and await asyncio.to_thread(self._exists):
            return {"synced": False, "reason": "already there"}
        rows = await self.fetch()
        out = await asyncio.to_thread(self._write, rows)
        if out.get("synced"):
            log.info("lancedb article index synced", extra={"event": "lancedb_index_synced", "rows": out["rows"], "articles": out["articles"], "version": out["version"]})
        return out

    async def after_reindex(self, stats: dict[str, int]) -> dict[str, Any]:
        """Never raises: the reindex already succeeded in Postgres."""
        changed = any(stats.get(k) for k in ("embedded", "reused", "deleted", "swapped"))
        try:
            return await self.sync(only_if_missing=not changed)
        except Exception as e:
            log.warning("lancedb article index sync failed", extra={"event": "lancedb_index_failed", "error": type(e).__name__})
            return {"synced": False, "reason": f"failed: {type(e).__name__}"}
