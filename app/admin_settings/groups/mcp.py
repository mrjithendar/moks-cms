"""Settings group "MCP": the two MCP servers' switches and limits.

- The two switches are read on every request (app/mcp/__init__.py `_Switch`): live. A server that is off answers
  503 at once.
- The rate limits and the allowed hosts are given to the servers when they are built: restart.

What is not here, and stays owned by the code: which tools exist, that no tool approves, publishes, rolls back or
submits, and the kickoff allowlist (app/mcp/admin.py). Nothing in this group can widen them.
"""

from __future__ import annotations

from ..registry import Field, Group

HOST = r"(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?"

GROUP = Group(
    id="mcp",
    title="MCP servers",
    description="The public and the admin MCP server: on or off, how many calls each client may make, and which host names they answer to.",
    fields=(
        Field("PUBLIC_MCP_ENABLED", "public_mcp_enabled", "Public MCP server", "Read-only tools over published articles, for anyone. Off answers 503 at once.", "boolean"),
        Field("PUBLIC_MCP_RPM_PER_IP", "public_mcp_rpm_per_ip", "Public: calls per minute, per address", "One address may make this many calls in a minute.", "integer", apply="restart", unit="calls per minute", min=1, max=6000),
        Field("PUBLIC_MCP_DAILY_CALLS", "public_mcp_daily_calls", "Public: calls per day, all addresses", "The public server stops answering for the day after this many calls.", "integer", apply="restart", unit="calls per day", min=1, max=10_000_000),
        Field("ADMIN_MCP_ENABLED", "admin_mcp_enabled", "Admin MCP server", "Tools for signed-in admins with a token. Off answers 503 at once.", "boolean"),
        Field("ADMIN_MCP_RPM_PER_TOKEN", "admin_mcp_rpm_per_token", "Admin: calls per minute, per token", "One token may make this many calls in a minute.", "integer", apply="restart", unit="calls per minute", min=1, max=6000),
        Field("ADMIN_MCP_KICKOFFS_PER_HOUR", "admin_kickoffs_per_hour", "Admin: flow starts per hour", "The most flows that may be started over MCP in an hour.", "integer", apply="restart", unit="starts per hour", min=1, max=1000),
        Field("MCP_ALLOWED_HOSTS", "mcp_allowed_hosts", "Host names the servers answer to", "A request for any other host name is refused. One per line.", "list", apply="restart", pattern=HOST, item_max=260),
    ),
)
