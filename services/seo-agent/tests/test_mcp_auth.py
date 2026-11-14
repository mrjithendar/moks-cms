"""DbTokenVerifier: an access token is only a token for the resource it was issued for (RFC 8707)."""

from __future__ import annotations

import contextlib
import time
from collections.abc import AsyncIterator
from typing import Any

from app.mcp.auth import DbTokenVerifier

RESOURCE = "https://jithendar.com/mcp/admin"
ROW = {"client_id": "claude-connector", "scopes": ["seo:read"], "resource": RESOURCE, "exp": int(time.time()) + 600, "grant_id": "grant-1", "user_id": "admin-user"}


class Cursor:
    def __init__(self, row: dict[str, Any] | None):
        self.row = row

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row


class Pool:
    """The one query the verifier runs returns `row`; every statement is recorded."""

    def __init__(self, row: dict[str, Any] | None):
        self.row = row
        self.statements: list[str] = []

    @contextlib.asynccontextmanager
    async def connection(self) -> AsyncIterator[Pool]:
        yield self

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Cursor:
        self.statements.append(" ".join(sql.split()))
        return Cursor(self.row)


def touched(pool: Pool) -> bool:
    return any(s.startswith("update seo_mcp_grants set last_used_at") for s in pool.statements)


async def test_a_token_for_this_resource_is_accepted_and_marks_the_grant_used() -> None:
    pool = Pool(ROW)
    token = await DbTokenVerifier(pool, RESOURCE).verify_token("tok")
    assert token is not None
    assert (token.client_id, token.scopes, token.resource, token.subject) == ("claude-connector", ["seo:read"], RESOURCE, "admin-user")
    assert touched(pool)


async def test_a_token_issued_for_another_resource_is_refused() -> None:
    pool = Pool({**ROW, "resource": "https://jithendar.com/mcp/public"})
    assert await DbTokenVerifier(pool, RESOURCE).verify_token("tok") is None
    # It is not a use of the grant either.
    assert not touched(pool)


async def test_unknown_empty_and_oversized_tokens_are_refused() -> None:
    assert await DbTokenVerifier(Pool(None), RESOURCE).verify_token("tok") is None
    unused = Pool(ROW)
    assert await DbTokenVerifier(unused, RESOURCE).verify_token("") is None
    assert await DbTokenVerifier(unused, RESOURCE).verify_token("x" * 201) is None
    assert unused.statements == []
