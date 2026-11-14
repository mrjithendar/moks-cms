"""Ask the Blog runtime options: what an admin set in the web app (Admin → Automation & AI → Ask the Blog).

The web app stores one JSON document in the `setting` table (key "ask_blog", services/www/src/lib/seo-agent/ask-settings.ts).
This service reads the fields it owns from the same row, cached for a short time, so a change applies without a
restart to both entry points: POST /ask (the site widget) and the public MCP `ask_blog` tool.

The environment still has the last word: ASK_BLOG_ENABLED=false switches the assistant off whatever is saved, and
ASK_BLOG_DAILY_BUDGET_USD is a ceiling the saved budget cannot exceed (app/ask.py applies both).

Fail closed: no row, a row that is not valid, or a database error before anything was ever read all mean "off".
After a successful read, a later database error keeps the last known options (an outage must not flip the switch).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol

AUDIENCES = ("members", "everyone")
ANSWER_LENGTHS = ("short", "standard", "detailed")
KEY = "ask_blog"


@dataclass(frozen=True)
class AskOptions:
    # Defaults mirror DEFAULT_ASK_SETTINGS in the web app: off, signed-in readers only.
    enabled: bool = False
    audience: str = "members"
    # None = use the environment's value (ASK_BLOG_DAILY_BUDGET_USD / ASK_BLOG_CACHE_TTL_SECONDS).
    daily_budget_usd: float | None = None
    cache_ttl_s: int | None = None
    answer_length: str = "standard"
    fallback_message: str = ""
    # Sitewide chat (web app `conversation` block): follow-ups rewritten with the earlier turns, the open article
    # ranked a little higher, and reader feedback on answers. Defaults mirror DEFAULT_ASK_SETTINGS.
    follow_ups: bool = True
    follow_up_turns: int = 3
    page_context: bool = True
    feedback: bool = True


def _one_line(v: Any, max_len: int) -> str:
    if not isinstance(v, str):
        return ""
    return "".join(ch for ch in " ".join(v.split()) if ch.isprintable())[:max_len]


def parse_options(value: Any) -> AskOptions:
    """The stored document → options. Tolerant on purpose: this service does not own the schema, so anything missing
    or of the wrong type falls back to the safe default for that field (and `enabled` must be exactly true)."""
    if not isinstance(value, dict):
        return AskOptions()
    budget = value.get("dailyBudgetUsd")
    ttl = value.get("cacheTtlSeconds")
    audience = value.get("audience")
    length = value.get("answerLength")
    raw_conv = value.get("conversation")
    conv: dict[str, Any] = raw_conv if isinstance(raw_conv, dict) else {}
    turns = conv.get("turns")
    d = AskOptions()

    def flag(name: str, default: bool) -> bool:
        v = conv.get(name)
        return v if isinstance(v, bool) else default

    return AskOptions(
        follow_ups=flag("followUps", d.follow_ups),
        follow_up_turns=int(turns) if isinstance(turns, int) and not isinstance(turns, bool) and 1 <= turns <= 5 else d.follow_up_turns,
        page_context=flag("pageContext", d.page_context),
        feedback=flag("feedback", d.feedback),
        enabled=value.get("enabled") is True,
        audience=audience if isinstance(audience, str) and audience in AUDIENCES else "members",
        daily_budget_usd=float(budget) if isinstance(budget, (int, float)) and not isinstance(budget, bool) and budget >= 0 else None,
        cache_ttl_s=int(ttl) if isinstance(ttl, (int, float)) and not isinstance(ttl, bool) and 0 <= ttl <= 86_400 else None,
        answer_length=length if isinstance(length, str) and length in ANSWER_LENGTHS else "standard",
        fallback_message=_one_line(value.get("fallbackMessage"), 200),
    )


class AskRuntime(Protocol):
    async def options(self) -> AskOptions: ...


class StaticAskRuntime:
    """Fixed options (tests, and the in-memory container)."""

    def __init__(self, options: AskOptions | None = None):
        self.value = options or AskOptions(enabled=True, audience="everyone")

    async def options(self) -> AskOptions:
        return self.value


class PgAskRuntime:
    def __init__(self, pool: Any, ttl_s: float = 30.0):
        self.pool, self.ttl = pool, ttl_s
        self._at = 0.0
        self._value: AskOptions | None = None

    async def options(self) -> AskOptions:
        now = time.monotonic()
        if self._value is not None and now - self._at < self.ttl:
            return self._value
        try:
            async with self.pool.connection() as c:
                cur = await c.execute("select value from setting where key = %s", (KEY,))
                row = await cur.fetchone()
            self._value = parse_options(row["value"] if row else None)
        except Exception:
            if self._value is None:
                return AskOptions()  # never read successfully: off, and try again on the next question
        self._at = now
        return self._value
