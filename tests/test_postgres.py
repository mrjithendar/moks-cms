"""Tests against a real PostgreSQL with pgvector: seo_flow_runs (one active run per flow + target), CrewAI's Postgres
persistence, session advisory locks across connections, the orphan sweep, a full flow run, the pgvector index
(schema, incremental reindex, retrieval cites the right article) and the usage/ask tables.

Database: SEO_AGENT_TEST_DATABASE_URL (CI: the pgvector/pgvector:pg18 service container), else testcontainers when a
Docker daemon is available, else the module is skipped. Each test gets a fresh schema.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import pytest

pytestmark = pytest.mark.postgres

# Minimal copies of the web app tables these tests touch (the real DDL is services/www/src/db/migrations/0012, 0016).
DDL = """
create extension if not exists vector;
create table post (id uuid primary key, collection text not null, slug text not null, title text not null, status text not null, deleted_at timestamptz, category text not null default '');
create table seo_drafts (id uuid primary key);
create table seo_llm_usage (id uuid primary key default gen_random_uuid(), at timestamptz not null default now(), provider text not null, model text not null,
  purpose text not null, prompt_version text not null, mode text not null default 'sync', request_id text, input_tokens int not null default 0,
  output_tokens int not null default 0, cache_read_tokens int not null default 0, cache_write_tokens int not null default 0,
  cost_usd double precision not null default 0, latency_ms int, outcome text not null, error_code text, draft_id uuid references seo_drafts(id) on delete set null);
create table seo_llm_batches (id text primary key, status text not null default 'in_progress', estimated_cost_usd double precision not null default 0);
create table seo_flow_runs (run_id uuid primary key, flow_name text not null, target_id text not null, draft_id uuid,
  status text not null check (status in ('queued','running','succeeded','failed','cancelled','paused_budget')), current_step text, state_json jsonb,
  inputs jsonb not null default '{}', outputs jsonb, error text, tokens integer not null default 0, cost_usd double precision not null default 0,
  started_at timestamptz not null default now(), finished_at timestamptz, updated_at timestamptz not null default now(),
  triggered_by text not null check (triggered_by in ('cron','manual','approval','flow','mcp')), correlation_id text, actor text);
create unique index seo_flow_runs_one_active on seo_flow_runs (flow_name, target_id) where status in ('queued','running');
create table seo_ask_log (id bigserial primary key, at timestamptz not null default now(), question text not null, normalized text not null, ip_hash text,
  outcome text not null, citations jsonb not null default '[]', cached boolean not null default false, cost_usd double precision not null default 0, index_version text,
  retrieval jsonb, prompt_version text);
create table seo_ask_gaps (id bigserial primary key, normalized text not null unique, sample_question text not null, asked int not null default 1,
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(), status text not null default 'open');
"""


def _url() -> str | None:
    if os.environ.get("SEO_AGENT_TEST_DATABASE_URL"):
        return os.environ["SEO_AGENT_TEST_DATABASE_URL"]
    try:
        from testcontainers.postgres import PostgresContainer
    except ImportError:
        return None
    try:
        c = PostgresContainer("pgvector/pgvector:0.8.1-pg18", driver=None)
        c.start()
    except Exception:
        return None
    os.environ["SEO_AGENT_TEST_DATABASE_URL"] = c.get_connection_url()
    return c.get_connection_url()


@pytest.fixture
async def pool() -> AsyncIterator[object]:
    url = _url()
    if not url:
        pytest.skip("no PostgreSQL with pgvector (set SEO_AGENT_TEST_DATABASE_URL or run a Docker daemon)")
    import psycopg
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    schema = f"t_{uuid.uuid4().hex[:10]}"
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as c:
        try:
            await c.execute("create extension if not exists vector")
        except psycopg.Error:  # no pgvector on this server: the flow/run tests still run, the vector ones skip
            os.environ["SEO_AGENT_TEST_NO_VECTOR"] = "1"
        await c.execute(f"create schema {schema}")
    p = AsyncConnectionPool(url, min_size=1, max_size=4, open=False, kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None, "options": f"-c search_path={schema},public"})
    await p.open(wait=True)
    async with p.connection() as c:
        for stmt in DDL.split(";"):
            if stmt.strip() and "create extension" not in stmt:
                await c.execute(stmt)
    yield p
    await p.close()
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as c:
        await c.execute(f"drop schema {schema} cascade")


async def test_flow_runs_one_active_per_target_persistence_and_sweep(pool) -> None:
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    from app.runs import PgFlowPersistence, PgRunStore, RunConflict
    from app.state import OptimizeState

    store = PgRunStore(pool)
    rid = str(uuid.uuid4())
    row = {"run_id": rid, "flow_name": "gsc_sync_flow", "target_id": "site", "status": "queued", "inputs": {}, "triggered_by": "cron"}
    await store.create(row)
    with pytest.raises(RunConflict) as e:
        await store.create({**row, "run_id": str(uuid.uuid4())})
    assert str(e.value.existing["run_id"]) == rid
    # CrewAI's persistence (sync pool) writes the typed state per step
    search_path = pool.kwargs["options"]
    sync = ConnectionPool(_url(), min_size=1, max_size=1, kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None, "options": search_path})
    try:
        pers = PgFlowPersistence().bind(sync)
        pers.save_state(rid, "run_job", OptimizeState(id=rid, cost_usd=0.25, tokens=900, outcome="done"))
        assert pers.load_state(rid)["outcome"] == "done"
    finally:
        sync.close()
    got = await store.get(rid)
    assert got["current_step"] == "run_job" and got["tokens"] == 900 and float(got["cost_usd"]) == 0.25
    swept = await store.sweep_orphans()
    assert [str(r["run_id"]) for r in swept] == [rid] and (await store.get(rid))["status"] == "failed"
    await store.create({**row, "run_id": str(uuid.uuid4())})  # the slot is free again


async def test_advisory_locks_exclude_across_connections(pool) -> None:
    from app.runs import PgAdvisoryLocks

    locks = PgAdvisoryLocks(_url())
    a = await locks.acquire(f"optimize_article_flow:{uuid.uuid4()}:x")
    assert a is not None
    key = f"report_flow:{uuid.uuid4()}"
    h1 = await locks.acquire(key)
    assert h1 is not None and await locks.acquire(key) is None  # a second session cannot take it
    await locks.release(h1)
    h2 = await locks.acquire(key)  # closing the session released it
    assert h2 is not None
    await locks.release(h2)
    await locks.release(a)


async def test_a_flow_runs_on_postgres_end_to_end(pool) -> None:
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    from app.flows import SPECS, check_kickoff
    from app.flows.base import Deps
    from app.llm import BudgetGuard, FakeLlm, MemorySpendStore
    from app.runs import FlowRunner, PgAdvisoryLocks, PgFlowPersistence, PgRunStore
    from tests.conftest import FakeWebApp, settings

    sync = ConnectionPool(_url(), min_size=1, max_size=1, kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None, "options": pool.kwargs["options"]})
    try:
        web = FakeWebApp()
        store = PgRunStore(pool)
        deps = Deps(settings=settings(), llm=FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1)), web=web, retriever=None, store=store)
        runner = FlowRunner(SPECS, store, PgAdvisoryLocks(_url()), lambda: PgFlowPersistence().bind(sync), deps, policy=check_kickoff)
        r = await runner.kickoff("tech_audit_flow", {}, triggered_by="cron")
        done = await runner.wait(r["run_id"], 30)
        assert done["status"] == "succeeded" and done["current_step"] == "record_stats" and done["state_json"]["result"]["rows"] == 42
        assert web.jobs[0][0] == "technical_scan"
    finally:
        sync.close()


async def test_pgvector_index_reindexes_incrementally_and_retrieves_the_right_article(pool) -> None:
    if os.environ.get("SEO_AGENT_TEST_NO_VECTOR"):
        pytest.skip("pgvector is not installed on this PostgreSQL (CI runs pgvector/pgvector:0.8.1-pg18)")
    from app.embeddings import HashEmbeddings
    from app.index import PgVectorIndex

    a1, a2 = str(uuid.uuid4()), str(uuid.uuid4())
    async with pool.connection() as c:
        await c.execute("insert into post values (%s, 'blog', 'ingress-tls', 'Ingress and TLS on Kubernetes', 'published', null), (%s, 'blog', 'terraform-state', 'Terraform state on S3', 'published', null)", (a1, a2))
    idx = PgVectorIndex(pool, HashEmbeddings())
    assert await idx.ensure_schema() is True and idx.pgvector_version
    arts = [
        {"id": a1, "title": "Ingress and TLS on Kubernetes", "body": "## cert-manager issuers\n\ncert-manager renews certificates thirty days before expiry using a ClusterIssuer.\n\n## Ingress controller\n\nThe ingress controller terminates TLS."},
        {"id": a2, "title": "Terraform state on S3", "body": "## Locking\n\nUse DynamoDB or S3 native locking for terraform state."},
    ]
    s1 = await idx.reindex(arts)
    assert s1["embedded"] == 3 and s1["unchanged"] == 0
    s2 = await idx.reindex(arts)
    assert s2["embedded"] == 0 and s2["unchanged"] == 3  # nothing changed → nothing re-embedded
    arts[0]["body"] = arts[0]["body"].replace("terminates TLS.", "terminates TLS and redirects HTTP.")
    s3 = await idx.reindex(arts)
    assert s3["embedded"] == 1 and s3["unchanged"] == 2  # only the changed chunk
    hits = await idx.search("how does cert-manager renew certificates before expiry", k=2)
    assert hits[0].path == "/blog/ingress-tls" and hits[0].url == "/blog/ingress-tls#cert-manager-issuers"
    v1 = await idx.version()
    await idx.reindex(arts[:1])  # the S3 article was unpublished
    idx._version_cache = None
    assert await idx.version() != v1
    assert all(h.path != "/blog/terraform-state" for h in await idx.search("terraform state locking dynamodb", k=5))


async def test_lancedb_copy_of_the_index_has_every_published_chunk(pool, tmp_path) -> None:
    """D-93: app/lance_index.py's query against the real schema, written to an embedded LanceDB."""
    if os.environ.get("SEO_AGENT_TEST_NO_VECTOR"):
        pytest.skip("pgvector is not installed on this PostgreSQL (CI runs pgvector/pgvector:0.8.1-pg18)")
    from app.embeddings import HashEmbeddings
    from app.index import PgVectorIndex
    from app.lance_admin import LanceAdmin
    from app.lance_index import TABLE, ArticleMirror, fetch_from

    a1, a2 = str(uuid.uuid4()), str(uuid.uuid4())
    async with pool.connection() as c:
        await c.execute("insert into post values (%s, 'blog', 'ingress-tls', 'Ingress and TLS', 'published', null, 'kubernetes'), (%s, 'blog', 'draft', 'A draft', 'draft', null, '')", (a1, a2))
    idx = PgVectorIndex(pool, HashEmbeddings())
    await idx.ensure_schema()
    await idx.reindex([{"id": a1, "title": "Ingress and TLS", "body": "## Issuers\n\ncert-manager renews.\n\n## Controller\n\nIt terminates TLS."}, {"id": a2, "title": "A draft", "body": "Not yet."}], force=True)
    admin = LanceAdmin(str(tmp_path))
    out = await ArticleMirror(admin, fetch_from(pool)).sync()
    assert out["synced"] and out["rows"] == 2 and out["articles"] == 1  # the draft's chunk is not copied
    rows = admin._conn().open_table(TABLE).to_arrow().to_pylist()
    assert {r["id"] for r in rows} == {f"{a1}:0", f"{a1}:1"}
    assert rows[0]["path"] == "/blog/ingress-tls" and rows[0]["category"] == "kubernetes" and len(rows[0]["vector"]) == HashEmbeddings().dim


async def test_reindex_refuses_an_empty_article_list_unless_forced(pool) -> None:
    if os.environ.get("SEO_AGENT_TEST_NO_VECTOR"):
        pytest.skip("pgvector is not installed on this PostgreSQL (CI runs pgvector/pgvector:0.8.1-pg18)")
    from app.embeddings import HashEmbeddings
    from app.index import IndexSafetyError, PgVectorIndex

    a1 = str(uuid.uuid4())
    async with pool.connection() as c:
        await c.execute("insert into post values (%s, 'blog', 'ingress-tls', 'Ingress and TLS on Kubernetes', 'published', null, 'kubernetes')", (a1,))
    idx = PgVectorIndex(pool, HashEmbeddings())
    assert await idx.ensure_schema() is True
    art = {"id": a1, "title": "Ingress and TLS on Kubernetes", "body": "## cert-manager\n\ncert-manager renews certificates."}
    await idx.reindex([art])
    with pytest.raises(IndexSafetyError):
        await idx.reindex([])  # the web app returned nothing: keep the index
    assert (await idx.reindex([art], only={a1}))["unchanged"] == 1  # a single-article reindex never runs the guard
    [hit] = await idx.search("cert-manager renews certificates", k=1)
    assert hit.category == "kubernetes"
    assert (await idx.reindex([], force=True))["deleted"] == 1  # reviewed by a person: really empty


async def test_index_reports_unavailable_without_the_extension(pool) -> None:
    from app.embeddings import HashEmbeddings
    from app.index import PgVectorIndex

    class NoVectorPool:
        def __init__(self, inner):
            self.inner = inner

        def connection(self):
            inner = self.inner

            class Ctx:
                async def __aenter__(self_inner):
                    self_inner.c = await inner.connection().__aenter__()
                    return self_inner

                async def __aexit__(self_inner, *a):
                    return None

                async def execute(self_inner, q, *a):
                    if "pg_extension" in q:
                        q = "select 1 where false"
                    return await self_inner.c.execute(q, *a)

            return Ctx()

    idx = PgVectorIndex(NoVectorPool(pool), HashEmbeddings())
    assert await idx.ensure_schema() is False and "MANUAL_SETUP" in idx.reason
    assert await idx.search("anything") == []


async def test_ask_log_records_without_ip_and_gaps_count_up(pool) -> None:
    from app.ask import PgAskLog

    log = PgAskLog(pool)
    row = {"question": "volcano gpu?", "normalized": "volcano gpu", "ip_hash": None, "outcome": "fallback", "citations": [], "cached": False, "cost_usd": 0.0, "index_version": "v"}
    await log.record(row)
    await log.record(row)
    async with pool.connection() as c:
        g = await (await c.execute("select asked from seo_ask_gaps where normalized = 'volcano gpu'")).fetchone()
        cols = [r["column_name"] for r in await (await c.execute("select column_name from information_schema.columns where table_name = 'seo_ask_log'")).fetchall()]
    assert g["asked"] == 2 and "ip" not in cols


# --- v5: hybrid retrieval ---------------------------------------------------------------------------------------------


def _need_vector() -> None:
    if os.environ.get("SEO_AGENT_TEST_NO_VECTOR"):
        pytest.skip("pgvector is not installed on this PostgreSQL (CI runs pgvector/pgvector:0.8.1-pg18)")


async def test_hybrid_search_uses_full_text_and_exact_identifiers(pool) -> None:
    _need_vector()
    from app.embeddings import HashEmbeddings
    from app.index import PgVectorIndex
    from app.retrieval import RetrievalConfig

    ids = [str(uuid.uuid4()) for _ in range(3)]
    async with pool.connection() as c:
        await c.execute(
            "insert into post values (%s, 'blog', 'rollouts', 'Kubernetes rollouts', 'published', null, 'kubernetes'), (%s, 'blog', 'helm', 'Helm releases', 'published', null, 'kubernetes'), (%s, 'blog', 'long', 'A long article', 'published', null, 'kubernetes')",
            ids,
        )
    idx = PgVectorIndex(pool, HashEmbeddings(), RetrievalConfig(mode="hybrid", max_per_article=2))
    assert await idx.ensure_schema() is True
    long_body = "\n\n".join(f"## Section {i}\n\nDeployments and rollouts of services, part {i}." for i in range(8))
    arts = [
        {"id": ids[0], "title": "Kubernetes rollouts", "body": "## Going back\n\nRun `kubectl rollout undo deploy/web` to return to the previous ReplicaSet.\n\n## Watching\n\nWatch progress."},
        {"id": ids[1], "title": "Helm releases", "body": "## Rollback\n\nUse `helm rollback web 3` when a release fails."},
        {"id": ids[2], "title": "A long article", "body": long_body},
    ]
    await idx.reindex(arts)
    async with pool.connection() as c:
        row = await (await c.execute("select title, identifiers, tsv is not null as has_tsv from seo_article_chunks where anchor = 'going-back'")).fetchone()
    assert row["title"] == "Kubernetes rollouts" and "kubectl rollout" in row["identifiers"] and row["has_tsv"]
    hits = await idx.search("kubectl rollout undo", k=3)
    assert hits[0].url == "/blog/rollouts#going-back" and hits[0].ranks["ids"] >= 1 and hits[0].ranks["text"] is not None
    assert 0 <= hits[0].score <= 1  # Hit.score stays cosine in hybrid mode
    many = await idx.search("deployments and rollouts of services", k=6)
    assert sum(1 for h in many if h.path == "/blog/long") <= 2  # diversification
    assert await idx.search("the and of", k=3) is not None  # stop-word-only question: no text list, no error
    floor = await idx.search("kubectl rollout undo", k=3, min_score=0.99)
    assert all(h.score >= 0.99 for h in floor)


async def test_tsvector_columns_are_added_to_an_existing_v4_table(pool) -> None:
    _need_vector()
    from app.embeddings import HashEmbeddings
    from app.index import PgVectorIndex

    a1 = str(uuid.uuid4())
    async with pool.connection() as c:
        await c.execute("insert into post values (%s, 'blog', 'old', 'Old article', 'published', null, '')", (a1,))
        # exactly the v4 table, with one row embedded by v4
        await c.execute(
            """create table seo_article_chunks (id bigserial primary key, article_id uuid not null references post(id) on delete cascade, chunk_index integer not null,
                 heading_path text not null default '', anchor text, content text not null, content_hash text not null, embedding vector(384) not null,
                 model text not null, updated_at timestamptz not null default now(), unique (article_id, chunk_index))"""
        )
        await c.execute("insert into seo_article_chunks (article_id, chunk_index, heading_path, anchor, content, content_hash, embedding, model) values (%s, 0, 'Intro', 'intro', 'Valkey sentinel failover', 'v4hash', %s::vector, 'hash:384')", (a1, "[" + ",".join(["0"] * 383 + ["1"]) + "]"))
    idx = PgVectorIndex(pool, HashEmbeddings())
    assert await idx.ensure_schema() and await idx.ensure_schema()  # idempotent
    async with pool.connection() as c:
        r = await (await c.execute("select content, title, part, parts, identifiers, tsv @@ plainto_tsquery('english', 'sentinel failover') as m from seo_article_chunks")).fetchone()
        n = await (await c.execute("select count(*) as n from pg_indexes where tablename = 'seo_article_chunks' and indexname in ('seo_article_chunks_tsv_idx', 'seo_article_chunks_identifiers_idx')")).fetchone()
    assert r["content"] == "Valkey sentinel failover" and r["m"] is True and (r["part"], r["parts"], r["identifiers"], r["title"]) == (0, 1, [], "")
    assert n["n"] == 2
    # the next reindex re-embeds the old row once (the chunker version is part of the stored hash)
    s = await idx.reindex([{"id": a1, "title": "Old article", "body": "## Intro\n\nValkey sentinel failover"}])
    assert s["embedded"] == 1


async def test_rag_eval_smoke_on_postgres(pool) -> None:
    """The evaluation harness against the production index code (PgVectorIndex, hybrid) on the real articles."""
    _need_vector()
    from app.embeddings import HashEmbeddings
    from app.index import PgVectorIndex
    from app.rag_eval import evaluate, load_articles, load_eval_set
    from app.retrieval import RetrievalConfig
    from tests.test_rag_v5 import BLOG

    arts = load_articles(BLOG)
    async with pool.connection() as c:
        for a in arts:
            await c.execute("insert into post values (%s, 'blog', %s, %s, 'published', null, %s)", (a["id"], a["slug"], a["title"], a["category"]))
    idx = PgVectorIndex(pool, HashEmbeddings(), RetrievalConfig(mode="hybrid"))
    assert await idx.ensure_schema()
    stats = await idx.reindex(arts)
    assert stats["articles"] == len(arts) and stats["embedded"] > 500
    res = await evaluate("pg-smoke", lambda q, k: idx.search(q, k), load_eval_set())
    assert res.n >= 40 and res.metrics["recall@6"] > 0.3  # hashed embeddings + Postgres full text: it runs and finds things


# --- v5: the ML store against the real migration 0019 ------------------------------------------------------------------

MIGRATION_0019 = __import__("pathlib").Path(__file__).resolve().parents[2] / "www" / "src" / "db" / "migrations" / "0019_seo_v5_ml.sql"


async def test_ml_store_roundtrip_on_migration_0019(pool) -> None:
    from datetime import date

    from app.seo_ml import train as tr
    from app.seo_ml.store import PgMlStore

    async with pool.connection() as c:
        await c.execute("create table seo_query_intents (query text primary key, intent text not null, source text not null, model text, classified_at timestamptz not null default now())")
        await c.execute("create table seo_query_clusters (query text primary key, cluster_id integer not null, parent_topic text not null, computed_at timestamptz not null default now())")
        await c.execute("create table seo_gsc_daily_totals (date date, search_type text, clicks bigint, impressions bigint, ctr float8, position float8)")
        await c.execute("create table seo_gsc_page_daily (date date, page text, search_type text, device text, country text, clicks bigint, impressions bigint, ctr float8, position float8)")
        await c.execute("create table setting (key text primary key, value jsonb not null)")
        for stmt in MIGRATION_0019.read_text().split("--> statement-breakpoint"):
            if stmt.strip():
                await c.execute(stmt)
        await c.execute("insert into seo_query_intents (query, intent, source, prompt_version) values ('helm vs kustomize', 'comparison', 'llm', 'seo-intent-v1'), ('old', 'informational', 'llm', 'seo-intent-v0')")
        await c.execute("insert into seo_gsc_daily_totals values ('2026-11-08', 'web', 1, 1, 1, 1)")
        await c.execute("insert into seo_gsc_page_daily values ('2026-11-08', '/a', 'web', 'mobile', 'ind', 3, 30, 0.1, 5), ('2026-11-08', '/a', 'web', 'desktop', 'ind', 2, 20, 0.1, 5)")
        await c.execute("""insert into setting values ('seo', '{"weights": {"effort": 9}}')""")
    s = PgMlStore(pool)
    assert await s.latest_gsc_date() == date(2026, 11, 8)
    assert (await s.page_daily(date(2026, 11, 1)))[0]["clicks"] == 5  # devices summed
    assert (await s.current_weights())["effort"] == 9
    # registry: activation, deactivation, one active per kind
    r1 = await tr.register(s, "decay", n=3, model_metrics={"a": 1}, rule_metrics={}, beats=True)
    assert r1["active"] and (await s.active_model("decay"))["version"] == "v1"
    r2 = await tr.register(s, "decay", n=3, model_metrics={}, rule_metrics={}, beats=False)
    assert r2["run_status"] == "fallback_to_rule" and await s.active_model("decay") is None and (await s.latest_model("decay"))["version"] == "v2"
    # outputs, embeddings cache, labels, training data with the owner's correction winning
    await s.replace_outputs("seo_ml_query_clusters", [{"query": "q", "cluster_id": 1, "cluster_label": "q", "model_version": "v1"}])
    await s.replace_outputs("seo_ml_query_clusters", [{"query": "r", "cluster_id": 2, "cluster_label": "r", "model_version": "v2"}])
    async with pool.connection() as c:
        assert [r["query"] for r in await (await c.execute("select query from seo_ml_query_clusters")).fetchall()] == ["r"]
    await s.replace_outputs("seo_ml_decay_signals", [{"page": "/a", "window_start": "2026-01-01", "window_end": "2026-11-08", "decaying": True, "trend_slope": -1.0, "drop_pct": 0.3, "confidence": 0.8, "method_version": "stl-v1", "evidence": {"dates": ["2026-11-08"]}}])
    await s.save_embeddings({"q": [0.1, 0.2]}, "m")
    assert (await s.cached_embeddings(["q", "x"], "m")) == {"q": [pytest.approx(0.1), pytest.approx(0.2)]}
    assert await s.add_label_tasks("intent_check", [("helm vs kustomize", {"haiku": "comparison"})]) == 1
    assert await s.add_label_tasks("intent_check", [("helm vs kustomize", {"haiku": "comparison"})]) == 0
    async with pool.connection() as c:
        await c.execute("""update seo_ml_labels set status = 'changed', label = '{"intent": "informational"}'""")
    assert await s.intent_training("seo-intent-v1") == [("helm vs kustomize", "informational")]
    await s.add_proposal({"model_version": "v1", "weights": {"effort": 1}, "current_weights": {}, "metrics": {}, "n_outcomes": 50})
    await s.add_proposal({"model_version": "v2", "weights": {"effort": 2}, "current_weights": {}, "metrics": {}, "n_outcomes": 51})
    async with pool.connection() as c:
        st = [r["status"] for r in await (await c.execute("select status from seo_ml_weight_proposals order by created_at, model_version")).fetchall()]
    assert sorted(st) == ["proposed", "superseded"]
    await s.record_rag_eval("live", {"recall@3": 0.9})
    assert await s.related_scores("00000000-0000-4000-8000-000000000001") == {}
    assert await s.ga4_pairs() == []
