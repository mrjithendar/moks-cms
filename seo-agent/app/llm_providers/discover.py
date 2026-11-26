""""Fetch models": ask a provider which models it has. Nothing is saved and no model is switched on: the admin picks.

Listing models is not an LLM call and costs nothing, so the budget is not involved.

- OpenAI-compatible kinds: `GET {base_url}/models` through the adapter (app/llm_adapters/openai_compat.py).
- Anthropic: `GET https://api.anthropic.com/v1/models` with `x-api-key` and `anthropic-version: 2023-06-01`, paged
  with `after_id` while `has_more` (https://platform.claude.com/docs/en/api/models-list, checked 2026-11-21).
- Gemini, Azure OpenAI, Bedrock: not here yet. Their models are added by hand.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

import httpx

from ..admin_settings import secrets
from ..llm_adapters import Endpoint, OpenAICompat, ProviderError
from .catalog import BY_ID, Kind
from .store import Provider, ProviderStore, load

ANTHROPIC_VERSION = "2023-06-01"
MAX_PAGES = 10


class CannotDiscover(Exception):
    """Why the list could not be fetched, in words for the admin. Never holds a key."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def api_key(p: Provider, kind: Kind, env: Mapping[str, str] | None = None) -> str | None:
    """The saved key, else the environment's, else None. Raises CannotDiscover when a saved key cannot be read."""
    if kind.auth in ("aws", "none"):
        return None
    if p.key_sealed is not None:
        try:
            return secrets.unseal(p.key_sealed, env)
        except (secrets.NoKey, secrets.Unreadable) as e:
            raise CannotDiscover(f"the saved key cannot be read ({e}); enter it again") from e
    value = (os.environ if env is None else env).get(kind.env_key, "").strip() if kind.env_key else ""
    return value or None


async def _anthropic(key: str, client: httpx.AsyncClient) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    after: str | None = None
    for _ in range(MAX_PAGES):
        params = {"limit": "1000", **({"after_id": after} if after else {})}
        try:
            res = await client.get("https://api.anthropic.com/v1/models", headers={"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION}, params=params)
        except httpx.HTTPError as e:
            raise CannotDiscover(f"Anthropic could not be reached ({type(e).__name__})", 502) from e
        if res.status_code >= 400:
            raise CannotDiscover(f"Anthropic answered HTTP {res.status_code}", 502)
        try:
            body = res.json()
            for m in body["data"]:
                if isinstance(m, dict) and isinstance(m.get("id"), str):
                    out.append({"model_id": m["id"], "label": m.get("display_name") if isinstance(m.get("display_name"), str) else ""})
        except (ValueError, KeyError, TypeError) as e:
            raise CannotDiscover("Anthropic's model list could not be read", 502) from e
        if not body.get("has_more") or not isinstance(body.get("last_id"), str):
            break
        after = body["last_id"]
    return out


async def discover(store: ProviderStore, provider_id: str, env: Mapping[str, str] | None = None, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """The provider's models, each marked with whether it is already in the admin's list. LookupError: no such provider."""
    providers, models = await load(store)
    p = next((x for x in providers if x.id == provider_id), None)
    if p is None:
        raise LookupError(provider_id)
    kind = BY_ID.get(p.kind)
    if kind is None:
        raise CannotDiscover(f"unknown provider kind {p.kind!r}")
    if kind.adapter not in ("anthropic", "openai_compat"):
        raise CannotDiscover(f"{kind.label}: fetching models is not available yet. Add its models by hand.")
    base_url = p.base_url or kind.base_url
    if not base_url:
        raise CannotDiscover("enter and save the base URL first")
    key = api_key(p, kind, env)
    if key is None and kind.id != "custom":
        raise CannotDiscover("enter and save the API key first")
    own = client is None
    http = client or httpx.AsyncClient(timeout=20.0)
    try:
        if kind.adapter == "anthropic":
            assert key is not None
            found = await _anthropic(key, http)
        else:
            try:
                ids = await OpenAICompat(Endpoint(base_url=base_url, api_key=key, auth="bearer" if key else "none", timeout_s=20.0), client=http).list_models()
            except ProviderError as e:
                raise CannotDiscover(f"{kind.label}: {e}", 502) from e
            found = [{"model_id": i, "label": ""} for i in ids]
    finally:
        if own:
            await http.aclose()
    mine = {m.model_id: m for m in models if m.provider_id == p.id}
    found.sort(key=lambda m: m["model_id"])
    return {
        "provider_id": p.id,
        "models": [{**m, "listed": m["model_id"] in mine, "enabled": bool(mine.get(m["model_id"]) and mine[m["model_id"]].enabled)} for m in found],
        "count": len(found),
    }
