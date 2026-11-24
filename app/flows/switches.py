"""Flows switched off (or deleted) in the admin: AI & SEO → Flows (moks-cms crewai_flows, migration 0041).

The web app serves GET /internal/seo-agent/flow-switches: {"disabled": [{"flow": "<flow name>", "reason": "…"}]}. The
runner asks before every kickoff (FlowRunner.kickoff), whoever starts it (a person, a schedule, another flow, MCP, an
approval), and refuses a switched-off flow with 409 and the admin's reason. A step flow (custom_flow) is switched off
per flow by the web app itself: it serves only the enabled ones (GET /custom-flows).

The answer is kept for TTL_S seconds. When the web app cannot be reached the last answer stands (nothing is off until the
web app has said so once), so an outage of the web app never stops flows that were on.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from ..runs import RunError

log = logging.getLogger("seo_agent.flows.switches")

TTL_S = 30.0
FETCH_TIMEOUT_S = 5.0


class FlowSwitches:
    def __init__(self, web: Any, ttl_s: float = TTL_S, clock: Any = time.monotonic):
        self.web = web
        self.ttl_s = ttl_s
        self.clock = clock
        self._off: dict[str, str] = {}
        self._at: float | None = None
        self._lock = asyncio.Lock()

    async def disabled(self) -> dict[str, str]:
        """{flow name: reason} of the flows switched off in the admin."""
        get = getattr(self.web, "flow_switches", None)
        if get is None:
            return {}
        if self._at is not None and self.clock() - self._at < self.ttl_s:
            return self._off
        async with self._lock:
            if self._at is not None and self.clock() - self._at < self.ttl_s:
                return self._off
            try:
                got = await asyncio.wait_for(get(), FETCH_TIMEOUT_S)
                rows = got.get("disabled") if isinstance(got, dict) else None
                self._off = {str(r["flow"]): str(r.get("reason") or "") for r in rows or [] if isinstance(r, dict) and isinstance(r.get("flow"), str)}
            except Exception as e:  # keep the last answer
                log.info("flow switches unavailable; the last answer stands", extra={"event": "flow_switches_unavailable", "error": type(e).__name__})
            self._at = self.clock()
        return self._off

    async def check(self, name: str) -> None:
        off = await self.disabled()
        if name in off:
            reason = off[name]
            raise RunError(409, f"{name} is switched off in the admin" + (f": {reason}" if reason else "") + " (AI & SEO → Flows)")

    def forget(self) -> None:
        self._at = None
