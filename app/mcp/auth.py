"""Admin MCP authorization: this server is an OAuth 2.1 **resource server** (MCP authorization spec).

The authorization server is the site itself (web app, `src/lib/mcp-oauth/`, D-60): PKCE (S256), dynamic client
registration, consent restricted to the existing admin account, short-lived opaque access tokens bound to the
`/mcp/admin` resource (RFC 8707), refresh tokens with rotation and reuse detection, revocation from
Settings → MCP access. Tokens are stored only as SHA-256 hashes in the shared Postgres (`seo_mcp_tokens`), so this
server verifies a bearer token with one indexed lookup and needs no signing keys; revocation takes effect on the
next request.

`DbTokenVerifier.verify_token` returns the MCP SDK's AccessToken with `resource` set, and the SDK's bearer middleware
(with `validate_token_resource=True`) refuses tokens for any other audience. Missing/invalid → 401 with
`WWW-Authenticate: Bearer resource_metadata=…`; insufficient scope → 403 `insufficient_scope`.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any

from mcp.server.auth.provider import AccessToken

from .. import metrics

SCOPES = ("seo:read", "seo:flows", "seo:review:reject")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class DbTokenVerifier:
    def __init__(self, pool: Any, resource: str):
        self.pool = pool
        self.resource = resource
        self._touched: dict[str, float] = {}

    async def verify_token(self, token: str) -> AccessToken | None:
        if not token or len(token) > 200:
            metrics.MCP_AUTH_FAILURES.labels(server="admin").inc()
            return None
        async with self.pool.connection() as c:
            cur = await c.execute(
                """select t.client_id, t.scopes, t.resource, extract(epoch from t.expires_at)::bigint as exp, g.id as grant_id, g.user_id
                   from seo_mcp_tokens t
                   join seo_mcp_grants g on g.id = t.grant_id
                   join "user" u on u.id = g.user_id
                   where t.token_hash = %s and t.kind = 'access' and t.revoked_at is null and t.expires_at > now()
                     and g.revoked_at is null and u.role = 'admin' and coalesce(u.banned, false) = false""",
                (token_hash(token),),
            )
            r = await cur.fetchone()
            if r is None:
                metrics.MCP_AUTH_FAILURES.labels(server="admin").inc()
                return None
            gid = str(r["grant_id"])
            if time.monotonic() - self._touched.get(gid, 0) > 60:  # last-used, at most once a minute per grant
                self._touched[gid] = time.monotonic()
                await c.execute("update seo_mcp_grants set last_used_at = now() where id = %s", (r["grant_id"],))
        if r["resource"] != self.resource:
            metrics.MCP_AUTH_FAILURES.labels(server="admin").inc()
        return AccessToken(token=token, client_id=str(r["client_id"]), scopes=list(r["scopes"] or []), expires_at=int(r["exp"]), resource=r["resource"], subject=str(r["user_id"]), claims={"grant_id": gid})


@dataclass
class MemoryTokenVerifier:
    """Tests: token → (client_id, scopes, resource, expires_at)."""

    tokens: dict[str, tuple[str, list[str], str, int]] = field(default_factory=dict)

    async def verify_token(self, token: str) -> AccessToken | None:
        t = self.tokens.get(token)
        if not t or t[3] < time.time():
            metrics.MCP_AUTH_FAILURES.labels(server="admin").inc()
            return None
        if t[2] != (self.tokens.get("__resource__") or ("", [], "", 0))[2] and "__resource__" in self.tokens:
            metrics.MCP_AUTH_FAILURES.labels(server="admin").inc()
        return AccessToken(token=token, client_id=t[0], scopes=t[1], resource=t[2], expires_at=t[3], subject="admin-user", claims={"grant_id": f"grant-{t[0]}"})
