"""Admin-managed runtime configuration: API keys and crew options saved in the web app's Admin → Advanced settings.

The web app serves only the values an admin saved (GET /internal/seo-agent/runtime-env); for everything else this
service keeps its own environment. Values are cached for TTL_S seconds, so a key changed in the admin applies within
about a minute without a restart. If the web app cannot be reached, the last known values (or none) are used: a model
call is never blocked on this lookup.
"""

from __future__ import annotations

import dataclasses
import time
from typing import Any

from .config import Settings, _max_iters, _models

TTL_S = 60.0


class RuntimeEnv:
    def __init__(self, web: Any, ttl_s: float = TTL_S):
        self.web = web
        self.ttl_s = ttl_s
        self._at = 0.0
        self._env: dict[str, str] = {}

    async def get(self) -> dict[str, str]:
        fetch = getattr(self.web, "runtime_env", None)
        if fetch is None:
            return {}
        now = time.monotonic()
        if self._at and now - self._at < self.ttl_s:
            return self._env
        try:
            env = await fetch()
            self._env = {k: v for k, v in env.items() if isinstance(k, str) and isinstance(v, str) and v.strip()}
        except Exception:  # noqa: S110 - unreachable web app or an older one without the route: keep the last known values
            pass
        self._at = now
        return self._env

    async def value(self, name: str) -> str | None:
        return (await self.get()).get(name) or None

    def last(self, name: str) -> str | None:
        """The value from the most recent fetch, without a lookup (for synchronous callers that awaited get() first)."""
        return self._env.get(name) or None


_BY_WEB: dict[int, RuntimeEnv] = {}


def runtime_env_for(web: Any) -> RuntimeEnv:
    """One cache per web app client (the container has one; tests have one per fake)."""
    r = _BY_WEB.get(id(web))
    if r is None or r.web is not web:
        if len(_BY_WEB) > 64:
            _BY_WEB.clear()
        r = _BY_WEB[id(web)] = RuntimeEnv(web)
    return r


def apply_overrides(settings: Settings, env: dict[str, str]) -> Settings:
    """Settings with the admin-saved crew options applied. Malformed values are ignored (the deployment's apply)."""
    changes: dict[str, Any] = {}
    models = _models(env.get("SEO_CREW_MODELS", ""))
    if models:
        changes["crew_models"] = {**settings.crew_models, **models}
    iters = _max_iters(env.get("SEO_CREW_MAX_ITERS", ""))
    if iters:
        changes["crew_max_iters"] = {**settings.crew_max_iters, **iters}
    cap = env.get("CREW_MAX_TOKENS_PER_RUN", "").strip()
    if cap.isdigit() and 20_000 <= int(cap) <= 1_000_000:
        changes["crew_max_tokens_per_run"] = int(cap)
    docs = tuple(h.strip().lower() for h in env.get("SEO_AGENT_DOCS_ALLOWLIST", "").replace("\n", ",").split(",") if h.strip())
    if docs:
        changes["docs_allowlist"] = docs
    return dataclasses.replace(settings, **changes) if changes else settings


async def effective_settings(settings: Settings, web: Any) -> Settings:
    return apply_overrides(settings, await runtime_env_for(web).get())
