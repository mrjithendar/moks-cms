"""The article index copied into LanceDB (D-93; app/lance_index.py): a real embedded LanceDB in a temporary folder."""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

from app.lance_admin import LanceAdmin
from app.lance_index import TABLE, ArticleMirror, to_arrow
from app.main import memory_container
from tests.conftest import settings

NOW = dt.datetime(2026, 11, 18, 5, 0, tzinfo=dt.UTC)


def _row(article: str, i: int, title: str = "Istio on k3s", dim: int = 4) -> dict[str, Any]:
    return {
        "id": f"{article}:{i}",
        "article_id": article,
        "chunk_index": i,
        "title": title,
        "path": f"/blog/{article}",
        "category": "kubernetes",
        "heading_path": f"Part {i}",
        "anchor": f"part-{i}",
        "content": f"chunk {i} of {article}",
        "content_hash": f"h{i}",
        "model": "hash-384",
        "updated_at": NOW,
        "embedding": "[" + ",".join(str(0.1 * (i + j)) for j in range(dim)) + "]",
    }


class Rows:
    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows
        self.calls = 0

    async def __call__(self) -> list[dict[str, Any]]:
        self.calls += 1
        return self.rows


@pytest.fixture
def admin(tmp_path) -> LanceAdmin:
    return LanceAdmin(str(tmp_path))


async def test_sync_writes_the_chunks_with_their_vectors_and_the_browser_sees_them(admin) -> None:
    rows = Rows([_row("a", 0), _row("a", 1), _row("b", 0, "Valkey")])
    out = await ArticleMirror(admin, rows).sync()
    assert out["synced"] and out["rows"] == 3 and out["articles"] == 2
    t = admin._conn().open_table(TABLE)
    assert str(t.schema.field("vector").type) == "fixed_size_list<item: float>[4]"
    assert t.search([0.1, 0.2, 0.3, 0.4]).limit(1).to_list()[0]["id"] == "a:1"  # nearest vector, real search
    o = admin.overview()
    tab = next(x for x in o["tables"] if x["name"] == TABLE)
    cols = {c["name"]: c for c in tab["columns"]}
    assert tab["rows"] == 3 and cols["id"]["editable"] and not cols["vector"]["editable"]
    assert admin.row(TABLE, "id", "b:0")["row"]["title"] == "Valkey"  # unique key column for /admin/lancedb


async def test_sync_replaces_the_copy_and_drops_unpublished_articles(admin) -> None:
    rows = Rows([_row("a", 0), _row("b", 0)])
    m = ArticleMirror(admin, rows)
    v1 = (await m.sync())["version"]
    rows.rows = [_row("a", 0, "Istio on k3s, revised")]
    out = await m.sync()
    assert out["rows"] == 1 and out["version"] > v1
    assert admin._conn().open_table(TABLE).to_arrow().column("title").to_pylist() == ["Istio on k3s, revised"]


async def test_an_empty_result_never_wipes_a_filled_copy(admin) -> None:
    rows = Rows([_row("a", 0)])
    m = ArticleMirror(admin, rows)
    await m.sync()
    rows.rows = []
    out = await m.sync()
    assert not out["synced"] and "kept" in out["reason"]
    assert admin._conn().open_table(TABLE).count_rows() == 1


async def test_after_reindex_skips_unchanged_runs_and_never_raises(admin) -> None:
    rows = Rows([_row("a", 0)])
    m = ArticleMirror(admin, rows)
    assert (await m.after_reindex({"embedded": 0, "unchanged": 1}))["synced"]  # missing table: filled once
    assert (await m.after_reindex({"embedded": 0, "unchanged": 1}))["reason"] == "already there"
    assert rows.calls == 1
    assert (await m.after_reindex({"embedded": 1}))["synced"] and rows.calls == 2

    async def boom() -> list[dict[str, Any]]:
        raise RuntimeError("R2 down")

    assert (await ArticleMirror(admin, boom).after_reindex({"embedded": 1})) == {"synced": False, "reason": "failed: RuntimeError"}


async def test_off_and_unconfigured_do_nothing(admin) -> None:
    rows = Rows([_row("a", 0)])
    assert "off" in (await ArticleMirror(admin, rows, enabled=False).sync())["reason"]
    assert "not configured" in (await ArticleMirror(LanceAdmin(), rows).sync())["reason"]
    assert rows.calls == 0


def test_mixed_embedding_sizes_are_refused() -> None:
    with pytest.raises(ValueError, match="mixed"):
        to_arrow([_row("a", 0, dim=4), _row("a", 1, dim=3)])


class StubIndex:
    available = True

    def __init__(self, stats: dict[str, int]):
        self.stats = stats

    async def reindex(self, articles: list[dict[str, Any]], **_kw: Any) -> dict[str, int]:
        return dict(self.stats)


async def test_container_reindex_syncs_lancedb(llm, web, admin) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    c.index = StubIndex({"articles": 1, "embedded": 2, "unchanged": 0, "deleted": 0})
    c.mirror = ArticleMirror(admin, Rows([_row("a", 0), _row("a", 1)]))
    stats = await c.reindex()
    assert stats["embedded"] == 2 and stats["lancedb_synced"] == 1
    assert admin._conn().open_table(TABLE).count_rows() == 2


async def test_initial_mirror_waits_for_storage_then_fills_once(llm, web, tmp_path) -> None:
    answers = [{"configured": False}]

    async def resolve() -> dict[str, Any]:
        return answers[0]

    lazy = LanceAdmin(resolve=resolve)
    c = memory_container(settings(), llm=llm, web=web)
    rows = Rows([_row("a", 0)])
    c.mirror = ArticleMirror(lazy, rows)
    slept: list[float] = []

    async def fake_sleep(s: float) -> None:  # storage is set up while the agent waits
        slept.append(s)
        lazy.uri, lazy._asked_at = str(tmp_path), -1e9

    await c.initial_mirror(attempts=3, every_s=60, sleep=fake_sleep)
    assert slept == [60] and rows.calls == 1
    assert lazy._conn().open_table(TABLE).count_rows() == 1
