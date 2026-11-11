"""The MCP edge app: `/mcp/public` and `/mcp/admin` (Streamable HTTP, stateless) on their own port (8090).

The internal API (flows, review decisions, /ask) stays on 8080, reachable only from the web pods and the trigger
CronJobs. Kong reaches only this port (NetworkPolicy), so a public request can never touch the internal API
(D-62). MCP is an interface only: every tool calls `app/services` and the same run manager as the admin UI.

- Kill switches: PUBLIC_MCP_ENABLED and ADMIN_MCP_ENABLED (both default false) → 404 while off.
- DNS-rebinding protection (MCP spec): Host must be an allowed host, Origin (when a browser sends one) an allowed
  origin; everything else gets 421/403 from the SDK's transport security.
- Client IP for per-IP limits: the right-most X-Forwarded-For entry added by Kong (one trusted hop), else the peer.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator
from typing import Any

from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Receive, Scope, Send

from .admin import ADMIN_TOOLS, build_admin, caller
from .auth import DbTokenVerifier
from .common import CLIENT_IP, AuditLog, Guard, RateLimiter
from .public import PUBLIC_TOOLS, build_public

PUBLIC_DAILY_PER_IP_DEFAULT = 500


def public_daily_per_ip(s: Any) -> int:
    """PUBLIC_MCP_DAILY_CALLS_PER_IP (default 500/day per client IP; 0 = off): a single client cannot use up the global
    daily backstop (PUBLIC_MCP_DAILY_CALLS) for everyone. Read like the other settings (config._int)."""
    v = getattr(s, "public_mcp_daily_calls_per_ip", None)
    if isinstance(v, int):
        return v
    from ..config import _int

    return _int("PUBLIC_MCP_DAILY_CALLS_PER_IP", PUBLIC_DAILY_PER_IP_DEFAULT)

__all__ = ["ADMIN_TOOLS", "PUBLIC_TOOLS", "create_edge_app"]


def security(settings: Any) -> TransportSecuritySettings:
    hosts = list(settings.mcp_allowed_hosts)
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=hosts + [f"{h}:*" for h in hosts],
        allowed_origins=[f"https://{h}" for h in hosts] + ["https://claude.ai", "https://claude.com"],
    )


class _ClientIp:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            xff = dict(scope.get("headers") or []).get(b"x-forwarded-for", b"").decode("latin-1")
            ip = xff.split(",")[-1].strip() if xff else (scope.get("client") or ("unknown",))[0]
            token = CLIENT_IP.set(ip[:64] or "unknown")
            try:
                await self.app(scope, receive, send)
            finally:
                CLIENT_IP.reset(token)
            return
        await self.app(scope, receive, send)


class _Prefix:
    """Serve an MCP app at `/mcp/x` *and* `/mcp/x/…` (a Starlette Mount would 307-redirect the bare path, which is the
    URL clients are configured with)."""

    def __init__(self, routes: dict[str, ASGIApp], fallback: ASGIApp):
        self.routes, self.fallback = routes, fallback

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            for prefix, app in self.routes.items():
                if path == prefix or path.startswith(prefix + "/"):
                    rest = path[len(prefix):] or "/"
                    await app({**scope, "path": rest, "raw_path": rest.encode(), "root_path": scope.get("root_path", "") + prefix}, receive, send)
                    return
        await self.fallback(scope, receive, send)


class _Switch:
    """404 while the server is switched off (the flag is read per request, so tests can flip it)."""

    def __init__(self, app: ASGIApp, on: Any):
        self.app, self.on = app, on

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not self.on():
            await PlainTextResponse("Not found", status_code=404)(scope, receive, send)
            return
        await self.app(scope, receive, send)


def create_edge_app(c: Any, *, verifier: Any = None, audit: Any = None, limiter: RateLimiter | None = None) -> Starlette:
    s = c.settings
    lim = limiter or RateLimiter()
    sec = security(s)
    public = build_public(c, Guard("public", lim, s.public_mcp_rpm_per_ip, s.public_mcp_daily_calls, daily_per_client=public_daily_per_ip(s)), sec)
    admin_guard = Guard("admin", lim, s.admin_mcp_rpm_per_token, audit=audit if audit is not None else (AuditLog(c.pool) if c.pool is not None else None), caller=caller, extra_limits={"kickoff_flow": (s.admin_kickoffs_per_hour, 3600.0), "kickoff_news_job": (s.admin_kickoffs_per_hour, 3600.0)})
    admin = build_admin(c, admin_guard, sec, verifier if verifier is not None else DbTokenVerifier(c.pool, s.admin_mcp_resource))
    public_app, admin_app = public.streamable_http_app(), admin.streamable_http_app()

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        async with public.session_manager.run(), admin.session_manager.run():
            yield

    async def healthz(_r: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "public": s.public_mcp_enabled, "admin": s.admin_mcp_enabled})

    base = Starlette(routes=[Route("/healthz", healthz)])
    app = Starlette(
        routes=[Mount("/", app=_Prefix({"/mcp/public": _Switch(public_app, lambda: c.settings.public_mcp_enabled), "/mcp/admin": _Switch(admin_app, lambda: c.settings.admin_mcp_enabled)}, base))],
        lifespan=lifespan,
        middleware=[Middleware(_ClientIp)],
    )
    app.state.public, app.state.admin = public, admin
    return app
