"""Admin-editable settings (app/admin_settings): the registry, precedence (admin value, then the environment, then
the code default), live and restart fields, sealed secrets, and GET /admin-settings + PUT /admin-settings/{group}."""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.admin_settings import (
    GROUPS,
    TABLE,
    MemorySettingsStore,
    PgSettingsStore,
    SettingsInvalid,
    Stored,
    UnknownGroup,
    apply_live,
    effective,
    overview,
    save_group,
    secrets,
)
from app.admin_settings.groups import agent_limits
from app.admin_settings.registry import NEVER, Field, Group, Invalid, check_registry, clean, never, to_env
from app.admin_settings.store import overlay, plan_save
from app.config import Settings, load_settings

KEY = {"SEO_AGENT_SETTINGS_KEY": "k" * 40}
SECRET_GROUP = Group("test-secrets", "Test secrets", "", (Field("EMBEDDINGS_API_KEY", "embeddings_api_key", "Embeddings key", "", "secret", apply="restart"),))


def rows(**values: Any) -> dict[str, Stored]:
    return {k: Stored(v, "admin") for k, v in values.items()}


def by_env(view: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {f["env"]: f for g in view["groups"] for f in g["fields"]}


# --- Registry ---------------------------------------------------------------------------------------------------------


def test_every_registered_field_feeds_a_settings_attribute_and_none_is_a_bootstrap_value() -> None:
    attrs = set(Settings.__dataclass_fields__)
    seen: set[str] = set()
    for g in GROUPS:
        for f in g.fields:
            assert f.attr in attrs, f.env
            assert not never(f.env), f.env
            assert f.label and f.hint and f.env not in seen
            seen.add(f.env)
    assert {"DATABASE_URL", "SEO_AGENT_TOKEN", "SEO_AGENT_CALLBACK_TOKEN", "SEO_AGENT_SETTINGS_KEY", "SITE_URL"} <= set(NEVER)
    assert never("OTEL_EXPORTER_OTLP_ENDPOINT") and never("OTEL_SERVICE_NAME")


@pytest.mark.parametrize("env", ["DATABASE_URL", "SEO_AGENT_TOKEN", "SEO_AGENT_SETTINGS_KEY", "OTEL_SERVICE_NAME", "SITE_URL"])
def test_a_bootstrap_value_cannot_be_registered(env: str) -> None:
    with pytest.raises(ValueError, match="must stay in the deployment"):
        check_registry([Group("g1", "G", "", (Field(env, "site_url", "L", "H", "text"),))])


def test_a_registry_with_a_duplicate_or_a_bad_name_is_refused() -> None:
    f = Field("CREW_MAX_ITER", "crew_max_iter", "L", "H", "integer")
    with pytest.raises(ValueError, match="registered twice"):
        check_registry([Group("g1", "G", "", (f,)), Group("g2", "G", "", (f,))])
    with pytest.raises(ValueError, match="used twice"):
        check_registry([Group("g1", "G", ""), Group("g1", "G", "")])
    with pytest.raises(ValueError, match="without options"):
        check_registry([Group("g1", "G", "", (Field("SOME_CHOICE", "site_url", "L", "H", "select"),))])


def test_the_agent_limits_group_has_the_ten_fields_and_only_copied_values_need_a_restart() -> None:
    fields = {f.env: f for f in agent_limits.GROUP.fields}
    assert set(fields) == {
        "CREW_MAX_ITER", "CREW_MAX_RPM", "CREW_MAX_TOKENS_PER_RUN", "CREW_TIMEOUT_SECONDS", "SEO_FLOW_TIMEOUT_SECONDS", "SEO_LLM_TIMEOUT_SECONDS",
        "SEO_AGENT_FANOUT_CONCURRENCY", "SEO_AGENT_WEEKLY_MAX_ARTICLES", "SCHEDULE_CATCHUP_MINUTES", "SEO_AGENT_DOCS_ALLOWLIST",
    }  # fmt: skip
    # The flow runner and the model client copy their limit when they are built (app/main.py build_container).
    assert {e for e, f in fields.items() if f.apply == "restart"} == {"SEO_FLOW_TIMEOUT_SECONDS", "SEO_LLM_TIMEOUT_SECONDS"}


def test_values_are_checked_by_type_and_range() -> None:
    n = Field("CREW_MAX_ITER", "crew_max_iter", "L", "H", "integer", min=1, max=20)
    assert clean(n, 7) == 7 and clean(n, 7.0) == 7
    for bad in (0, 21, 2.5, True, "7", None, float("nan")):
        with pytest.raises(Invalid):
            clean(n, bad)
    hosts = next(f for f in agent_limits.GROUP.fields if f.type == "list")
    assert clean(hosts, [" kubernetes.io ", "kubernetes.io", "docs.aws.amazon.com", ""]) == ["kubernetes.io", "docs.aws.amazon.com"]
    for bad in (["https://kubernetes.io"], ["a,b.io"], ["localhost"], "kubernetes.io", [1]):
        with pytest.raises(Invalid):
            clean(hosts, bad)
    b = Field("ASK_BLOG_ENABLED", "ask_enabled", "L", "H", "boolean")
    assert clean(b, False) is False and to_env(b, False) == "false" and to_env(b, True) == "true"
    with pytest.raises(Invalid):
        clean(b, "true")
    assert to_env(hosts, ["a.io", "b.io"]) == "a.io,b.io"


# --- Precedence -------------------------------------------------------------------------------------------------------


def test_the_admin_value_wins_over_the_environment_which_wins_over_the_default() -> None:
    assert effective({}, {}).crew_max_iter == Settings.crew_max_iter
    assert effective({}, {"CREW_MAX_ITER": "9"}).crew_max_iter == 9
    assert effective(rows(CREW_MAX_ITER=12), {"CREW_MAX_ITER": "9"}).crew_max_iter == 12
    # Nothing saved changes nothing: every default and every clamp is config.py's.
    assert effective({}, {"SEO_LLM_TIMEOUT_SECONDS": "5"}) == load_settings({"SEO_LLM_TIMEOUT_SECONDS": "5"})


def test_a_saved_value_that_no_longer_fits_its_field_is_skipped_not_applied(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="seo-agent.admin-settings"):
        s = effective(rows(CREW_MAX_ITER=500, CREW_MAX_RPM="fast", UNKNOWN_SETTING=1), {"CREW_MAX_ITER": "6"})
    assert s.crew_max_iter == 6 and s.crew_max_rpm == Settings.crew_max_rpm
    assert sum("not usable" in r.message for r in caplog.records) == 2


def test_live_fields_change_on_the_shared_settings_object_and_restart_fields_wait() -> None:
    running = load_settings({})
    held_by_a_crew = running  # crews and flows keep a reference, not a copy
    changed = apply_live(running, rows(CREW_MAX_ITER=8, SEO_FLOW_TIMEOUT_SECONDS=900, SEO_AGENT_DOCS_ALLOWLIST=["kubernetes.io"]), {})
    assert sorted(changed) == ["CREW_MAX_ITER", "SEO_AGENT_DOCS_ALLOWLIST"]
    assert held_by_a_crew.crew_max_iter == 8 and held_by_a_crew.docs_allowlist == ("kubernetes.io",)
    assert running.flow_timeout_s == Settings.flow_timeout_s
    assert apply_live(running, {}, {}) and running.crew_max_iter == Settings.crew_max_iter  # cleared: back to the default
    assert apply_live(running, {}, {}) == []


def test_the_overview_names_the_source_and_reports_restart_pending() -> None:
    running = load_settings({"CREW_MAX_RPM": "30"})
    stored = rows(CREW_MAX_ITER=8, SEO_FLOW_TIMEOUT_SECONDS=900)
    apply_live(running, stored, {"CREW_MAX_RPM": "30"})
    view = overview(stored, running, {"CREW_MAX_RPM": "30"})
    f = by_env(view)
    assert (f["CREW_MAX_ITER"]["source"], f["CREW_MAX_ITER"]["value"], f["CREW_MAX_ITER"]["default"], f["CREW_MAX_ITER"]["deployment"]) == (
        "admin",
        8,
        Settings.crew_max_iter,
        None,
    )
    assert (f["CREW_MAX_RPM"]["source"], f["CREW_MAX_RPM"]["value"], f["CREW_MAX_RPM"]["deployment"]) == ("deployment", 30, 30)
    assert (f["CREW_TIMEOUT_SECONDS"]["source"], f["CREW_TIMEOUT_SECONDS"]["value"]) == ("default", Settings.crew_timeout_s)
    assert f["SEO_FLOW_TIMEOUT_SECONDS"]["restart_pending"] and f["SEO_FLOW_TIMEOUT_SECONDS"]["value"] == 900
    assert not f["CREW_MAX_ITER"]["restart_pending"] and view["restart_pending"] and view["groups"][0]["restart_pending"]
    assert isinstance(f["SEO_AGENT_DOCS_ALLOWLIST"]["value"], list) and f["CREW_MAX_ITER"]["updated_by"] == "admin"
    # After the restart the running value is the saved one.
    assert not overview(stored, effective(stored, {}), {})["restart_pending"]
    json.dumps(view)


# --- Saving -----------------------------------------------------------------------------------------------------------


async def test_a_save_is_all_or_nothing() -> None:
    store, running = MemorySettingsStore(), load_settings({})
    with pytest.raises(SettingsInvalid) as e:
        await save_group(store, running, "agent-limits", {"CREW_MAX_RPM": 5, "CREW_MAX_ITER": 99, "DATABASE_URL": "postgres://x"}, "admin", env={})
    assert e.value.issues == ["Turns per agent: at most 20", "DATABASE_URL: not a setting of Agent limits"]
    assert await store.load() == {} and running.crew_max_rpm == Settings.crew_max_rpm
    for bad in (None, [], "CREW_MAX_ITER=3"):
        with pytest.raises(SettingsInvalid):
            await save_group(store, running, "agent-limits", bad, "admin", env={})
    with pytest.raises(UnknownGroup):
        await save_group(store, running, "nope", {}, "admin", env={})


async def test_a_save_applies_live_fields_at_once_and_clearing_returns_to_the_deployment_value() -> None:
    env = {"CREW_MAX_ITER": "6"}
    store, running = MemorySettingsStore(), load_settings(env)
    view = await save_group(store, running, "agent-limits", {"CREW_MAX_ITER": 9, "SEO_LLM_TIMEOUT_SECONDS": 300}, " admin@example.com ", env=env)
    assert running.crew_max_iter == 9 and running.llm_timeout_s == Settings.llm_timeout_s
    assert by_env(view)["SEO_LLM_TIMEOUT_SECONDS"]["restart_pending"]
    assert (await store.load())["CREW_MAX_ITER"] == Stored(9, "admin@example.com", None)
    # A field that is not sent stays; null, "" and [] clear.
    view = await save_group(store, running, "agent-limits", {"CREW_MAX_ITER": None, "SEO_AGENT_DOCS_ALLOWLIST": []}, "admin", env=env)
    assert running.crew_max_iter == 6 and by_env(view)["CREW_MAX_ITER"]["source"] == "deployment"
    assert set(await store.load()) == {"SEO_LLM_TIMEOUT_SECONDS"}


# --- Secrets ----------------------------------------------------------------------------------------------------------


def test_a_secret_round_trips_in_the_web_apps_stored_shape_and_another_key_cannot_read_it() -> None:
    sealed = secrets.seal("sk-live-123", KEY)
    assert set(sealed) == {"v", "iv", "tag", "data"} and sealed["v"] == 1 and "sk-live" not in json.dumps(sealed)
    assert secrets.unseal(sealed, KEY) == "sk-live-123"
    assert secrets.seal("sk-live-123", KEY)["iv"] != sealed["iv"]
    with pytest.raises(secrets.Unreadable):
        secrets.unseal(sealed, {"SEO_AGENT_SETTINGS_KEY": "z" * 40})
    with pytest.raises(secrets.Unreadable):
        secrets.unseal({**sealed, "data": sealed["data"][:-4] + "AAAA"}, KEY)
    with pytest.raises(secrets.Unreadable):
        secrets.unseal("sk-live-123", KEY)


def test_a_value_sealed_by_node_with_the_same_scheme_is_readable() -> None:
    """AES-256-GCM, key = SHA-256 of the key text, 12-byte IV, tag stored apart: moks-cms src/lib/secrets.ts seal().
    Produced once with Node's crypto for the key "n" × 40 and the fixed IV below."""
    import base64
    import hashlib

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key, iv = hashlib.sha256(b"n" * 40).digest(), bytes(range(12))
    out = AESGCM(key).encrypt(iv, b"hello", None)
    node_shape = {"v": 1, "iv": base64.b64encode(iv).decode(), "tag": base64.b64encode(out[-16:]).decode(), "data": base64.b64encode(out[:-16]).decode()}
    assert secrets.unseal(node_shape, {"SEO_AGENT_SETTINGS_KEY": "n" * 40}) == "hello"


def test_without_the_key_a_secret_cannot_be_saved_and_says_what_to_do() -> None:
    assert not secrets.available({}) and not secrets.available({"SEO_AGENT_SETTINGS_KEY": "short"}) and secrets.available(KEY)
    with pytest.raises(SettingsInvalid) as e:
        plan_save(SECRET_GROUP, {"EMBEDDINGS_API_KEY": "sk-live-123"}, {})
    assert e.value.issues == ["Embeddings key: Requires manual configuration: set SEO_AGENT_SETTINGS_KEY in the seo-agent's Secret and restart it"]
    keep, clear = plan_save(SECRET_GROUP, {"EMBEDDINGS_API_KEY": " sk-live-123 "}, KEY)
    assert clear == [] and secrets.unseal(keep["EMBEDDINGS_API_KEY"], KEY) == "sk-live-123"
    assert plan_save(SECRET_GROUP, {"EMBEDDINGS_API_KEY": ""}, {}) == ({}, ["EMBEDDINGS_API_KEY"])  # clearing needs no key


def test_a_secret_is_never_in_the_overview_and_an_unreadable_one_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.admin_settings import store as store_module

    monkeypatch.setattr(store_module, "GROUPS", [*GROUPS, SECRET_GROUP])
    stored = {"EMBEDDINGS_API_KEY": Stored(secrets.seal("sk-live-123", KEY), "admin")}
    assert overlay(KEY, stored)["EMBEDDINGS_API_KEY"] == "sk-live-123"
    assert effective(stored, KEY).embeddings_api_key == "sk-live-123"
    other = {"SEO_AGENT_SETTINGS_KEY": "z" * 40, "EMBEDDINGS_API_KEY": "from-the-deployment"}
    assert effective(stored, other).embeddings_api_key == "from-the-deployment"
    view = overview(stored, effective(stored, KEY), KEY)
    f = by_env(view)["EMBEDDINGS_API_KEY"]
    assert f["set"] is True and f["editable"] is True and "value" not in f and "default" not in f and "deployment" not in f
    assert "sk-live-123" not in json.dumps(view) and view["secrets_key_set"] is True
    assert by_env(overview(stored, effective(stored, {}), {}))["EMBEDDINGS_API_KEY"]["editable"] is False


async def test_a_save_logs_names_never_values(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    from app.admin_settings import store as store_module

    monkeypatch.setattr(store_module, "GROUPS", [*GROUPS, SECRET_GROUP])
    with caplog.at_level(logging.INFO, logger="seo-agent.admin-settings"):
        await save_group(MemorySettingsStore(), load_settings({}), "test-secrets", {"EMBEDDINGS_API_KEY": "sk-live-123"}, "admin", env=KEY)
    rec = next(r for r in caplog.records if getattr(r, "event", "") == "admin_settings_saved")
    assert rec.saved == ["EMBEDDINGS_API_KEY"] and "sk-live-123" not in json.dumps({k: str(v) for k, v in rec.__dict__.items()})


# --- The API ----------------------------------------------------------------------------------------------------------

AUTH = {"Authorization": "Bearer " + "t" * 40}


def _client() -> tuple[Any, Any]:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from app.llm import BudgetGuard, MemorySpendStore
    from app.main import create_app, memory_container
    from tests.conftest import FakeLlm, FakeWebApp, settings

    c = memory_container(settings(), llm=FakeLlm(BudgetGuard(MemorySpendStore(), 10, 1)), web=FakeWebApp())
    return TestClient(create_app(c)), c


def test_the_api_needs_the_internal_token() -> None:
    client, _ = _client()
    with client:
        assert client.get("/admin-settings").status_code == 401
        assert client.put("/admin-settings/agent-limits", json={"values": {}}).status_code == 401


def test_the_api_reads_the_schema_and_saves_one_group() -> None:
    client, c = _client()
    with client:
        view = client.get("/admin-settings", headers=AUTH).json()
        assert [g["id"] for g in view["groups"]] == [g.id for g in GROUPS]
        # Nothing is saved, so nothing waits for a restart. The one exception is the test's own container: it is built
        # with host names for the test client (conftest.settings), which differ from what the environment gives.
        pending = {f["env"] for g in view["groups"] for f in g["fields"] if f["restart_pending"]}
        assert pending == {"MCP_ALLOWED_HOSTS"} and next(g for g in view["groups"] if g["id"] == "agent-limits")["restart_pending"] is False
        before = c.settings.crew_max_iter
        bad = client.put("/admin-settings/agent-limits", headers=AUTH, json={"values": {"CREW_MAX_ITER": 0, "CREW_MAX_RPM": 7}, "actor": "admin"})
        assert bad.status_code == 422 and bad.json()["issues"] == ["Turns per agent: at least 1"]
        assert c.settings.crew_max_iter == before and c.settings.crew_max_rpm != 7
        ok = client.put("/admin-settings/agent-limits", headers=AUTH, json={"values": {"CREW_MAX_ITER": 5, "SEO_FLOW_TIMEOUT_SECONDS": 1200}, "actor": "admin"})
        assert ok.status_code == 200 and c.settings.crew_max_iter == 5 and c.deps.settings.crew_max_iter == 5
        f = by_env(ok.json())
        assert f["CREW_MAX_ITER"]["source"] == "admin" and f["SEO_FLOW_TIMEOUT_SECONDS"]["restart_pending"] is True
        assert client.put("/admin-settings/nope", headers=AUTH, json={"values": {}}).status_code == 404
        assert client.put("/admin-settings/agent-limits", headers=AUTH, content=b"not json").status_code == 422
        assert client.put("/admin-settings/agent-limits", headers=AUTH, json=["CREW_MAX_ITER"]).status_code == 422


# --- The table (needs SEO_AGENT_TEST_DATABASE_URL) -------------------------------------------------------------------


@pytest.fixture
async def pool() -> AsyncIterator[Any]:
    url = os.environ.get("SEO_AGENT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("set SEO_AGENT_TEST_DATABASE_URL to run the Postgres tests")
    import psycopg
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    schema = f"s_{uuid.uuid4().hex[:10]}"
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as c:
        await c.execute(f"create schema {schema}")
    p = AsyncConnectionPool(
        url, min_size=1, max_size=3, open=False, kwargs={"autocommit": True, "row_factory": dict_row, "options": f"-c search_path={schema}"}
    )
    await p.open()
    try:
        yield p
    finally:
        await p.close()
        async with await psycopg.AsyncConnection.connect(url, autocommit=True) as c:
            await c.execute(f"drop schema {schema} cascade")


@pytest.mark.postgres
async def test_the_table_is_created_and_a_save_is_one_transaction(pool: Any) -> None:
    store = PgSettingsStore(pool, ttl_s=0)
    await store.ensure_schema()
    await store.ensure_schema()
    assert await store.load() == {}
    running = load_settings({})
    await save_group(store, running, "agent-limits", {"CREW_MAX_ITER": 9, "SEO_AGENT_DOCS_ALLOWLIST": ["kubernetes.io", "istio.io"]}, "admin", env={})
    again = await PgSettingsStore(pool, ttl_s=0).load()
    assert again["CREW_MAX_ITER"].value == 9 and again["CREW_MAX_ITER"].updated_by == "admin" and again["CREW_MAX_ITER"].updated_at
    assert again["SEO_AGENT_DOCS_ALLOWLIST"].value == ["kubernetes.io", "istio.io"]
    await save_group(store, running, "agent-limits", {"CREW_MAX_ITER": None, "CREW_MAX_RPM": 40}, "other", env={})
    assert set(await PgSettingsStore(pool, ttl_s=0).load()) == {"SEO_AGENT_DOCS_ALLOWLIST", "CREW_MAX_RPM"}
    async with pool.connection() as c:
        assert (await (await c.execute(f"select count(*)::int as n from {TABLE}")).fetchone())["n"] == 2  # noqa: S608 - constant name


async def test_an_outage_keeps_the_last_known_values_and_never_read_means_the_deployment() -> None:
    class Broken:
        def connection(self) -> Any:
            raise OSError("database is down")

    assert await PgSettingsStore(Broken()).load() == {}
    store = PgSettingsStore(Broken(), ttl_s=0)
    store._value = rows(CREW_MAX_ITER=9)
    assert (await store.load())["CREW_MAX_ITER"].value == 9


# --- P3: embeddings, retrieval and MCP groups ---------------------------------------------------------------------------


def _group(gid: str) -> Group:
    return next(g for g in GROUPS if g.id == gid)


def test_the_p3_groups_exist_and_say_what_applies_live() -> None:
    assert [g.id for g in GROUPS][:4] == ["agent-limits", "embeddings", "retrieval", "mcp"]
    live = {f.env for g in GROUPS for f in g.fields if f.apply == "live"}
    # Read on every request or by the hourly prune: live. Everything built once at start-up waits for a restart.
    assert {"ASK_BLOG_TOP_K", "ASK_BLOG_MIN_SCORE", "ASK_BLOG_RETENTION_DAYS", "PUBLIC_MCP_ENABLED", "ADMIN_MCP_ENABLED"} <= live
    for env in ("LANCEDB_ARTICLE_INDEX", "PUBLIC_MCP_RPM_PER_IP", "ADMIN_MCP_KICKOFFS_PER_HOUR", "MCP_ALLOWED_HOSTS", "OLLAMA_URL", "EMBEDDINGS_API_KEY", "EMBEDDINGS_TIMEOUT_SECONDS"):
        assert env not in live, env
    assert _group("embeddings").field("EMBEDDINGS_API_KEY").secret  # type: ignore[union-attr]


def test_what_would_invalidate_the_index_or_belongs_elsewhere_is_not_editable() -> None:
    registered = {f.env for g in GROUPS for f in g.fields}
    # Changing the embeddings provider or model needs a guarded re-embed, which does not exist yet.
    assert not registered & {"EMBEDDINGS_PROVIDER", "EMBEDDINGS_MODEL_DIR", "OLLAMA_EMBED_MODEL", "OLLAMA_EMBED_DIM"}
    # Set in Ask the Blog (the web app's runtime options): one place per knob.
    assert not registered & {"ASK_BLOG_ENABLED", "ASK_BLOG_DAILY_BUDGET_USD", "ASK_BLOG_CACHE_TTL_SECONDS"}
    # Owned by the code, never a setting.
    assert not registered & {"MCP_KICKOFF_ALLOWLIST"}


def test_p3_precedence_and_ranges() -> None:
    assert effective({}, {"ASK_BLOG_TOP_K": "4"}).ask_top_k == 4
    assert effective(rows(ASK_BLOG_TOP_K=9), {"ASK_BLOG_TOP_K": "4"}).ask_top_k == 9
    assert effective(rows(ASK_BLOG_MIN_SCORE=0.3), {}).ask_min_score == 0.3
    assert effective(rows(PUBLIC_MCP_ENABLED=True), {"PUBLIC_MCP_ENABLED": "false"}).public_mcp_enabled is True
    assert effective(rows(ADMIN_MCP_ENABLED=False), {"ADMIN_MCP_ENABLED": "true"}).admin_mcp_enabled is False
    assert effective(rows(MCP_ALLOWED_HOSTS=["jithendar.com", "localhost:8081"]), {}).mcp_allowed_hosts == ("jithendar.com", "localhost:8081")
    assert effective(rows(LANCEDB_ARTICLE_INDEX=False), {}).lancedb_article_index is False
    retrieval, mcp, emb = _group("retrieval"), _group("mcp"), _group("embeddings")
    for field_, bad in (
        (retrieval.field("ASK_BLOG_TOP_K"), 13),
        (retrieval.field("ASK_BLOG_TOP_K"), 0),
        (retrieval.field("ASK_BLOG_MIN_SCORE"), 0.99),
        (mcp.field("PUBLIC_MCP_RPM_PER_IP"), 0),
        (mcp.field("MCP_ALLOWED_HOSTS"), ["https://jithendar.com"]),
        (mcp.field("MCP_ALLOWED_HOSTS"), ["bad host"]),
        (emb.field("OLLAMA_URL"), "ollama:11434"),
        (emb.field("OLLAMA_URL"), "http://user:pw@ollama:11434"),
        (emb.field("EMBEDDINGS_TIMEOUT_SECONDS"), 5),
    ):
        assert field_ is not None
        with pytest.raises(Invalid):
            clean(field_, bad)
    assert clean(emb.field("OLLAMA_URL"), "http://ollama.ai.svc.cluster.local:11434") == "http://ollama.ai.svc.cluster.local:11434"  # type: ignore[arg-type]


def test_switching_an_mcp_server_is_live_and_its_limits_wait_for_a_restart() -> None:
    running = load_settings({"PUBLIC_MCP_ENABLED": "true"})
    changed = apply_live(running, rows(PUBLIC_MCP_ENABLED=False, PUBLIC_MCP_RPM_PER_IP=5, ASK_BLOG_TOP_K=3), {"PUBLIC_MCP_ENABLED": "true"})
    assert sorted(changed) == ["ASK_BLOG_TOP_K", "PUBLIC_MCP_ENABLED"]
    assert running.public_mcp_enabled is False and running.ask_top_k == 3
    assert running.public_mcp_rpm_per_ip == Settings.public_mcp_rpm_per_ip  # built into the server at start-up
