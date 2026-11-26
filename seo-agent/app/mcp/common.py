"""What both MCP servers share: rate limits, the audit log, safe errors, metrics, and the tool wrapper.

Every MCP tool/resource/prompt is a thin wrapper over an `app/services` function, registered through `guarded()`:
- rate limit (public: per client IP per minute, a daily cap per client IP (PUBLIC_MCP_DAILY_CALLS_PER_IP) and the global
  daily backstop (PUBLIC_MCP_DAILY_CALLS); admin: per token, plus a stricter per-hour cap on kickoff_flow);
- metrics `seo_mcp_requests_total{server,tool,status}` and `seo_mcp_request_duration_seconds{server,tool}`;
- admin only: one `audit_log` row per call (client id, tool, arguments with secrets redacted, result status);
- errors become MCP tool errors with a safe message: ContentError/RunError text, or a generic "internal error" with a
  reference id. Never a stack trace, SQL or a secret.
"""

from __future__ import annotations

import functools
import inspect
import json
import logging
import time
import uuid
from collections import deque
from collections.abc import Awaitable, Callable, Collection
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from .. import metrics
from ..runs import RunError
from ..services.content import ContentError
from ..tools import redact

log = logging.getLogger("seo_agent.mcp")

# The client IP for the current request (set by the edge ASGI middleware from Kong's X-Forwarded-For).
CLIENT_IP: ContextVar[str] = ContextVar("mcp_client_ip", default="unknown")


class RateLimiter:
    """Sliding-window counters in process memory (one seo-agent replica). Kong adds its own limits in front.

    In memory on purpose: the service has no Valkey/Redis client (the site's shared Valkey carries only the web app's
    cache-bus pub/sub, no data), and a restart resetting a day's counters is acceptable for an abuse backstop."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.hits: dict[str, deque[float]] = {}
        self.day: dict[str, tuple[str, int]] = {}

    def allow(self, key: str, limit: int, window_s: float) -> bool:
        now = self.clock()
        q = self.hits.setdefault(key, deque())
        while q and now - q[0] > window_s:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        if len(self.hits) > 20_000:  # bound memory: drop idle keys
            for k in [k for k, v in self.hits.items() if not v][:5000]:
                self.hits.pop(k, None)
        return True

    def allow_daily(self, key: str, limit: int) -> bool:
        return self.allow_daily_all([(key, limit)])

    def allow_daily_all(self, checks: list[tuple[str, int]]) -> bool:
        """Several daily counters at once (per client + global): a call counts against all of them, or none when any
        is exhausted (a refused call never uses up another counter). limit <= 0 = no cap for that key."""
        active = [(k, lim) for k, lim in checks if lim > 0]
        if not active:
            return True
        today = datetime.now(UTC).strftime("%Y-%m-%d")
        counts: list[tuple[str, int]] = []
        for key, limit in active:
            d, n = self.day.get(key, (today, 0))
            n = n if d == today else 0
            if n >= limit:
                return False
            counts.append((key, n))
        for key, n in counts:
            self.day[key] = (today, n + 1)
        if len(self.day) > 50_000:  # bound memory: per-client keys from earlier days go first
            for k in [k for k, (d, _n) in self.day.items() if d != today][:25_000]:
                self.day.pop(k, None)
        return True


class AuditLog:
    """Admin MCP calls → the site's existing `audit_log` (v1 D-04: no separate seo_audit_logs table)."""

    def __init__(self, pool: Any):
        self.pool = pool

    async def record(self, *, client_id: str, subject: str | None, tool: str, args: dict[str, Any], status: str) -> None:
        detail = {"client_id": client_id, "tool": tool, "arguments": redact_args(args), "status": status}
        async with self.pool.connection() as c:
            await c.execute(
                # Columns of the web app's audit_log (src/db/schema.ts auditLog).
                """insert into audit_log (actor_id, actor, action, target, detail, user_agent, severity)
                   values (%s, %s, %s, %s, %s::jsonb, 'mcp', %s)""",
                (subject, f"mcp:{client_id}"[:200], f"seo.mcp.{tool}", tool, json.dumps(detail, default=str), "warning" if status != "ok" else "info"),
            )


@dataclass
class MemoryAuditLog:
    rows: list[dict[str, Any]] = field(default_factory=list)

    async def record(self, **row: Any) -> None:
        self.rows.append({**row, "args": redact_args(row.get("args") or {})})


_SECRET_KEYS = ("token", "secret", "password", "authorization", "api_key", "apikey", "key", "cookie")


def redact_args(args: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in args.items():
        if any(s in k.lower() for s in _SECRET_KEYS):
            out[k] = "[redacted]"
        elif isinstance(v, str):
            out[k] = redact(v)[:500]
        elif isinstance(v, dict):
            out[k] = redact_args(v)
        else:
            out[k] = v
    return out


@dataclass
class Guard:
    server: str  # public | admin
    limiter: RateLimiter
    rpm: int
    daily: int = 0  # global daily backstop for this server
    daily_per_client: int = 0  # daily cap per client key (public: per IP); 0 = none
    audit: Any = None
    caller: Callable[[], tuple[str, str | None, list[str]]] | None = None  # → (key, subject, scopes)
    extra_limits: dict[str, tuple[int, float]] = field(default_factory=dict)  # tool → (limit, window_s)
    # Tools an admin switched off, read on every call so a change applies at once (settings group "mcp").
    off: Callable[[], Collection[str]] = tuple


def hide_switched_off(server: Any, off: Collection[str]) -> list[str]:
    """Leaves tools that are switched off out of the server's tool list. Done once, when the server is built, so a
    tool switched off later is refused at once (guarded) and disappears from the list at the next restart. Returns the
    names it removed. If the SDK offers no way to remove a tool it stays listed; calls are refused all the same."""
    remove = getattr(server, "remove_tool", None)
    registry = getattr(getattr(server, "_tool_manager", None), "_tools", None)  # SDKs before remove_tool existed
    removed: list[str] = []
    for name in off:
        try:
            if remove is not None:
                remove(name)
            elif isinstance(registry, dict) and name in registry:
                del registry[name]
            else:
                continue
            removed.append(name)
        except Exception:  # noqa: S112 - an unknown name is not an error: the setting may name a tool that no longer exists
            continue
    return removed


def guarded(g: Guard, tool: str, *, scope: str | None = None) -> Callable[[Callable[..., Awaitable[Any]]], Callable[..., Awaitable[Any]]]:
    metrics.MCP_TOOLS.add(tool)

    def deco(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            started = time.monotonic()
            status = "ok"
            key, subject, scopes = g.caller() if g.caller else (f"ip:{CLIENT_IP.get()}", None, [])
            try:
                if tool in g.off():
                    status = "disabled"
                    raise ToolError(f"{tool} is switched off by the site's admin")
                if scope and scope not in scopes:
                    status = "forbidden"
                    raise ToolError(f"insufficient_scope: this tool needs the {scope} scope")
                if not g.limiter.allow(f"{g.server}:{key}", g.rpm, 60) or not g.limiter.allow_daily_all([(f"{g.server}:day:{key}", g.daily_per_client), (f"{g.server}:day", g.daily)]):
                    status = "rate_limited"
                    raise ToolError("rate limit reached; try again later")
                if tool in g.extra_limits:
                    lim, win = g.extra_limits[tool]
                    if not g.limiter.allow(f"{g.server}:{tool}:{key}", lim, win):
                        status = "rate_limited"
                        raise ToolError(f"{tool} is limited to {lim} calls per {int(win // 60)} minutes")
                return await fn(*args, **kwargs)
            except ToolError:
                status = status if status != "ok" else "error"
                raise
            except (ContentError, RunError) as e:
                status = "invalid"
                raise ToolError(str(e)) from None
            except Exception:
                status = "error"
                ref = uuid.uuid4().hex[:12]
                log.exception("mcp tool failed", extra={"event": "mcp_tool_failed", "tool": tool, "ref": ref})
                raise ToolError(f"internal error (reference {ref})") from None
            finally:
                metrics.MCP_REQUESTS.labels(server=g.server, tool=metrics.mcp_tool_label(tool), status=status).inc()
                metrics.MCP_DURATION.labels(server=g.server, tool=metrics.mcp_tool_label(tool)).observe(time.monotonic() - started)
                if g.audit is not None:
                    try:
                        await g.audit.record(client_id=key, subject=subject, tool=tool, args=kwargs, status=status)
                    except Exception:
                        log.warning("mcp audit write failed", extra={"event": "mcp_audit_failed"})

        wrapper.__signature__ = inspect.signature(fn, eval_str=True)  # type: ignore[attr-defined]
        wrapper.__annotations__ = {}  # the evaluated signature is authoritative (string annotations live in fn's module)
        return wrapper

    return deco
