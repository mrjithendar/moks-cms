"""Providers and models an admin has set up, with sealed keys and admin-entered prices.

Two tables in this service's own schema (created by ensure_schema):

- seo_agent_llm_providers: one row per provider (its kind from catalog.py, a name, on/off, endpoint fields, the API
  key sealed with SEO_AGENT_SETTINGS_KEY). A key is write-only: it is never returned, logged or sent to the browser.
- seo_agent_llm_models: one row per model of a provider (on/off, prices per million tokens, limits, capabilities).

Rules that are enforced on every save, here and not in the browser:

- No price is ever invented. A model cannot be switched on until its input and output prices are entered, unless
  it is a Claude model with a built-in price (app/llm.py PRICES) or the admin marks it free (a local model).
- A provider cannot be switched on without what its kind needs (a base URL, a region, a key or its env fallback).
- Anthropic is always present, as it is what this service calls today: unsaved, it is shown with the environment
  key and the built-in Claude models.

Nothing in this module makes an LLM call, and nothing reads these tables at call time yet: the adapters and the
"model for each job" routing come in later changes.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Protocol
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..admin_settings import secrets
from .catalog import BY_ID, Kind, kinds_out

log = logging.getLogger("seo_agent.llm_providers")

PROVIDERS = "seo_agent_llm_providers"
MODELS = "seo_agent_llm_models"
MAX_PRICE = 10_000.0  # USD per million tokens
ID_RE = r"^[a-z][a-z0-9_-]{1,39}$"

DDL = f"""
create table if not exists {PROVIDERS} (
    id text primary key,
    kind text not null,
    name text not null,
    enabled boolean not null default false,
    base_url text not null default '',
    region text not null default '',
    deployment text not null default '',
    api_version text not null default '',
    key_sealed jsonb,
    updated_by text,
    updated_at timestamptz not null default now());
create table if not exists {MODELS} (
    provider_id text not null references {PROVIDERS}(id) on delete cascade,
    model_id text not null,
    label text not null default '',
    enabled boolean not null default false,
    free boolean not null default false,
    input_usd double precision check (input_usd >= 0),
    output_usd double precision check (output_usd >= 0),
    cache_read_usd double precision check (cache_read_usd >= 0),
    cache_write_usd double precision check (cache_write_usd >= 0),
    context_window integer check (context_window > 0),
    max_output integer check (max_output > 0),
    structured_output boolean not null default false,
    tools boolean not null default false,
    vision boolean not null default false,
    updated_by text,
    updated_at timestamptz not null default now(),
    primary key (provider_id, model_id));
"""


@dataclass(frozen=True)
class Provider:
    id: str
    kind: str
    name: str
    enabled: bool = False
    base_url: str = ""
    region: str = ""
    deployment: str = ""
    api_version: str = ""
    key_sealed: dict[str, Any] | None = None


@dataclass(frozen=True)
class Model:
    provider_id: str
    model_id: str
    label: str = ""
    enabled: bool = False
    free: bool = False
    input_usd: float | None = None
    output_usd: float | None = None
    cache_read_usd: float | None = None
    cache_write_usd: float | None = None
    context_window: int | None = None
    max_output: int | None = None
    structured_output: bool = False
    tools: bool = False
    vision: bool = False


# --- What the admin sends -------------------------------------------------------------------------------------


def check_base_url(url: str, kind: Kind) -> str:
    """https everywhere; plain http only for a custom server inside the cluster or on the host. Never a URL that
    carries credentials, and never the cloud metadata address."""
    u = urlsplit(url)
    if u.scheme not in ("https", "http") or not u.hostname:
        raise ValueError("enter a full URL starting with https://")
    if u.username or u.password or "@" in u.netloc:
        raise ValueError("a URL must not carry a user name or a password; the key has its own field")
    if u.query or u.fragment:
        raise ValueError("leave out anything after ? or #")
    if u.scheme == "http" and kind.id != "custom":
        raise ValueError("use https://")
    try:
        ip = ipaddress.ip_address(u.hostname)
    except ValueError:
        ip = None
    if ip is not None and (ip.is_link_local or ip.is_multicast or ip.is_unspecified):
        raise ValueError("this address is not allowed")
    return url.rstrip("/")


class ModelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_id: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/@-]*$")
    label: str = Field(default="", max_length=120)
    enabled: bool = False
    free: bool = False
    input_usd: float | None = Field(default=None, ge=0, le=MAX_PRICE)
    output_usd: float | None = Field(default=None, ge=0, le=MAX_PRICE)
    cache_read_usd: float | None = Field(default=None, ge=0, le=MAX_PRICE)
    cache_write_usd: float | None = Field(default=None, ge=0, le=MAX_PRICE)
    context_window: int | None = Field(default=None, gt=0, le=100_000_000)
    max_output: int | None = Field(default=None, gt=0, le=10_000_000)
    structured_output: bool = False
    tools: bool = False
    vision: bool = False

    @field_validator("label")
    @classmethod
    def _label(cls, v: str) -> str:
        return v.strip()


class ProviderIn(BaseModel):
    """One provider and, when `models` is sent, the complete list of its models (a model left out is removed)."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=ID_RE)
    kind: str
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = False
    base_url: str = Field(default="", max_length=300)
    region: str = Field(default="", max_length=40, pattern=r"^[a-z0-9-]*$")
    deployment: str = Field(default="", max_length=120, pattern=r"^[A-Za-z0-9._-]*$")
    api_version: str = Field(default="", max_length=40, pattern=r"^[A-Za-z0-9._-]*$")
    # Write-only. None = keep what is saved. "" = remove the saved key. Anything else = seal and store it.
    api_key: str | None = Field(default=None, max_length=4000)
    models: list[ModelIn] | None = Field(default=None, max_length=500)
    actor: str | None = Field(default=None, max_length=200)

    @field_validator("name", "base_url")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class Invalid(Exception):
    def __init__(self, issues: list[str]):
        super().__init__("; ".join(issues))
        self.issues = issues


# --- Rules ----------------------------------------------------------------------------------------------------


def builtin_price(kind: str, model_id: str) -> dict[str, float] | None:
    """The built-in Claude price for a model of the Anthropic provider, else None. Exact ids and dated ids of a
    known family only: an unknown Claude model has no price here."""
    if kind != "anthropic":
        return None
    from ..llm import PRICES  # imported here: app.llm imports this package's siblings at start-up

    if model_id in PRICES:
        return PRICES[model_id]
    family = max((k for k in PRICES if model_id.startswith(f"{k}-")), key=len, default=None)
    return PRICES[family] if family else None


def price_state(kind: str, m: Model) -> str:
    """entered: the admin's prices. built-in: Claude's list price. free: marked free. missing: cannot be enabled."""
    if m.input_usd is not None and m.output_usd is not None:
        return "entered"
    if m.free:
        return "free"
    return "built-in" if builtin_price(kind, m.model_id) else "missing"


def key_state(p: Provider, env: Mapping[str, str] | None = None) -> str:
    """saved | env | none | not_needed. Never the key."""
    kind = BY_ID.get(p.kind)
    if kind is None or kind.auth in ("aws", "none"):
        return "not_needed"
    if p.key_sealed is not None:
        return "saved"
    return "env" if kind.env_key and (os.environ if env is None else env).get(kind.env_key, "").strip() else "none"


def check(p: Provider, models: list[Model], env: Mapping[str, str] | None = None) -> list[str]:
    """Everything that is wrong with a provider as it would be saved. Empty = it may be saved."""
    kind = BY_ID.get(p.kind)
    if kind is None:
        return [f"kind: unknown provider kind {p.kind!r}"]
    issues: list[str] = []
    if p.id == "anthropic" and p.kind != "anthropic":
        issues.append("id: 'anthropic' is the built-in Anthropic provider")
    if p.id == "anthropic" and not p.enabled:
        issues.append("enabled: Anthropic cannot be switched off yet: every job still calls it until a model is chosen for each job")
    if not kind.many and p.id != kind.id:
        issues.append(f"id: there is one {kind.label} provider and its id is {kind.id!r}")
    if kind.base_url_editable:
        if p.base_url:
            try:
                check_base_url(p.base_url, kind)
            except ValueError as e:
                issues.append(f"base_url: {e}")
        elif p.enabled:
            issues.append("base_url: enter the base URL before switching this provider on")
    elif p.base_url and p.base_url != kind.base_url:
        issues.append(f"base_url: {kind.label} has a fixed address")
    for need in kind.needs:
        if need == "deployment":
            continue  # a deployment is the model id of an Azure model row; the provider field is only a default
        if p.enabled and not getattr(p, need):
            issues.append(f"{need}: {kind.label} needs it before it is switched on")
    if p.enabled and kind.id != "custom" and key_state(p, env) == "none":
        issues.append("api_key: enter the API key before switching this provider on")
    seen: set[str] = set()
    for m in models:
        if m.model_id in seen:
            issues.append(f"models.{m.model_id}: listed twice")
        seen.add(m.model_id)
        if (m.input_usd is None) != (m.output_usd is None):
            issues.append(f"models.{m.model_id}: enter both the input and the output price, or neither")
        if m.free and (m.input_usd or m.output_usd):
            issues.append(f"models.{m.model_id}: a model marked free cannot also have a price")
        if m.enabled and price_state(p.kind, m) == "missing":
            issues.append(f"models.{m.model_id}: enter its prices (USD per million tokens) or mark it free before switching it on")
    return issues


# --- Stores ---------------------------------------------------------------------------------------------------


class ProviderStore(Protocol):
    async def ensure_schema(self) -> None: ...
    async def providers(self) -> list[Provider]: ...
    async def models(self) -> list[Model]: ...
    async def save(self, provider: Provider, models: list[Model] | None, actor: str | None) -> None: ...


@dataclass
class MemoryProviderStore:
    """Tests and the in-memory mode without a database."""

    p: dict[str, Provider] = field(default_factory=dict)
    m: dict[tuple[str, str], Model] = field(default_factory=dict)

    async def ensure_schema(self) -> None:
        return None

    async def providers(self) -> list[Provider]:
        return sorted(self.p.values(), key=lambda x: x.id)

    async def models(self) -> list[Model]:
        return sorted(self.m.values(), key=lambda x: (x.provider_id, x.model_id))

    async def save(self, provider: Provider, models: list[Model] | None, actor: str | None) -> None:
        self.p[provider.id] = provider
        if models is not None:
            for k in [k for k in self.m if k[0] == provider.id]:
                del self.m[k]
            for x in models:
                self.m[(provider.id, x.model_id)] = x


_P_COLS = "id, kind, name, enabled, base_url, region, deployment, api_version, key_sealed"
_M_COLS = "provider_id, model_id, label, enabled, free, input_usd, output_usd, cache_read_usd, cache_write_usd, context_window, max_output, structured_output, tools, vision"


class PgProviderStore:
    def __init__(self, pool: Any):
        self.pool = pool

    async def ensure_schema(self) -> None:
        async with self.pool.connection() as c:
            await c.execute(DDL)

    async def providers(self) -> list[Provider]:
        async with self.pool.connection() as c:
            cur = await c.execute(f"select {_P_COLS} from {PROVIDERS} order by id")  # noqa: S608 - constant names
            return [Provider(**dict(r)) for r in await cur.fetchall()]

    async def models(self) -> list[Model]:
        async with self.pool.connection() as c:
            cur = await c.execute(f"select {_M_COLS} from {MODELS} order by provider_id, model_id")  # noqa: S608 - constant names
            return [Model(**dict(r)) for r in await cur.fetchall()]

    async def save(self, provider: Provider, models: list[Model] | None, actor: str | None) -> None:
        from psycopg.types.json import Jsonb

        p = provider
        upsert_p = (
            f"insert into {PROVIDERS} ({_P_COLS}, updated_by) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "  # noqa: S608 - constant names
            "on conflict (id) do update set kind = excluded.kind, name = excluded.name, enabled = excluded.enabled, base_url = excluded.base_url,"
            " region = excluded.region, deployment = excluded.deployment, api_version = excluded.api_version, key_sealed = excluded.key_sealed,"
            " updated_by = excluded.updated_by, updated_at = now()"
        )
        insert_m = f"insert into {MODELS} ({_M_COLS}, updated_by) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"  # noqa: S608 - constant names
        delete_m = f"delete from {MODELS} where provider_id = %s"  # noqa: S608 - constant name
        async with self.pool.connection() as c, c.transaction():
            sealed = Jsonb(p.key_sealed) if p.key_sealed is not None else None
            await c.execute(upsert_p, (p.id, p.kind, p.name, p.enabled, p.base_url, p.region, p.deployment, p.api_version, sealed, actor))
            if models is not None:
                await c.execute(delete_m, (p.id,))
                for m in models:
                    await c.execute(
                        insert_m,
                        (
                            p.id,
                            m.model_id,
                            m.label,
                            m.enabled,
                            m.free,
                            m.input_usd,
                            m.output_usd,
                            m.cache_read_usd,
                            m.cache_write_usd,
                            m.context_window,
                            m.max_output,
                            m.structured_output,
                            m.tools,
                            m.vision,
                            actor,
                        ),
                    )


# --- Views and saving -----------------------------------------------------------------------------------------


def _builtin_anthropic() -> tuple[Provider, list[Model]]:
    from ..llm import PRICES

    kind = BY_ID["anthropic"]
    return (
        Provider(id="anthropic", kind="anthropic", name=kind.label, enabled=True, base_url=kind.base_url),
        [Model(provider_id="anthropic", model_id=mid, enabled=True, structured_output=True, tools=True, vision=True) for mid in sorted(PRICES)],
    )


async def load(store: ProviderStore) -> tuple[list[Provider], list[Model]]:
    """What is saved, with Anthropic and the built-in Claude models filled in where nothing is saved for them."""
    providers, models = await store.providers(), await store.models()
    if not any(p.id == "anthropic" for p in providers):
        builtin_p, builtin_m = _builtin_anthropic()
        providers = sorted([*providers, builtin_p], key=lambda x: x.id)
        models = sorted([*models, *builtin_m], key=lambda x: (x.provider_id, x.model_id))
    return providers, models


def model_out(kind: str, m: Model) -> dict[str, Any]:
    state = price_state(kind, m)
    builtin = builtin_price(kind, m.model_id)
    return {
        "provider_id": m.provider_id,
        "model_id": m.model_id,
        "label": m.label or m.model_id,
        "enabled": m.enabled,
        "free": m.free,
        "price_state": state,
        "prices": {"input": m.input_usd, "output": m.output_usd, "cache_read": m.cache_read_usd, "cache_write": m.cache_write_usd},
        "builtin_prices": builtin,
        "context_window": m.context_window,
        "max_output": m.max_output,
        "capabilities": {"structured_output": m.structured_output, "tools": m.tools, "vision": m.vision},
    }


async def overview(store: ProviderStore, env: Mapping[str, str] | None = None) -> dict[str, Any]:
    providers, models = await load(store)
    saved = {p.id for p in await store.providers()}
    out = []
    for p in providers:
        kind = BY_ID.get(p.kind)
        mine = [m for m in models if m.provider_id == p.id]
        out.append(
            {
                "id": p.id,
                "kind": p.kind,
                "kind_label": kind.label if kind else p.kind,
                "name": p.name,
                "enabled": p.enabled,
                "base_url": p.base_url or (kind.base_url if kind else ""),
                "region": p.region,
                "deployment": p.deployment,
                "api_version": p.api_version,
                "key": key_state(p, env),  # saved | env | none | not_needed: never the key itself
                "saved": p.id in saved,
                "issues": check(p, mine, env),
                "models": [model_out(p.kind, m) for m in mine],
            }
        )
    return {"kinds": kinds_out(), "providers": out, "can_store_keys": secrets.available(env), "key_env": secrets.KEY_ENV}


async def enabled_models(store: ProviderStore) -> list[dict[str, Any]]:
    """For pickers: models that are on, of providers that are on."""
    providers, models = await load(store)
    on = {p.id: p for p in providers if p.enabled}
    return [{**model_out(on[m.provider_id].kind, m), "provider_name": on[m.provider_id].name} for m in models if m.enabled and m.provider_id in on]


async def save_provider(store: ProviderStore, body: ProviderIn, env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Validates and saves one provider (and its models when sent), all or nothing. Raises Invalid with the issues.
    Returns what changed, by name only: never a key."""
    existing = {p.id: p for p in await store.providers()}
    before = existing.get(body.id)
    issues: list[str] = []
    if before is not None and before.kind != body.kind:
        issues.append("kind: a provider's kind cannot change; add another provider instead")
    kind = BY_ID.get(body.kind)
    sealed = before.key_sealed if before else None
    if body.api_key is not None:
        key = body.api_key.strip()
        if key == "":
            sealed = None
        elif kind is not None and kind.auth in ("aws", "none"):
            issues.append("api_key: this provider does not take a key")
        elif not secrets.available(env):
            issues.append(f"api_key: a key cannot be stored until {secrets.KEY_ENV} is set on the seo-agent")
        elif re.search(r"\s", key):
            issues.append("api_key: a key has no spaces or line breaks")
        else:
            sealed = secrets.seal(key, env)
    base_url = body.base_url
    if kind is not None and not kind.base_url_editable:
        base_url = kind.base_url
    provider = Provider(
        id=body.id,
        kind=body.kind,
        name=body.name,
        enabled=body.enabled,
        base_url=base_url.rstrip("/"),
        region=body.region,
        deployment=body.deployment,
        api_version=body.api_version,
        key_sealed=sealed,
    )
    if body.models is not None:
        models: list[Model] | None = [Model(provider_id=body.id, **m.model_dump()) for m in body.models]
        to_check = models or []
    else:
        models = None
        to_check = [m for m in (await load(store))[1] if m.provider_id == body.id]
    issues += check(provider, to_check, env)
    if issues:
        raise Invalid(issues)
    if models is None and before is None and body.id == "anthropic":
        models = [replace(m) for m in _builtin_anthropic()[1]]  # first save of Anthropic keeps the built-in models
    await store.save(provider, models, body.actor)
    return {
        "id": provider.id,
        "created": before is None,
        "enabled": provider.enabled,
        "key_changed": body.api_key is not None,
        "models": None if models is None else len(models),
    }
