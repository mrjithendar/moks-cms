"""Read-only browser of the article index in pgvector, for the web app's /admin/article-index page (D-103).

The index is `seo_article_chunks` (app/index.py) and, while a rebuild after an embeddings model change is running,
`seo_article_chunks_next`. seo-agent owns both tables (their vector size follows the model), so the web app reads them
through this service's internal API (bearer SEO_AGENT_TOKEN, ClusterIP only) instead of copying their columns.

Nothing here writes. A chunk edited by hand would no longer match its vector, and the next reindex rewrites it anyway:
change the article and publish it, or run the Reindex flow.

- Tables are picked as "live" or "rebuild", never by a name from the request.
- Every filter is a bound parameter; the text filter is a case-insensitive substring match with % and _ escaped.
- Vectors are shown as their size, norm and first values, never in full.
"""

from __future__ import annotations

import uuid
from typing import Any

from .index import LIVE_TABLE, NEXT_TABLE

TABLES = {"live": LIVE_TABLE, "rebuild": NEXT_TABLE}
MAX_PAGE = 100
MAX_QUERY = 200
TEXT_PREVIEW = 300  # characters of a chunk in a page of rows (one chunk's own view returns all of it)
VECTOR_PREVIEW = 8  # leading values of a vector in a page of rows
VECTOR_DETAIL = 16  # leading values in one chunk's own view
SIMILAR = 5  # nearest other chunks shown with one chunk

# Joined to the web app's `post` table for the title, path and status; a left join, so a chunk whose article was
# unpublished or deleted since the last reindex still shows (status "draft", "deleted" or "missing").
_ARTICLE = """coalesce(p.title, ch.title) as title,
       case when p.id is null then null else '/' || p.collection || '/' || p.slug end as path,
       case when p.id is null then 'missing' when p.deleted_at is not null then 'deleted' else p.status end as status"""

_ROW = f"""ch.id, ch.article_id::text as article_id, {_ARTICLE}, ch.chunk_index, ch.part, ch.parts, ch.heading_path,
       ch.anchor, length(ch.content) as length, ch.model, ch.updated_at, vector_dims(ch.embedding) as dims,
       vector_norm(ch.embedding) as norm"""


class BrowseError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def table_name(table: str) -> str:
    try:
        return TABLES[table]
    except KeyError:
        raise BrowseError(f"table must be one of: {', '.join(TABLES)}") from None


def like(q: str | None) -> str | None:
    """A substring pattern for ILIKE, or None for no filter."""
    q = (q or "").strip()
    if not q:
        return None
    if len(q) > MAX_QUERY:
        raise BrowseError(f"the filter is longer than {MAX_QUERY} characters")
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def page(offset: int, limit: int) -> tuple[int, int]:
    if offset < 0:
        raise BrowseError("offset must be 0 or more")
    if not 1 <= limit <= MAX_PAGE:
        raise BrowseError(f"limit must be between 1 and {MAX_PAGE}")
    return offset, limit


def article_uuid(article_id: str | None) -> str | None:
    if not article_id:
        return None
    try:
        return str(uuid.UUID(article_id))
    except ValueError:
        raise BrowseError("article_id is not a UUID") from None


def _vector(r: dict[str, Any]) -> dict[str, Any]:
    return {"dims": int(r.pop("dims")), "norm": round(float(r.pop("norm")), 4), "head": [round(float(x), 5) for x in r.pop("head") or []]}


class ChunkBrowser:
    def __init__(self, pool: Any, index: Any) -> None:
        self.pool = pool
        self.index = index

    def _check(self) -> None:
        if self.pool is None or not getattr(self.index, "available", False):
            raise BrowseError(f"the article index is not available: {getattr(self.index, 'reason', 'no database')}", 503)

    async def _exists(self, c: Any, name: str) -> bool:
        cur = await c.execute("select to_regclass(%s::text) is not null as e", (name,))
        return bool((await cur.fetchone())["e"])

    async def _table(self, c: Any, table: str) -> str:
        name = table_name(table)
        if not await self._exists(c, name):
            raise BrowseError("no rebuild is running" if table == "rebuild" else "the article index has no table yet", 404)
        return name

    async def overview(self) -> dict[str, Any]:
        emb = getattr(self.index, "emb", None)
        out: dict[str, Any] = {
            "available": bool(self.pool is not None and getattr(self.index, "available", False)),
            "reason": getattr(self.index, "reason", "no database"),
            "pgvector": getattr(self.index, "pgvector_version", None),
            "model": getattr(emb, "name", None),
            "dimensions": getattr(emb, "dim", None),
            "rebuilding": bool(getattr(self.index, "rebuilding", False)),
            "tables": [],
        }
        if not out["available"]:
            return out
        async with self.pool.connection() as c:
            for key, name in TABLES.items():
                if not await self._exists(c, name):
                    continue
                cur = await c.execute(f"select count(*) as rows, count(distinct article_id) as articles, max(updated_at) as updated_at from {name}")  # noqa: S608 - name from TABLES
                stats = await cur.fetchone()
                cur = await c.execute(f"select model, count(*) as rows from {name} group by model order by count(*) desc, model")  # noqa: S608
                models = await cur.fetchall()
                cur = await c.execute(
                    """select format_type(a.atttypid, a.atttypmod) as vector, pg_total_relation_size(to_regclass(%(t)s::text)) as bytes,
                              (select am.amname from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
                                where i.indrelid = to_regclass(%(t)s::text) and ic.relname = %(t)s::text || '_embedding_idx') as method
                         from pg_attribute a where a.attrelid = to_regclass(%(t)s::text) and a.attname = 'embedding'""",
                    {"t": name},
                )
                shape = await cur.fetchone() or {}
                out["tables"].append({"table": key, "name": name, **stats, "models": models, "vector": shape.get("vector"), "bytes": shape.get("bytes"), "index": shape.get("method")})
        return out

    async def articles(self, table: str = "live", q: str | None = None, offset: int = 0, limit: int = 25) -> dict[str, Any]:
        self._check()
        offset, limit = page(offset, limit)
        params = {"q": like(q), "o": offset, "l": limit}
        async with self.pool.connection() as c:
            name = await self._table(c, table)
            where = "where (%(q)s::text is null or coalesce(p.title, ch.title) ilike %(q)s or p.slug ilike %(q)s)"
            cur = await c.execute(f"select count(distinct ch.article_id) as n from {name} ch left join post p on p.id = ch.article_id {where}", params)  # noqa: S608
            total = int((await cur.fetchone())["n"])
            # Grouped by the article (post.id is its key, so p's columns may be selected); min(ch.title) only names an
            # article whose post row is gone.
            cur = await c.execute(
                f"""select ch.article_id::text as article_id, coalesce(p.title, min(ch.title)) as title,
                           case when p.id is null then null else '/' || p.collection || '/' || p.slug end as path,
                           case when p.id is null then 'missing' when p.deleted_at is not null then 'deleted' else p.status end as status,
                           count(*) as chunks, max(ch.updated_at) as updated_at, array_agg(distinct ch.model order by ch.model) as models
                      from {name} ch left join post p on p.id = ch.article_id {where}
                     group by ch.article_id, p.id order by 2, 1 offset %(o)s limit %(l)s""",  # noqa: S608
                params,
            )
            rows = await cur.fetchall()
        return {"table": table, "total": total, "offset": offset, "limit": limit, "items": rows}

    async def rows(self, table: str = "live", article_id: str | None = None, q: str | None = None, offset: int = 0, limit: int = 25) -> dict[str, Any]:
        self._check()
        offset, limit = page(offset, limit)
        params = {"a": article_uuid(article_id), "q": like(q), "o": offset, "l": limit, "n": VECTOR_PREVIEW, "chars": TEXT_PREVIEW}
        async with self.pool.connection() as c:
            name = await self._table(c, table)
            where = "where (%(a)s::uuid is null or ch.article_id = %(a)s::uuid) and (%(q)s::text is null or ch.content ilike %(q)s or ch.heading_path ilike %(q)s)"
            cur = await c.execute(f"select count(*) as n from {name} ch {where}", params)  # noqa: S608
            total = int((await cur.fetchone())["n"])
            cur = await c.execute(
                f"""select {_ROW}, left(ch.content, %(chars)s) as content, (ch.embedding::real[])[1:%(n)s::int] as head
                      from {name} ch left join post p on p.id = ch.article_id {where}
                     order by coalesce(p.title, ch.title), ch.article_id, ch.chunk_index offset %(o)s limit %(l)s""",  # noqa: S608
                params,
            )
            rows = await cur.fetchall()
        return {"table": table, "total": total, "offset": offset, "limit": limit, "items": [{**r, "vector": _vector(r)} for r in rows]}

    async def row(self, chunk_id: int, table: str = "live") -> dict[str, Any]:
        self._check()
        async with self.pool.connection() as c:
            name = await self._table(c, table)
            cur = await c.execute(
                f"""select {_ROW}, ch.content, ch.content_hash, ch.embed_text, ch.identifiers, (ch.embedding::real[])[1:%(n)s::int] as head
                      from {name} ch left join post p on p.id = ch.article_id where ch.id = %(id)s""",  # noqa: S608
                {"id": chunk_id, "n": VECTOR_DETAIL},
            )
            r = await cur.fetchone()
            if r is None:
                raise BrowseError("no chunk with that id in this table", 404)
            # The nearest other chunks by the same cosine distance search uses: a quick look at what this vector is close to.
            cur = await c.execute(
                f"""select o.id, o.article_id::text as article_id, coalesce(p.title, o.title) as title,
                           case when p.id is null then null else '/' || p.collection || '/' || p.slug end as path,
                           o.chunk_index, o.heading_path, o.anchor, 1 - (o.embedding <=> s.embedding) as score
                      from {name} s join {name} o on o.id <> s.id left join post p on p.id = o.article_id
                     where s.id = %(id)s order by o.embedding <=> s.embedding limit %(k)s""",  # noqa: S608
                {"id": chunk_id, "k": SIMILAR},
            )
            similar = [{**s, "score": round(float(s["score"]), 4)} for s in await cur.fetchall()]
        return {"table": table, "chunk": {**r, "vector": _vector(r)}, "similar": similar}
