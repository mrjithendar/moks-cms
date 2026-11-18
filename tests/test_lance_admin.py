"""LanceDB browser for /admin/lancedb (D-92): a real embedded LanceDB in a temporary folder, through the HTTP API."""

from __future__ import annotations

import lancedb
import pytest

from app.lance_admin import LanceAdmin, LanceError, _literal, from_env
from app.main import memory_container
from tests.conftest import settings
from tests.test_tools_api import AUTH, client


@pytest.fixture
def lance(tmp_path) -> LanceAdmin:
    db = lancedb.connect(str(tmp_path))
    db.create_table(
        "articles",
        data=[
            {"id": "a", "title": "Istio on k3s", "score": 0.5, "views": 10, "vector": [0.1, 0.2, 0.3]},
            {"id": "b", "title": "It's Valkey", "score": 0.9, "views": 3, "vector": [0.4, 0.5, 0.6]},
            {"id": "c", "title": "x" * 1000, "score": 0.1, "views": 3, "vector": [0.7, 0.8, 0.9]},
        ],
    )
    return LanceAdmin(str(tmp_path))


def _c(llm, web, lance: LanceAdmin):
    c = memory_container(settings(), llm=llm, web=web)
    c.lance = lance
    return c


async def test_lancedb_endpoints_need_the_token(llm, web, lance) -> None:
    async with client(_c(llm, web, lance)) as h:
        for method, path in [("GET", "/lancedb"), ("GET", "/lancedb/tables/articles"), ("POST", "/lancedb/tables/articles/row"), ("POST", "/lancedb/tables/articles/update"), ("POST", "/lancedb/tables/articles/delete")]:
            assert (await h.request(method, path, json={})).status_code == 401, path


async def test_overview_and_browse(llm, web, lance) -> None:
    async with client(_c(llm, web, lance)) as h:
        o = (await h.get("/lancedb", headers=AUTH)).json()
        assert o["configured"] and [t["name"] for t in o["tables"]] == ["articles"] and o["tables"][0]["rows"] == 3
        cols = {c["name"]: c for c in o["tables"][0]["columns"]}
        assert cols["title"]["editable"] and not cols["vector"]["editable"] and cols["vector"]["kind"] == "vector"
        page = (await h.get("/lancedb/tables/articles", params={"offset": 1, "limit": 1}, headers=AUTH)).json()
        assert page["total"] == 3 and len(page["rows"]) == 1
        allrows = (await h.get("/lancedb/tables/articles", headers=AUTH)).json()["rows"]
        long = next(r for r in allrows if r["id"] == "c")
        assert long["title"] == {"text": "x" * 300, "length": 1000}  # abridged in the page …
        assert long["vector"]["dims"] == 3
        full = (await h.post("/lancedb/tables/articles/row", json={"key_column": "id", "key": "c"}, headers=AUTH)).json()
        assert full["row"]["title"] == "x" * 1000  # … whole in the row view
        assert (await h.get("/lancedb/tables/nope", headers=AUTH)).status_code == 404
        assert (await h.get("/lancedb/tables/articles;drop", headers=AUTH)).status_code == 404


async def test_update_one_row_with_quotes(llm, web, lance) -> None:
    async with client(_c(llm, web, lance)) as h:
        r = await h.post("/lancedb/tables/articles/update", json={"key_column": "id", "key": "b", "values": {"title": "It's Valkey, again", "views": "7"}, "actor": "admin@example.com"}, headers=AUTH)
        assert r.status_code == 200 and r.json()["updated"] == 1
        row = (await h.post("/lancedb/tables/articles/row", json={"key_column": "id", "key": "b"}, headers=AUTH)).json()["row"]
        assert row["title"] == "It's Valkey, again" and row["views"] == 7
        other = (await h.post("/lancedb/tables/articles/row", json={"key_column": "id", "key": "a"}, headers=AUTH)).json()["row"]
        assert other["title"] == "Istio on k3s"  # nothing else changed


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"key_column": "views", "key": 3, "values": {"title": "both"}}, 409),  # two rows have views = 3
        ({"key_column": "id", "key": "zzz", "values": {"title": "none"}}, 404),
        ({"key_column": "id", "key": "a", "values": {"vector": "1"}}, 400),  # vectors are read-only
        ({"key_column": "id", "key": "a", "values": {"nope": "1"}}, 400),
        ({"key_column": "vector", "key": "a", "values": {"title": "1"}}, 400),
        ({"key_column": "id", "key": "a", "values": {"views": "ten"}}, 400),
        ({"key_column": "id = id or 1=1 --", "key": "a", "values": {"title": "1"}}, 400),
        ({"key_column": "id", "key": "a' or '1'='1", "values": {"title": "hacked"}}, 404),  # quoted, so it matches nothing
    ],
)
async def test_updates_that_are_refused(llm, web, lance, body, status) -> None:
    async with client(_c(llm, web, lance)) as h:
        r = await h.post("/lancedb/tables/articles/update", json=body, headers=AUTH)
        assert r.status_code == status, r.text
        titles = sorted(r["title"][:5] if isinstance(r["title"], str) else "long" for r in (await h.get("/lancedb/tables/articles", headers=AUTH)).json()["rows"])
        assert titles == ["Istio", "It's ", "long"]


async def test_delete_one_row(llm, web, lance) -> None:
    async with client(_c(llm, web, lance)) as h:
        assert (await h.post("/lancedb/tables/articles/delete", json={"key_column": "views", "key": 3}, headers=AUTH)).status_code == 409
        r = await h.post("/lancedb/tables/articles/delete", json={"key_column": "id", "key": "a"}, headers=AUTH)
        assert r.status_code == 200 and r.json()["deleted"] == 1
        assert (await h.get("/lancedb", headers=AUTH)).json()["tables"][0]["rows"] == 2


async def test_not_configured(llm, web) -> None:
    async with client(_c(llm, web, LanceAdmin(""))) as h:
        assert (await h.get("/lancedb", headers=AUTH)).json() == {"configured": False, "location": None, "source": None, "tables": []}
        assert (await h.get("/lancedb/tables/x", headers=AUTH)).status_code == 503


def test_literals_and_env() -> None:
    assert _literal("it's", "string") == "'it''s'"
    assert _literal(True, "bool") == "true"
    for bad, kind in [("1; drop", "int"), ("nan", "float"), ("x", "bool"), ("not a date", "timestamp")]:
        with pytest.raises(LanceError):
            _literal(bad, kind)
    assert from_env({"LANCEDB_URI": "/data/lance"}).source == "env"
    assert not from_env({}).configured


async def test_storage_comes_from_admin_storage_and_is_retried(tmp_path, monkeypatch) -> None:
    import app.lance_admin as la

    calls = []
    answers = [{"configured": False}, {"configured": True, "uri": "s3://media/jithendar/seo-agent/lancedb", "endpoint": "https://acct.r2.cloudflarestorage.com", "accessKeyId": "k", "secretAccessKey": "s", "region": "auto"}]

    async def resolve():
        calls.append(1)
        return answers[len(calls) - 1]

    a = from_env({}, resolve=resolve)
    await a.ensure()
    assert not a.configured and len(calls) == 1
    await a.ensure()  # within a minute: not asked again
    assert len(calls) == 1
    monkeypatch.setattr(la, "RETRY_S", 0.0)
    a._asked_at = -1.0
    await a.ensure()
    assert a.configured and a.source == "storage" and a.location() == "s3://media/jithendar/seo-agent/lancedb"
    assert a.storage_options == {"endpoint": "https://acct.r2.cloudflarestorage.com", "aws_access_key_id": "k", "aws_secret_access_key": "s", "region": "auto"}
    assert from_env({"LANCEDB_URI": str(tmp_path)}, resolve=resolve).resolve is None  # the folder override wins


async def test_web_app_down_leaves_it_unconfigured() -> None:
    async def resolve():
        raise RuntimeError("down")

    a = from_env({}, resolve=resolve)
    assert (await a.run("overview"))["configured"] is False
