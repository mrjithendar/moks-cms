"""The read-only article index browser (/admin/article-index → app/chunk_browser.py) without a database: the HTTP API,
its token, and the input checks. The SQL itself runs against a real pgvector in tests/test_postgres.py."""

from __future__ import annotations

import pytest

from app.chunk_browser import MAX_PAGE, MAX_QUERY, BrowseError, article_uuid, like, page, table_name
from app.main import memory_container
from tests.conftest import settings
from tests.test_tools_api import AUTH, client

PATHS = ["/chunks", "/chunks/articles", "/chunks/rows", "/chunks/rows/1"]


async def test_the_endpoints_need_the_token_and_only_read(llm, web) -> None:
    async with client(memory_container(settings(), llm=llm, web=web)) as h:
        for path in PATHS:
            assert (await h.get(path)).status_code == 401, path
            assert (await h.get(path, headers={"Authorization": "Bearer wrong"})).status_code == 401, path
            assert (await h.post(path, json={}, headers=AUTH)).status_code == 405, path  # nothing here writes


async def test_without_a_database_the_overview_says_so_and_the_rest_is_unavailable(llm, web) -> None:
    async with client(memory_container(settings(), llm=llm, web=web)) as h:
        r = await h.get("/chunks", headers=AUTH)
        assert r.status_code == 200 and r.json()["available"] is False and r.json()["tables"] == []
        for path in PATHS[1:]:
            r = await h.get(path, headers=AUTH)
            assert r.status_code == 503 and "not available" in r.json()["error"], path


def test_tables_are_picked_by_role_never_by_name() -> None:
    assert table_name("live") == "seo_article_chunks" and table_name("rebuild") == "seo_article_chunks_next"
    for bad in ("seo_article_chunks", "post", "live; drop table post", ""):
        with pytest.raises(BrowseError) as e:
            table_name(bad)
        assert e.value.status == 400


def test_the_text_filter_is_a_literal_substring() -> None:
    assert like(None) is None and like("  ") is None
    assert like("cert-manager") == "%cert-manager%"
    assert like("100%_done\\") == "%100\\%\\_done\\\\%"  # % _ \ match themselves
    with pytest.raises(BrowseError):
        like("x" * (MAX_QUERY + 1))


def test_paging_and_ids_are_checked() -> None:
    assert page(0, 1) == (0, 1) and page(50, MAX_PAGE) == (50, MAX_PAGE)
    for offset, limit in ((-1, 25), (0, 0), (0, MAX_PAGE + 1)):
        with pytest.raises(BrowseError):
            page(offset, limit)
    assert article_uuid(None) is None and article_uuid("") is None
    assert article_uuid("6F9619FF-8B86-D011-B42D-00C04FC964FF") == "6f9619ff-8b86-d011-b42d-00c04fc964ff"
    with pytest.raises(BrowseError):
        article_uuid("1 or 1=1")
