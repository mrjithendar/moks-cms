"""LLM providers and models (app/llm_providers): the catalog, the rules on a save, sealed keys and the routes.

No test here makes an LLM call or reaches a provider: this change stores set-up only.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.admin_settings import secrets
from app.llm import PRICES
from app.llm_providers import BY_ID, KINDS, NOT_YET_VERIFIED, Invalid, MemoryProviderStore, ProviderIn, check_catalog, enabled_models, overview, save_provider
from app.llm_providers.store import Model, Provider, builtin_price, check, check_base_url, key_state, price_state

KEY = {secrets.KEY_ENV: "k" * 40}
NO_ENV: dict[str, str] = {}


def body(**over: Any) -> ProviderIn:
    return ProviderIn.model_validate({"id": "openai", "kind": "openai", "name": "OpenAI", **over})


# --- Catalog --------------------------------------------------------------------------------------------------


def test_catalog_is_consistent_and_every_named_provider_cites_its_docs() -> None:
    check_catalog()
    assert {"anthropic", "openai", "gemini", "azure_openai", "bedrock", "mistral", "xai", "custom"} == set(BY_ID)
    for k in KINDS:
        if k.id != "custom":
            assert k.docs.startswith("https://") and k.checked, k.id
        assert not hasattr(k, "models") and not hasattr(k, "prices")  # the catalog holds no model list and no price
    assert "Ollama" in NOT_YET_VERIFIED  # named in the plan, not offered by name until its docs are checked


def test_base_url_rules() -> None:
    custom, azure = BY_ID["custom"], BY_ID["azure_openai"]
    assert check_base_url("https://llm.example.com/v1/", custom) == "https://llm.example.com/v1"
    assert check_base_url("http://vllm.ai.svc.cluster.local:8000/v1", custom).startswith("http://")
    for bad in ("ftp://x", "https://user:pw@host/v1", "https://host/v1?key=1", "http://169.254.169.254/latest", "not a url"):
        with pytest.raises(ValueError):
            check_base_url(bad, custom)
    with pytest.raises(ValueError):
        check_base_url("http://res.openai.azure.com", azure)  # plain http only for a custom server


# --- Rules ----------------------------------------------------------------------------------------------------


def test_prices_are_never_invented() -> None:
    m = Model(provider_id="openai", model_id="some-model")
    assert price_state("openai", m) == "missing"
    assert price_state("openai", Model("openai", "some-model", free=True)) == "free"
    assert price_state("openai", Model("openai", "some-model", input_usd=1, output_usd=2)) == "entered"
    known = next(iter(PRICES))
    assert price_state("anthropic", Model("anthropic", known)) == "built-in"
    assert builtin_price("anthropic", f"{known}-20261001") == PRICES[known]  # a dated id of a known family
    assert builtin_price("anthropic", "claude-unknown-9") is None
    assert builtin_price("openai", known) is None  # the built-in table is Anthropic's only


def test_a_model_cannot_be_switched_on_without_a_price() -> None:
    p = Provider(id="openai", kind="openai", name="OpenAI")
    assert any("enter its prices" in i for i in check(p, [Model("openai", "m1", enabled=True)], NO_ENV))
    assert check(p, [Model("openai", "m1", enabled=True, input_usd=1.0, output_usd=4.0)], NO_ENV) == []
    assert check(p, [Model("openai", "m1", enabled=True, free=True)], NO_ENV) == []
    assert any("both the input and the output" in i for i in check(p, [Model("openai", "m1", input_usd=1.0)], NO_ENV))
    assert any("free cannot also have a price" in i for i in check(p, [Model("openai", "m1", free=True, input_usd=1.0, output_usd=1.0)], NO_ENV))
    assert any("listed twice" in i for i in check(p, [Model("openai", "m1"), Model("openai", "m1")], NO_ENV))


def test_a_provider_cannot_be_switched_on_without_what_it_needs() -> None:
    on = Provider(id="openai", kind="openai", name="OpenAI", enabled=True)
    assert any(i.startswith("api_key:") for i in check(on, [], NO_ENV))
    assert check(on, [], {"OPENAI_API_KEY": "sk-from-env"}) == []  # the environment key still counts
    assert any(i.startswith("region:") for i in check(Provider(id="aws", kind="bedrock", name="Bedrock", enabled=True), [], NO_ENV))
    assert check(Provider(id="aws", kind="bedrock", name="Bedrock", enabled=True, region="us-east-1"), [], NO_ENV) == []  # no key: the pod's credentials
    assert any(i.startswith("base_url:") for i in check(Provider(id="vllm", kind="custom", name="vLLM", enabled=True), [], NO_ENV))
    assert check(Provider(id="vllm", kind="custom", name="vLLM", enabled=True, base_url="http://vllm:8000/v1"), [], NO_ENV) == []  # a local server needs no key
    assert any("fixed address" in i for i in check(Provider(id="openai", kind="openai", name="x", base_url="https://evil.example"), [], NO_ENV))
    assert any("one OpenAI provider" in i for i in check(Provider(id="openai2", kind="openai", name="x"), [], NO_ENV))
    assert check(Provider(id="nope", kind="nope", name="x"), [], NO_ENV) == ["kind: unknown provider kind 'nope'"]
    assert any("cannot be switched off yet" in i for i in check(Provider(id="anthropic", kind="anthropic", name="Anthropic"), [], NO_ENV))


def test_key_state_never_holds_the_key() -> None:
    assert key_state(Provider("openai", "openai", "x"), NO_ENV) == "none"
    assert key_state(Provider("openai", "openai", "x"), {"OPENAI_API_KEY": "sk-1"}) == "env"
    assert key_state(Provider("openai", "openai", "x", key_sealed=secrets.seal("sk-1", KEY)), NO_ENV) == "saved"
    assert key_state(Provider("aws", "bedrock", "x"), NO_ENV) == "not_needed"


# --- Saving ---------------------------------------------------------------------------------------------------


async def test_anthropic_is_present_before_anything_is_saved() -> None:
    store = MemoryProviderStore()
    o = await overview(store, {"ANTHROPIC_API_KEY": "sk-ant-env"})
    (a,) = o["providers"]
    assert a["id"] == "anthropic" and a["enabled"] and a["key"] == "env" and a["saved"] is False and a["issues"] == []
    assert {m["model_id"] for m in a["models"]} == set(PRICES)
    assert all(m["price_state"] == "built-in" and m["enabled"] for m in a["models"])
    assert {m["model_id"] for m in await enabled_models(store)} == set(PRICES)
    assert len(o["kinds"]) == len(KINDS)


async def test_a_key_is_sealed_and_never_comes_back() -> None:
    store = MemoryProviderStore()
    secret = "sk-test-not-a-real-key-123456"
    changed = await save_provider(store, body(api_key=secret, enabled=True, models=[{"model_id": "m1", "enabled": True, "input_usd": 1, "output_usd": 4}]), KEY)
    assert changed == {"id": "openai", "created": True, "enabled": True, "key_changed": True, "models": 1}
    saved = store.p["openai"]
    assert secrets.is_sealed(saved.key_sealed) and secret not in repr(saved.key_sealed)
    assert secrets.unseal(saved.key_sealed, KEY) == secret
    o = await overview(store, KEY)
    assert secret not in repr(o) and "key_sealed" not in repr(o)
    openai = next(p for p in o["providers"] if p["id"] == "openai")
    assert openai["key"] == "saved" and openai["models"][0]["price_state"] == "entered"
    # None keeps the key, "" removes it (and an enabled provider without a key is then refused).
    await save_provider(store, body(enabled=True, name="OpenAI (work)"), KEY)
    assert secrets.unseal(store.p["openai"].key_sealed, KEY) == secret and store.p["openai"].name == "OpenAI (work)"
    assert len(store.m) == 1  # models not sent: left as they were
    with pytest.raises(Invalid) as e:
        await save_provider(store, body(enabled=True, api_key=""), KEY)
    assert any(i.startswith("api_key:") for i in e.value.issues)
    assert store.p["openai"].key_sealed is not None  # a refused save changes nothing


async def test_a_key_cannot_be_stored_without_the_sealing_key() -> None:
    store = MemoryProviderStore()
    with pytest.raises(Invalid) as e:
        await save_provider(store, body(api_key="sk-1"), NO_ENV)
    assert secrets.KEY_ENV in e.value.issues[0] and store.p == {}
    with pytest.raises(Invalid):
        await save_provider(store, ProviderIn.model_validate({"id": "aws", "kind": "bedrock", "name": "Bedrock", "api_key": "x"}), KEY)  # takes no key


async def test_models_sent_replace_the_list_and_a_kind_cannot_change() -> None:
    store = MemoryProviderStore()
    await save_provider(store, body(models=[{"model_id": "a"}, {"model_id": "b", "free": True, "enabled": True}]), KEY)
    await save_provider(store, body(models=[{"model_id": "b", "free": True, "enabled": True}]), KEY)
    assert [k[1] for k in store.m] == ["b"]
    assert await enabled_models(store) and all(m["provider_id"] == "anthropic" for m in await enabled_models(store))  # openai itself is off
    with pytest.raises(Invalid) as e:
        await save_provider(store, ProviderIn.model_validate({"id": "openai", "kind": "mistral", "name": "x"}), KEY)
    assert any("kind cannot change" in i for i in e.value.issues)


async def test_first_save_of_anthropic_keeps_the_built_in_models() -> None:
    store = MemoryProviderStore()
    await save_provider(
        store, ProviderIn.model_validate({"id": "anthropic", "kind": "anthropic", "name": "Anthropic", "enabled": True}), {"ANTHROPIC_API_KEY": "sk-ant-env"}
    )
    assert {k[1] for k in store.m} == set(PRICES)
    with pytest.raises(Invalid):
        await save_provider(
            store,
            ProviderIn.model_validate({"id": "anthropic", "kind": "anthropic", "name": "Anthropic", "enabled": False}),
            {"ANTHROPIC_API_KEY": "sk-ant-env"},
        )


def test_input_is_strict() -> None:
    for bad in ({"id": "Open AI"}, {"extra": 1}, {"models": [{"model_id": "m", "input_usd": -1}]}, {"models": [{"model_id": "bad id"}]}, {"region": "US EAST"}):
        with pytest.raises(ValidationError):
            body(**bad)


# --- Routes ---------------------------------------------------------------------------------------------------


def test_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from app.llm import BudgetGuard, MemorySpendStore
    from app.main import create_app, memory_container
    from tests.conftest import FakeLlm, FakeWebApp, settings

    monkeypatch.setenv(secrets.KEY_ENV, "k" * 40)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    c = memory_container(settings(), llm=FakeLlm(BudgetGuard(MemorySpendStore(), None, 1)), web=FakeWebApp())
    auth = {"Authorization": "Bearer " + "t" * 40}
    secret = "sk-test-not-a-real-key-abcdef"
    with TestClient(create_app(c)) as client:
        assert (
            client.get("/llm-providers").status_code == 401
            and client.put("/llm-providers", json={}).status_code == 401
            and client.get("/llm-models").status_code == 401
        )
        first = client.get("/llm-providers", headers=auth).json()
        assert [p["id"] for p in first["providers"]] == ["anthropic"] and first["can_store_keys"] is True
        bad = client.put(
            "/llm-providers",
            headers=auth,
            json={"id": "openai", "kind": "openai", "name": "OpenAI", "enabled": True, "api_key": secret, "models": [{"model_id": "m1", "enabled": True}]},
        )
        assert bad.status_code == 422 and any("enter its prices" in i for i in bad.json()["issues"]) and secret not in bad.text
        junk = client.put("/llm-providers", headers=auth, json={"id": "openai", "kind": "openai", "name": "OpenAI", "api_key": secret, "nope": 1})
        assert junk.status_code == 422 and secret not in junk.text  # a rejected body is not echoed
        ok = client.put(
            "/llm-providers",
            headers=auth,
            json={
                "id": "openai",
                "kind": "openai",
                "name": "OpenAI",
                "enabled": True,
                "api_key": secret,
                "actor": "admin@example.com",
                "models": [{"model_id": "m1", "enabled": True, "input_usd": 1, "output_usd": 4}],
            },
        )
        assert ok.status_code == 200 and secret not in ok.text
        assert ok.json()["saved"] == {"id": "openai", "created": True, "enabled": True, "key_changed": True, "models": 1}
        models = client.get("/llm-models", headers=auth).json()["models"]
        assert {"openai"} <= {m["provider_id"] for m in models} and secret not in client.get("/llm-providers", headers=auth).text


# --- Fetch models ---------------------------------------------------------------------------------------------


def _client(handler: Any) -> Any:
    import httpx

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_fetch_models_openai_compatible_marks_what_is_already_listed() -> None:
    import httpx

    from app.llm_providers.discover import discover

    store = MemoryProviderStore()
    secret = "sk-test-not-a-real-key-discover"
    await save_provider(store, body(api_key=secret, models=[{"model_id": "b", "enabled": True, "input_usd": 1, "output_usd": 2}]), KEY)
    seen: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"object": "list", "data": [{"id": "b"}, {"id": "a"}]})

    out = await discover(store, "openai", KEY, _client(handler))
    assert out == {"provider_id": "openai", "count": 2, "models": [{"model_id": "a", "label": "", "listed": False, "enabled": False}, {"model_id": "b", "label": "", "listed": True, "enabled": True}]}
    assert str(seen[0].url) == "https://api.openai.com/v1/models" and seen[0].headers["authorization"] == f"Bearer {secret}"
    assert [k[1] for k in store.m] == ["b"]  # nothing was saved or switched on


async def test_fetch_models_anthropic_pages_and_uses_the_environment_key() -> None:
    import httpx

    from app.llm_providers.discover import discover

    pages = [
        {"data": [{"id": "claude-b", "display_name": "Claude B", "type": "model"}], "has_more": True, "last_id": "claude-b"},
        {"data": [{"id": "claude-a", "display_name": "Claude A", "type": "model"}], "has_more": False, "last_id": "claude-a"},
    ]
    seen: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=pages[len(seen) - 1])

    out = await discover(MemoryProviderStore(), "anthropic", {"ANTHROPIC_API_KEY": "sk-ant-env"}, _client(handler))
    assert [m["model_id"] for m in out["models"]] == ["claude-a", "claude-b"] and out["models"][0]["label"] == "Claude A"
    assert seen[0].headers["x-api-key"] == "sk-ant-env" and seen[0].headers["anthropic-version"] == "2023-06-01"
    assert "after_id=claude-b" in str(seen[1].url) and len(seen) == 2


async def test_fetch_models_says_why_it_cannot() -> None:
    import httpx

    from app.llm_providers.discover import CannotDiscover, discover

    store = MemoryProviderStore()
    with pytest.raises(LookupError):
        await discover(store, "nope", NO_ENV)
    await save_provider(store, body(), NO_ENV)
    with pytest.raises(CannotDiscover, match="API key first"):
        await discover(store, "openai", NO_ENV)
    await save_provider(store, ProviderIn.model_validate({"id": "aws", "kind": "bedrock", "name": "Bedrock"}), NO_ENV)
    with pytest.raises(CannotDiscover, match="not available yet"):
        await discover(store, "aws", NO_ENV)
    await save_provider(store, ProviderIn.model_validate({"id": "vllm", "kind": "custom", "name": "vLLM"}), NO_ENV)
    with pytest.raises(CannotDiscover, match="base URL first"):
        await discover(store, "vllm", NO_ENV)
    secret = "sk-test-not-a-real-key-denied"
    await save_provider(store, body(api_key=secret), KEY)
    with pytest.raises(CannotDiscover) as e:
        await discover(store, "openai", KEY, _client(lambda r: httpx.Response(401, json={"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}})))
    assert e.value.status == 502 and secret not in str(e.value)
    with pytest.raises(CannotDiscover, match="cannot be read"):
        await discover(store, "openai", {secrets.KEY_ENV: "z" * 40})  # sealed with another key
