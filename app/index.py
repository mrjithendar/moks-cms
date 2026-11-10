"""pgvector store for article chunks (direct SQL; docs/seo/DECISIONS.md D-45 explains why not langchain-postgres).

`seo_article_chunks` is owned by this service rather than by the web app's migrations because its column type depends
on the embeddings model (vector(384) for bge-small, 768 for nomic-embed-text, …): `ensure_schema` creates it when the
`vector` extension is enabled, and recreates it (derived data only) when the provider's dimension changes.

If the extension is not enabled, retrieval reports `available=False`: Ask the Blog answers with the fallback and the
graphs skip "related articles"; nothing else breaks. Enabling it needs a superuser once (docs/seo/MANUAL_SETUP.md).
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any, Protocol

from . import metrics
from .embeddings import MODEL_MAX_TOKENS, SPECIAL_TOKENS, Embeddings, chunk_markdown, embed_input, question_identifiers, token_counter
from .retrieval import Candidate, RetrievalConfig, diversify, fuse


@dataclass
class Hit:
    article_id: str
    title: str
    path: str
    heading_path: str
    anchor: str | None
    content: str
    score: float  # cosine similarity of the chunk, in every mode
    category: str = ""
    fused: float = 0.0  # hybrid ranking score (RRF + identifier boost); = score in vector mode
    ranks: dict[str, Any] | None = None  # {"vector": r, "text": r, "ids": n}: why it ranked (eval, debugging)

    @property
    def url(self) -> str:
        return f"{self.path}#{self.anchor}" if self.anchor else self.path


class Retriever(Protocol):
    available: bool

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None, min_score: float = 0.0) -> list[Hit]: ...
    async def similar_articles(self, article_id: str, k: int = 8) -> list[tuple[str, str, float]]: ...
    async def version(self) -> str: ...


def _embed_hash(title: str, chunk_hash: str) -> str:
    """The stored hash covers everything that is embedded: the title is part of the embedded text, so renaming an
    article must re-embed its chunks (Chunk.content_hash alone covers heading path + text)."""
    return hashlib.sha256(f"{title}\n{chunk_hash}".encode()).hexdigest()


class IndexSafetyError(RuntimeError):
    """Refused a reindex that would delete most of the index (e.g. the web app returned no articles)."""


# Below this many indexed articles the "half" rule is skipped: on a small site, unpublishing two of four articles is
# ordinary editing, not a truncated list. An empty list is always refused.
GUARD_MIN_INDEXED = 10


def refuse_reindex(live: int, indexed: int) -> bool:
    """True when a full/weekly reindex would most likely delete the index by mistake."""
    if not indexed:
        return False
    return live == 0 or (indexed >= GUARD_MIN_INDEXED and live < indexed * 0.5)


def _vec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


# One row shape for every candidate list. `id_matches` counts exact identifiers shared with the question.
CHUNK_SELECT = """select ch.id, ch.article_id::text as article_id, p.title, '/' || p.collection || '/' || p.slug as path, ch.heading_path, ch.anchor,
         ch.content, ch.content_hash, 1 - (ch.embedding <=> %(v)s::vector) as vscore, p.category,
         cardinality(array(select unnest(ch.identifiers) intersect select unnest(%(ids)s::text[]))) as id_matches
       from seo_article_chunks ch join post p on p.id = ch.article_id
       where p.status = 'published' and p.deleted_at is null and (%(ex)s::text is null or ch.article_id::text <> %(ex)s)"""


def _cand(r: dict[str, Any], vector_rank: int | None = None, text_rank: int | None = None) -> Candidate:
    # Windows of one code block share `content` (the whole block): de-duplicate on the article + content.
    key = _key(r["article_id"], hashlib.sha256(str(r["content"]).encode()).hexdigest()[:16])
    return Candidate(key, r["article_id"], r["title"], r["path"], r["heading_path"], r["anchor"], r["content"], float(r["vscore"]), r["category"] or "", vector_rank, text_rank, int(r["id_matches"] or 0))


def to_hit(c: Candidate) -> Hit:
    return Hit(c.article_id, c.title, c.path, c.heading_path, c.anchor, c.content, round(c.vector_score, 6), c.category, round(c.fused, 6), {"vector": c.vector_rank, "text": c.text_rank, "ids": c.id_matches})


def replace_cfg(cfg: RetrievalConfig, min_score: float) -> RetrievalConfig:
    from dataclasses import replace

    return replace(cfg, min_vector_score=max(cfg.min_vector_score, min_score))


def observe_chunk_tokens(counter: Any, chunks: list[Any], inputs: list[str]) -> None:
    """seo_rag_chunk_tokens (embedded input length) and seo_rag_chunks_truncated_total (inputs the model would cut at
    512 tokens: must stay 0; only possible with the ≈ chars/4 counter on unusual text)."""
    for _ch, text in zip(chunks, inputs, strict=True):
        n = counter.count(text)
        metrics.RAG_CHUNK_TOKENS.observe(n)
        if n + SPECIAL_TOKENS > MODEL_MAX_TOKENS:
            metrics.RAG_CHUNKS_TRUNCATED.inc()


# v5 hybrid retrieval: additive and idempotent (this service owns the table). On an existing table the generated column
# is computed for every row when it is added (one table rewrite; ~1–2k rows here). Old rows get title '' and no
# identifiers until the next reindex, which re-embeds every chunk once anyway (CHUNKER_VERSION is in the stored hash).
HYBRID_DDL = (
    "alter table seo_article_chunks add column if not exists title text not null default ''",
    "alter table seo_article_chunks add column if not exists part integer not null default 0",
    "alter table seo_article_chunks add column if not exists parts integer not null default 1",
    "alter table seo_article_chunks add column if not exists embed_text text",
    "alter table seo_article_chunks add column if not exists identifiers text[] not null default '{}'",
    """alter table seo_article_chunks add column if not exists tsv tsvector generated always as (
         setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A')
         || setweight(to_tsvector('english'::regconfig, coalesce(heading_path, '')), 'B')
         || to_tsvector('english'::regconfig, coalesce(content, ''))) stored""",
    "create index if not exists seo_article_chunks_tsv_idx on seo_article_chunks using gin (tsv)",
    "create index if not exists seo_article_chunks_identifiers_idx on seo_article_chunks using gin (identifiers)",
)

# Full-text candidates: the question's lexemes OR-ed (plainto_tsquery ANDs them, which almost never matches a whole
# natural-language question), ranked by ts_rank with length normalisation. Shared by PgVectorIndex and the evaluation.
TEXT_QUERY_CTE = "with tq as (select nullif(replace(plainto_tsquery('english'::regconfig, %(q)s)::text, ' & ', ' | '), '')::tsquery as q)"


async def ensure_hybrid_columns(conn: Any) -> None:
    for ddl in HYBRID_DDL:
        await conn.execute(ddl)


def _key(article_id: str, content_hash: str) -> str:
    return f"{article_id}:{content_hash}"


class PgVectorIndex:
    def __init__(self, pool: Any, embeddings: Embeddings, config: RetrievalConfig | None = None):
        self.pool = pool
        self.emb = embeddings
        self.config = config or RetrievalConfig.from_env()
        self.counter = token_counter(embeddings)
        self.reranker: Any = None
        if self.config.reranker_dir:
            from .reranker import CrossEncoderReranker

            self.reranker = CrossEncoderReranker(self.config.reranker_dir)
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
            await ensure_hybrid_columns(c)
        self.available, self.reason = True, "ok"
        return True

    async def reindex(self, articles: list[dict[str, Any]], *, full: bool = False, only: set[str] | None = None, force: bool = False) -> dict[str, int]:
        """Incremental: only chunks whose content_hash (or model) changed are embedded. `articles` = every published
        article (id, title, body); chunks of articles no longer in the list are removed (unpublished/deleted).
        `force` skips the safety guard below, after a human has checked that the article list is right."""
        if not self.available:
            return {"articles": 0, "embedded": 0, "unchanged": 0, "deleted": 0}
        stats = {"articles": 0, "embedded": 0, "unchanged": 0, "deleted": 0}
        live = {a["id"] for a in articles}
        async with self.pool.connection() as c:
            if only is None:
                if not force:
                    # Guard: an empty or truncated article list (web app error, bad deploy) must not wipe the index.
                    cur = await c.execute("select count(distinct article_id) as n from seo_article_chunks")
                    indexed = int((await cur.fetchone())["n"])
                    if refuse_reindex(len(live), indexed):
                        raise IndexSafetyError(f"refusing reindex: {len(live)} published articles vs {indexed} indexed; check the list, then rerun with force=true")
                # Unpublished/deleted articles' chunks go on every full or weekly run; `force` skips only the guard.
                cur = await c.execute("delete from seo_article_chunks where not (article_id::text = any(%s)) returning 1", (list(live),))
                stats["deleted"] += len(await cur.fetchall())
            for a in articles:
                if only is not None and a["id"] not in only:
                    continue
                stats["articles"] += 1
                chunks = chunk_markdown(str(a.get("body", "")), str(a.get("title", "")), self.counter)
                cur = await c.execute("select chunk_index, content_hash, model from seo_article_chunks where article_id = %s", (a["id"],))
                have = {r["chunk_index"]: (r["content_hash"], r["model"]) for r in await cur.fetchall()}
                title = str(a.get("title", ""))
                hashes = {ch.index: _embed_hash(title, ch.content_hash) for ch in chunks}
                todo = [ch for ch in chunks if full or have.get(ch.index) != (hashes[ch.index], self.emb.name)]
                stats["unchanged"] += len(chunks) - len(todo)
                if todo:
                    # Title + heading path are embedded with the text: they carry most of the topical signal.
                    inputs = [embed_input(title, ch) for ch in todo]
                    observe_chunk_tokens(self.counter, todo, inputs)
                    vecs = await self.emb.embed(inputs)
                    for ch, v in zip(todo, vecs, strict=True):
                        await c.execute(
                            """insert into seo_article_chunks (article_id, chunk_index, heading_path, anchor, content, content_hash, embedding, model, updated_at,
                                 title, part, parts, embed_text, identifiers)
                               values (%s, %s, %s, %s, %s, %s, %s::vector, %s, now(), %s, %s, %s, %s, %s)
                               on conflict (article_id, chunk_index) do update set heading_path = excluded.heading_path, anchor = excluded.anchor,
                                 content = excluded.content, content_hash = excluded.content_hash, embedding = excluded.embedding,
                                 model = excluded.model, updated_at = now(), title = excluded.title, part = excluded.part, parts = excluded.parts,
                                 embed_text = excluded.embed_text, identifiers = excluded.identifiers""",
                            (a["id"], ch.index, ch.heading_path, ch.anchor, ch.content, hashes[ch.index], _vec(v), self.emb.name, title, ch.part, ch.parts, ch.embed_text, ch.identifiers),
                        )
                    stats["embedded"] += len(todo)
                    metrics.REINDEX_CHUNKS.inc(len(todo))
                cur = await c.execute("delete from seo_article_chunks where article_id = %s and chunk_index >= %s returning 1", (a["id"], len(chunks)))
                stats["deleted"] += len(await cur.fetchall())
        self._version_cache = None
        return stats

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None, min_score: float = 0.0) -> list[Hit]:
        """Hybrid (or vector) retrieval: candidate lists from Postgres, fusion in app/retrieval.py. `min_score` is a
        cosine pre-filter on every candidate (Ask the Blog's ASK_BLOG_MIN_SCORE)."""
        if not self.available or not query.strip():
            return []
        cfg = self.config
        [v] = await self.emb.embed([query], query=True)
        qids = question_identifiers(query) if cfg.mode == "hybrid" else []
        async with self.pool.connection() as c:
            cands = await self.candidates(c, query, _vec(v), qids, cfg.candidates, exclude_article)
        fused = fuse(cands, replace_cfg(cfg, min_score))
        if self.reranker is not None:
            top = [to_hit(x) for x in diversify(fused, cfg.candidates, cfg.max_per_article)]
            return list(await self.reranker.rerank(query, top, k))
        return [to_hit(x) for x in diversify(fused, k, cfg.max_per_article)]

    async def candidates(self, c: Any, query: str, qvec: str, qids: list[str], n: int, exclude_article: str | None) -> list[Candidate]:
        """vector top-N (+ full-text top-N and exact-identifier matches in hybrid mode), each with its cosine."""
        params = {"v": qvec, "n": n, "ex": exclude_article, "q": query, "ids": qids}
        out: list[Candidate] = []
        rows = await (await c.execute(f"{CHUNK_SELECT} order by ch.embedding <=> %(v)s::vector limit %(n)s", params)).fetchall()
        out.extend(_cand(r, vector_rank=i) for i, r in enumerate(rows, start=1))
        if self.config.mode == "hybrid":
            rows = await (
                await c.execute(
                    f"""{TEXT_QUERY_CTE} {CHUNK_SELECT.replace("from seo_article_chunks ch", "from tq, seo_article_chunks ch")}
                          and tq.q is not null and ch.tsv @@ tq.q order by ts_rank(ch.tsv, tq.q, 1) desc, ch.id limit %(n)s""",
                    params,
                )
            ).fetchall()
            out.extend(_cand(r, text_rank=i) for i, r in enumerate(rows, start=1))
            if qids:
                rows = await (
                    await c.execute(
                        f"""{CHUNK_SELECT} and ch.identifiers && %(ids)s::text[]
                              order by cardinality(array(select unnest(ch.identifiers) intersect select unnest(%(ids)s::text[]))) desc, ch.id limit %(n)s""",
                        params,
                    )
                ).fetchall()
                out.extend(_cand(r) for r in rows)
        return out

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

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None, min_score: float = 0.0) -> list[Hit]:
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
