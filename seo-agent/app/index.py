"""pgvector store for article chunks (direct SQL; docs/seo/DECISIONS.md D-45 explains why not langchain-postgres).

`seo_article_chunks` is owned by this service rather than by the web app's migrations because its column type depends
on the embeddings model (vector(384) for bge-small, 768 for nomic-embed-text, …): `ensure_schema` creates it when the
`vector` extension is enabled. When the provider's dimension changes it keeps the live table and creates
`seo_article_chunks_next` with the new dimension; the next complete reindex fills it and swaps it in atomically
(build-then-swap). Until then search returns nothing (the query vectors no longer fit the live table), so Ask the Blog
answers with the fallback; a reverted provider change drops the half-built table and serves the old one again.

If the extension is not enabled, retrieval reports `available=False`: Ask the Blog answers with the fallback and the
graphs skip "related articles"; nothing else breaks. Enabling it needs a superuser once (docs/seo/MANUAL_SETUP.md).
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Any, Protocol

from psycopg import sql

from . import metrics
from .embeddings import MODEL_MAX_TOKENS, SPECIAL_TOKENS, Embeddings, chunk_markdown, embed_input, question_identifiers, token_counter
from .retrieval import Candidate, RetrievalConfig, diversify, fuse

log = logging.getLogger("seo_agent.index")

LIVE_TABLE = "seo_article_chunks"
NEXT_TABLE = "seo_article_chunks_next"  # built after an embeddings dimension change, then swapped in


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

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None, min_score: float = 0.0, rerank: bool = True) -> list[Hit]: ...
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


async def ranked_hits(fused: list[Candidate], cfg: RetrievalConfig, k: int, query: str, reranker: Any = None) -> list[Hit]:
    """The final top k: the fused order, diversified, or with the reranker switched on its order for the first
    `reranker.window(N)` of the diversified top N and the fused order after them. Shared by PgVectorIndex and the eval's
    LocalIndex, so the evaluation measures what production runs. Whatever the reranker's outcome, the hits are the
    ones the fused order would give from the same pool (it reorders, it never adds or drops a passage)."""
    if reranker is None or not reranker.enabled:
        return [to_hit(x) for x in diversify(fused, k, cfg.max_per_article)]
    pool = [to_hit(x) for x in diversify(fused, max(cfg.candidates, k), cfg.max_per_article)]
    n = reranker.window(cfg.candidates)
    head, outcome = await reranker.rerank(query, pool[:n])
    metrics.RAG_RERANK.labels(outcome).inc()
    return (head + pool[n:])[:k]


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


async def ensure_hybrid_columns(conn: Any, table: str = LIVE_TABLE) -> None:
    for ddl in HYBRID_DDL:
        await conn.execute(ddl.replace(LIVE_TABLE, table))


def _key(article_id: str, content_hash: str) -> str:
    return f"{article_id}:{content_hash}"


def _chunks_ddl(table: str, vector_type: str) -> str:
    # Constraint names spelled out, so a rebuilt table can be renamed to the live names on swap.
    return f"""create table if not exists {table} (
                 id bigserial constraint {table}_pkey primary key,
                 article_id uuid not null constraint {table}_article_id_fkey references post(id) on delete cascade,
                 chunk_index integer not null,
                 heading_path text not null default '',
                 anchor text,
                 content text not null,
                 content_hash text not null,
                 embedding {vector_type} not null,
                 model text not null,
                 updated_at timestamptz not null default now(),
                 constraint {table}_article_id_chunk_index_key unique (article_id, chunk_index))"""


# Rebuilt table → live names (the old table's own objects are dropped with it, so the names are free).
_SWAP_RENAMES = (
    f"alter table {NEXT_TABLE} rename to {LIVE_TABLE}",
    f"alter table {LIVE_TABLE} rename constraint {NEXT_TABLE}_pkey to {LIVE_TABLE}_pkey",
    f"alter table {LIVE_TABLE} rename constraint {NEXT_TABLE}_article_id_fkey to {LIVE_TABLE}_article_id_fkey",
    f"alter table {LIVE_TABLE} rename constraint {NEXT_TABLE}_article_id_chunk_index_key to {LIVE_TABLE}_article_id_chunk_index_key",
    f"alter sequence if exists {NEXT_TABLE}_id_seq rename to {LIVE_TABLE}_id_seq",
    f"alter index if exists {NEXT_TABLE}_embedding_idx rename to {LIVE_TABLE}_embedding_idx",
    f"alter index if exists {NEXT_TABLE}_tsv_idx rename to {LIVE_TABLE}_tsv_idx",
    f"alter index if exists {NEXT_TABLE}_identifiers_idx rename to {LIVE_TABLE}_identifiers_idx",
)

INSERT_CHUNK = """insert into {table} (article_id, chunk_index, heading_path, anchor, content, content_hash, embedding, model, updated_at,
       title, part, parts, embed_text, identifiers)
     values (%s, %s, %s, %s, %s, %s, %s::vector, %s, now(), %s, %s, %s, %s, %s)
     on conflict (article_id, chunk_index) do update set heading_path = excluded.heading_path, anchor = excluded.anchor,
       content = excluded.content, content_hash = excluded.content_hash, embedding = excluded.embedding,
       model = excluded.model, updated_at = now(), title = excluded.title, part = excluded.part, parts = excluded.parts,
       embed_text = excluded.embed_text, identifiers = excluded.identifiers"""


def _version_tuple(v: str | None) -> tuple[int, int]:
    try:
        major, minor = (int(x) for x in (v or "0.0").split(".")[:2])
        return major, minor
    except ValueError:
        return (0, 0)


def search_settings(pgvector_version: str | None, n: int) -> list[tuple[str, str]]:
    """Transaction-local pgvector settings for one search. HNSW (pgvector ≥ 0.5) returns at most ef_search rows
    before the `published` / `exclude_article` filters run, so ef_search follows the candidate count (2×, ≥ 40, ≤ 1000);
    pgvector ≥ 0.8 also keeps scanning (iterative_scan = relaxed_order) when the filters drop rows. Nothing for
    IVFFlat-era versions."""
    v = _version_tuple(pgvector_version)
    out: list[tuple[str, str]] = []
    if v >= (0, 5):
        out.append(("hnsw.ef_search", str(min(1000, max(40, n * 2)))))
    if v >= (0, 8):
        out.append(("hnsw.iterative_scan", "relaxed_order"))
    return out


class PgVectorIndex:
    def __init__(self, pool: Any, embeddings: Embeddings, config: RetrievalConfig | None = None, reranker: Any = None):
        self.pool = pool
        self.emb = embeddings
        self.config = config or RetrievalConfig.from_env()
        self.counter = token_counter(embeddings)
        self.reranker = reranker  # app/reranker.py RerankGate: reads its switch on every search
        self.available = False
        self.reason = "not checked"
        self.pgvector_version: str | None = None
        self._version_cache: tuple[float, str] | None = None
        # Build-then-swap after an embeddings dimension change: reindex writes NEXT_TABLE, the next complete
        # (non-`only`) reindex swaps it in. Until then search returns nothing (query vectors no longer fit the live table).
        self.rebuilding = False

    @property
    def write_table(self) -> str:
        return NEXT_TABLE if self.rebuilding else LIVE_TABLE

    async def _vector_type(self, c: Any, table: str) -> str | None:
        cur = await c.execute(
            "select format_type(a.atttypid, a.atttypmod) as t from pg_attribute a where a.attrelid = to_regclass(%s) and a.attname = 'embedding'",
            (table,),
        )
        row = await cur.fetchone()
        return row["t"] if row else None

    async def ensure_schema(self) -> bool:
        async with self.pool.connection() as c:
            cur = await c.execute("select extversion from pg_extension where extname = 'vector'")
            row = await cur.fetchone()
            if not row:
                self.available, self.reason = False, "pgvector extension is not enabled in this database (MANUAL_SETUP.md)"
                return False
            self.pgvector_version = row["extversion"]
            want = f"vector({self.emb.dim})"
            existing = await self._vector_type(c, LIVE_TABLE)
            self.rebuilding = bool(existing and existing != want)
            if self.rebuilding:
                # Never drop the live table here: a failed or reverted provider change keeps it. Ask the Blog answers
                # with the fallback until the full reindex below has filled the new table and swapped it in.
                log.warning(
                    "embeddings dimension changed (%s → %s): building %s; run a full reindex to swap it in (Ask the Blog falls back until then)",
                    existing,
                    want,
                    NEXT_TABLE,
                )
                if (await self._vector_type(c, NEXT_TABLE)) not in (None, want):
                    await c.execute(f"drop table {NEXT_TABLE}")  # a half-built table for yet another dimension
            else:
                await c.execute(f"drop table if exists {NEXT_TABLE}")  # a rebuild abandoned by switching back
            table = self.write_table
            await c.execute(_chunks_ddl(table, want))
            method = "hnsw" if _version_tuple(self.pgvector_version) >= (0, 5) else "ivfflat"
            await c.execute(f"create index if not exists {table}_embedding_idx on {table} using {method} (embedding vector_cosine_ops)")
            await ensure_hybrid_columns(c, table)
        self.available, self.reason = True, "ok" if not self.rebuilding else "rebuilding for a new embeddings dimension"
        return True

    async def _swap(self, c: Any) -> None:
        """The rebuilt table replaces the live one in one transaction: readers see the old table or the new, never none."""
        async with c.transaction():
            await c.execute(f"drop table {LIVE_TABLE}")
            for ddl in _SWAP_RENAMES:
                await c.execute(ddl)
            # Every other constraint still named after the build table, e.g. PostgreSQL 18's named NOT NULL
            # constraints (seo_article_chunks_next_<col>_not_null), so a later rebuild starts from clean names.
            cur = await c.execute(
                "select conname from pg_constraint where conrelid = to_regclass(%s) and starts_with(conname, %s)",
                (LIVE_TABLE, f"{NEXT_TABLE}_"),
            )
            for r in await cur.fetchall():
                old = r["conname"]
                new = LIVE_TABLE + old[len(NEXT_TABLE) :]
                await c.execute(sql.SQL("alter table {} rename constraint {} to {}").format(sql.Identifier(LIVE_TABLE), sql.Identifier(old), sql.Identifier(new)))
        self.rebuilding = False
        self.reason = "ok"
        log.warning("embeddings rebuild complete: %s swapped in", LIVE_TABLE)

    async def reindex(self, articles: list[dict[str, Any]], *, full: bool = False, only: set[str] | None = None, force: bool = False) -> dict[str, int]:
        """Incremental: only chunks whose content_hash (or model) changed are embedded, and a changed chunk whose text
        already exists elsewhere in the same article (a paragraph inserted above shifts every later chunk_index)
        reuses that stored vector. `articles` = every published article (id, title, body); chunks of articles no
        longer in the list are removed (unpublished/deleted). `force` skips the safety guard below, after a human has
        checked that the article list is right. During a rebuild (dimension change) it writes the new table, and a
        complete run swaps it in."""
        if not self.available:
            return {"articles": 0, "embedded": 0, "unchanged": 0, "deleted": 0}
        stats = {"articles": 0, "embedded": 0, "unchanged": 0, "deleted": 0, "reused": 0}
        live = {a["id"] for a in articles}
        table = self.write_table
        async with self.pool.connection() as c:
            if only is None:
                if not force:
                    # Guard: an empty or truncated article list (web app error, bad deploy) must not wipe the index.
                    # Counted on the live table, also during a rebuild (the new table starts empty).
                    cur = await c.execute(f"select count(distinct article_id) as n from {LIVE_TABLE}")  # noqa: S608 - constant table names
                    indexed = int((await cur.fetchone())["n"])
                    if refuse_reindex(len(live), indexed):
                        raise IndexSafetyError(f"refusing reindex: {len(live)} published articles vs {indexed} indexed; check the list, then rerun with force=true")
                # Unpublished/deleted articles' chunks go on every full or weekly run; `force` skips only the guard.
                cur = await c.execute(f"delete from {table} where not (article_id::text = any(%s)) returning 1", (list(live),))  # noqa: S608
                stats["deleted"] += len(await cur.fetchall())
            for a in articles:
                if only is not None and a["id"] not in only:
                    continue
                stats["articles"] += 1
                chunks = chunk_markdown(str(a.get("body", "")), str(a.get("title", "")), self.counter)
                cur = await c.execute(f"select chunk_index, content_hash, model from {table} where article_id = %s", (a["id"],))  # noqa: S608
                have = {r["chunk_index"]: (r["content_hash"], r["model"]) for r in await cur.fetchall()}
                title = str(a.get("title", ""))
                hashes = {ch.index: _embed_hash(title, ch.content_hash) for ch in chunks}
                todo = [ch for ch in chunks if full or have.get(ch.index) != (hashes[ch.index], self.emb.name)]
                stats["unchanged"] += len(chunks) - len(todo)
                if todo:
                    vec_of: dict[int, str] = {}
                    stored = {h for h, m in have.values() if m == self.emb.name}
                    if not full and any(hashes[ch.index] in stored for ch in todo):
                        # Same text (same stored hash, same model) at another chunk_index: reuse its vector.
                        cur = await c.execute(
                            f"select distinct on (content_hash) content_hash, embedding::text as e from {table} where article_id = %s and model = %s and content_hash = any(%s)",  # noqa: S608
                            (a["id"], self.emb.name, list({hashes[ch.index] for ch in todo})),
                        )
                        by_hash = {r["content_hash"]: r["e"] for r in await cur.fetchall()}
                        vec_of = {ch.index: by_hash[hashes[ch.index]] for ch in todo if hashes[ch.index] in by_hash}
                    fresh = [ch for ch in todo if ch.index not in vec_of]
                    if fresh:
                        # Title + heading path are embedded with the text: they carry most of the topical signal.
                        inputs = [embed_input(title, ch) for ch in fresh]
                        observe_chunk_tokens(self.counter, fresh, inputs)
                        for ch, v in zip(fresh, await self.emb.embed(inputs), strict=True):
                            vec_of[ch.index] = _vec(v)
                    rows = [(a["id"], ch.index, ch.heading_path, ch.anchor, ch.content, hashes[ch.index], vec_of[ch.index], self.emb.name, title, ch.part, ch.parts, ch.embed_text, ch.identifiers) for ch in todo]
                    async with c.transaction(), c.cursor() as wc:  # one round trip per article, all or nothing
                        await wc.executemany(INSERT_CHUNK.format(table=table), rows)
                    stats["embedded"] += len(fresh)
                    stats["reused"] += len(todo) - len(fresh)
                    metrics.REINDEX_CHUNKS.inc(len(fresh))
                    metrics.REINDEX_REUSED.inc(len(todo) - len(fresh))
                cur = await c.execute(f"delete from {table} where article_id = %s and chunk_index >= %s returning 1", (a["id"], len(chunks)))  # noqa: S608
                stats["deleted"] += len(await cur.fetchall())
            if self.rebuilding and only is None:
                await self._swap(c)
                stats["swapped"] = 1
        self._version_cache = None
        return stats

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None, min_score: float = 0.0, rerank: bool = True) -> list[Hit]:
        """Hybrid (or vector) retrieval: candidate lists from Postgres, fusion in app/retrieval.py. `min_score` is a
        cosine pre-filter on every candidate (Ask the Blog's ASK_BLOG_MIN_SCORE). `rerank=False` for callers that
        want the nearest passages by cosine, not the best answers (the news desk's duplicate check)."""
        if not self.available or self.rebuilding or not query.strip():
            return []
        cfg = self.config
        [v] = await self.emb.embed([query], query=True)
        qids = question_identifiers(query) if cfg.mode == "hybrid" else []
        async with self.pool.connection() as c:
            # The pool is autocommit: a transaction scopes the set_config(..., is_local => true) calls to this search.
            async with c.transaction():
                for name, value in search_settings(self.pgvector_version, cfg.candidates):
                    await c.execute("select set_config(%s, %s, true)", (name, value))
                cands = await self.candidates(c, query, _vec(v), qids, cfg.candidates, exclude_article)
        fused = fuse(cands, replace_cfg(cfg, min_score))
        return await ranked_hits(fused, cfg, k, query, self.reranker if rerank else None)

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

    async def search(self, query: str, k: int = 6, *, exclude_article: str | None = None, min_score: float = 0.0, rerank: bool = True) -> list[Hit]:
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
