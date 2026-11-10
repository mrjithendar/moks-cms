"""pgvector store for article chunks (direct SQL; docs/seo/DECISIONS.md D-45 explains why not langchain-postgres).

`seo_article_chunks` is owned by this service rather than by the web app's migrations because its column type depends
on the embeddings model (vector(384) for bge-small, 768 for nomic-embed-text, …): `ensure_schema` creates it when the
`vector` extension is enabled, and recreates it (derived data only) when the provider's dimension changes.

If the extension is not enabled, retrieval reports `available=False`: Ask the Blog answers with the fallback and the
graphs skip "related articles"; nothing else breaks. Enabling it needs a superuser once (docs/seo/MANUAL_SETUP.md).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol

from . import metrics
from .embeddings import Embeddings, chunk_markdown


@dataclass
class Hit:
    article_id: str
    title: str
    path: str
    heading_path: str
    anchor: str | None
    content: str
    score: float

    @property
    def url(self) -> str:
        return f"{self.path}#{self.anchor}" if self.anchor else self.path


class Retriever(Protocol):
    available: bool

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None) -> list[Hit]: ...
    async def similar_articles(self, article_id: str, k: int = 8) -> list[tuple[str, str, float]]: ...
    async def version(self) -> str: ...


def _vec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


class PgVectorIndex:
    def __init__(self, pool: Any, embeddings: Embeddings):
        self.pool = pool
        self.emb = embeddings
        self.available = False
        self.reason = "not checked"
        self.pgvector_version: str | None = None
        self._version_cache: tuple[float, str] | None = None

    async def ensure_schema(self) -> bool:
        async with self.pool.connection() as c:
            cur = await c.execute("select extversion from pg_extension where extname = 'vector'")
            row = await cur.fetchone()
            if not row:
                self.available, self.reason = False, "pgvector extension is not enabled in this database (MANUAL_SETUP.md)"
                return False
            self.pgvector_version = row["extversion"]
            cur = await c.execute(
                """select format_type(a.atttypid, a.atttypmod) as t from pg_attribute a
                   where a.attrelid = to_regclass('seo_article_chunks') and a.attname = 'embedding'"""
            )
            existing = await cur.fetchone()
            want = f"vector({self.emb.dim})"
            if existing and existing["t"] != want:
                await c.execute("drop table seo_article_chunks")  # derived data; rebuilt by the full reindex below
            await c.execute(
                f"""create table if not exists seo_article_chunks (
                      id bigserial primary key,
                      article_id uuid not null references post(id) on delete cascade,
                      chunk_index integer not null,
                      heading_path text not null default '',
                      anchor text,
                      content text not null,
                      content_hash text not null,
                      embedding {want} not null,
                      model text not null,
                      updated_at timestamptz not null default now(),
                      unique (article_id, chunk_index))"""
            )
            major, minor = (int(x) for x in self.pgvector_version.split(".")[:2])
            method = "hnsw" if (major, minor) >= (0, 5) else "ivfflat"
            await c.execute(f"create index if not exists seo_article_chunks_embedding_idx on seo_article_chunks using {method} (embedding vector_cosine_ops)")
        self.available, self.reason = True, "ok"
        return True

    async def reindex(self, articles: list[dict[str, Any]], *, full: bool = False, only: set[str] | None = None) -> dict[str, int]:
        """Incremental: only chunks whose content_hash (or model) changed are embedded. `articles` = every published
        article (id, title, body); chunks of articles no longer in the list are removed (unpublished/deleted)."""
        if not self.available:
            return {"articles": 0, "embedded": 0, "unchanged": 0, "deleted": 0}
        stats = {"articles": 0, "embedded": 0, "unchanged": 0, "deleted": 0}
        live = {a["id"] for a in articles}
        async with self.pool.connection() as c:
            if only is None:
                cur = await c.execute("delete from seo_article_chunks where not (article_id::text = any(%s)) returning 1", (list(live),))
                stats["deleted"] += len(await cur.fetchall())
            for a in articles:
                if only is not None and a["id"] not in only:
                    continue
                stats["articles"] += 1
                chunks = chunk_markdown(str(a.get("body", "")), str(a.get("title", "")))
                cur = await c.execute("select chunk_index, content_hash, model from seo_article_chunks where article_id = %s", (a["id"],))
                have = {r["chunk_index"]: (r["content_hash"], r["model"]) for r in await cur.fetchall()}
                todo = [ch for ch in chunks if full or have.get(ch.index) != (ch.content_hash, self.emb.name)]
                stats["unchanged"] += len(chunks) - len(todo)
                if todo:
                    # Title + heading path are embedded with the text: they carry most of the topical signal.
                    vecs = await self.emb.embed([f"{a.get('title', '')}\n{ch.heading_path}\n\n{ch.content}" for ch in todo])
                    for ch, v in zip(todo, vecs, strict=True):
                        await c.execute(
                            """insert into seo_article_chunks (article_id, chunk_index, heading_path, anchor, content, content_hash, embedding, model, updated_at)
                               values (%s, %s, %s, %s, %s, %s, %s::vector, %s, now())
                               on conflict (article_id, chunk_index) do update set heading_path = excluded.heading_path, anchor = excluded.anchor,
                                 content = excluded.content, content_hash = excluded.content_hash, embedding = excluded.embedding,
                                 model = excluded.model, updated_at = now()""",
                            (a["id"], ch.index, ch.heading_path, ch.anchor, ch.content, ch.content_hash, _vec(v), self.emb.name),
                        )
                    stats["embedded"] += len(todo)
                    metrics.REINDEX_CHUNKS.inc(len(todo))
                cur = await c.execute("delete from seo_article_chunks where article_id = %s and chunk_index >= %s returning 1", (a["id"], len(chunks)))
                stats["deleted"] += len(await cur.fetchall())
        self._version_cache = None
        return stats

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None) -> list[Hit]:
        if not self.available or not query.strip():
            return []
        [v] = await self.emb.embed([query], query=True)
        async with self.pool.connection() as c:
            cur = await c.execute(
                """select ch.article_id::text as article_id, p.title, '/' || p.collection || '/' || p.slug as path, ch.heading_path, ch.anchor,
                          ch.content, 1 - (ch.embedding <=> %s::vector) as score
                   from seo_article_chunks ch join post p on p.id = ch.article_id
                   where p.status = 'published' and p.deleted_at is null and (%s::text is null or ch.article_id::text <> %s)
                   order by ch.embedding <=> %s::vector limit %s""",
                (_vec(v), exclude_article, exclude_article, _vec(v), k),
            )
            return [Hit(r["article_id"], r["title"], r["path"], r["heading_path"], r["anchor"], r["content"], float(r["score"])) for r in await cur.fetchall()]

    async def similar_articles(self, article_id: str, k: int = 8) -> list[tuple[str, str, float]]:
        """Article-level similarity: mean chunk embedding of the source vs every other article's chunks (best match)."""
        if not self.available:
            return []
        async with self.pool.connection() as c:
            cur = await c.execute(
                """with src as (select avg(embedding) as e from seo_article_chunks where article_id = %s)
                   select p.id::text as id, '/' || p.collection || '/' || p.slug as path, max(1 - (ch.embedding <=> src.e)) as score
                   from seo_article_chunks ch join post p on p.id = ch.article_id, src
                   where ch.article_id <> %s and p.status = 'published' and p.deleted_at is null and src.e is not null
                   group by p.id, p.collection, p.slug order by score desc limit %s""",
                (article_id, article_id, k),
            )
            return [(r["id"], r["path"], float(r["score"])) for r in await cur.fetchall()]

    async def version(self) -> str:
        """Changes whenever any chunk changes: part of the Ask-the-Blog cache key."""
        if self._version_cache and time.monotonic() - self._version_cache[0] < 30:
            return self._version_cache[1]
        if not self.available:
            return "none"
        async with self.pool.connection() as c:
            cur = await c.execute("select count(*) as n, coalesce(extract(epoch from max(updated_at)), 0)::bigint as t from seo_article_chunks")
            r = await cur.fetchone()
        v = f"{self.emb.name}:{r['n']}:{r['t']}"
        self._version_cache = (time.monotonic(), v)
        return v


class MemoryRetriever:
    """In-memory retriever over fixture hits (graph unit tests)."""

    def __init__(self, hits: list[Hit] | None = None, available: bool = True):
        self.hits = hits or []
        self.available = available
        self.queries: list[str] = []

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None) -> list[Hit]:
        self.queries.append(query)
        words = {w for w in query.lower().split() if len(w) > 2}
        scored = []
        for h in self.hits:
            if h.article_id == exclude_article:
                continue
            text = f"{h.title} {h.heading_path} {h.content}".lower()
            s = sum(1 for w in words if w in text) / max(1, len(words))
            scored.append(Hit(**{**h.__dict__, "score": s}))
        return sorted(scored, key=lambda h: -h.score)[:k]

    async def similar_articles(self, article_id: str, k: int = 8) -> list[tuple[str, str, float]]:
        seen: dict[str, tuple[str, str, float]] = {}
        for h in self.hits:
            if h.article_id != article_id and h.article_id not in seen:
                seen[h.article_id] = (h.article_id, h.path, h.score)
        return list(seen.values())[:k]

    async def version(self) -> str:
        return f"mem:{len(self.hits)}"
