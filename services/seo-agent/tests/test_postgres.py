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
create table post (id uuid primary key, collection text not null, slug text not null, title text not null, status text not null, deleted_at timestamptz);
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
  outcome text not null, citations jsonb not null default '[]', cached boolean not null default false, cost_usd double precision not null default 0, index_version text);
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
