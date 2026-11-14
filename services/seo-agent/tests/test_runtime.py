"""Admin-managed runtime configuration (app/runtime.py): caching, fallbacks, crew overrides, API key refresh."""

from __future__ import annotations

from typing import Any

from app.llm import AnthropicLlm, BudgetGuard, MemorySpendStore
from app.runtime import RuntimeEnv, apply_overrides, effective_settings, runtime_env_for
from tests.conftest import settings


class Web:
    def __init__(self, env: dict[str, Any] | None = None, fail: bool = False):
        self.env, self.fail, self.calls = env or {}, fail, 0

    async def runtime_env(self) -> dict[str, Any]:
        self.calls += 1
        if self.fail:
            raise RuntimeError("web app down")
        return self.env


async def test_values_are_cached_and_a_failed_lookup_keeps_the_last_known_values() -> None:
    web = Web({"ANTHROPIC_API_KEY": "sk-ant-admin", "EMPTY": " ", "N": 3})
    r = RuntimeEnv(web, ttl_s=1000)
    assert await r.get() == {"ANTHROPIC_API_KEY": "sk-ant-admin"} and await r.value("ANTHROPIC_API_KEY") == "sk-ant-admin"
    assert web.calls == 1 and r.last("ANTHROPIC_API_KEY") == "sk-ant-admin" and await r.value("MISSING") is None
    r.ttl_s, web.fail = 0, True
    assert await r.get() == {"ANTHROPIC_API_KEY": "sk-ant-admin"} and web.calls == 2  # the outage changes nothing


async def test_a_web_app_without_the_route_means_no_overrides() -> None:
    assert await RuntimeEnv(object()).get() == {}
    s = settings()
    assert await effective_settings(s, object()) is s


def test_crew_overrides_merge_over_the_deployment_and_ignore_malformed_values() -> None:
    s = settings(crew_models={"optimization.analyst": "claude-haiku-5-5"}, crew_max_iters={"editorial.writer": 6})
    o = apply_overrides(s, {"SEO_CREW_MODELS": '{"editorial.writer":"claude-opus-5-5","x":"gpt-4"}', "SEO_CREW_MAX_ITERS": '{"editorial.researcher":12,"editorial.writer":99}', "CREW_MAX_TOKENS_PER_RUN": "250000", "SEO_AGENT_DOCS_ALLOWLIST": "Kubernetes.io,\n helm.sh"})
    assert o.crew_models == {"optimization.analyst": "claude-haiku-5-5", "editorial.writer": "claude-opus-5-5"}
    assert o.crew_max_iters == {"editorial.writer": 6, "editorial.researcher": 12}
    assert o.crew_max_tokens_per_run == 250_000 and o.docs_allowlist == ("kubernetes.io", "helm.sh")
    assert apply_overrides(s, {"SEO_CREW_MODELS": "not json", "CREW_MAX_TOKENS_PER_RUN": "5", "SEO_AGENT_DOCS_ALLOWLIST": " "}) is s


def test_one_cache_per_web_app_client() -> None:
    a, b = Web(), Web()
    assert runtime_env_for(a) is runtime_env_for(a) and runtime_env_for(a) is not runtime_env_for(b)


async def test_the_admin_saved_key_replaces_the_client_and_clearing_it_restores_the_deployment_key() -> None:
    keys: list[str | None] = ["sk-ant-admin-key"]

    async def provider() -> str | None:
        if keys[0] == "boom":
            raise RuntimeError("lookup failed")
        return keys[0]

    llm = AnthropicLlm("sk-ant-deploy-key", BudgetGuard(MemorySpendStore(), 10, 1), key_provider=provider)
    first = llm.client
    await llm._refresh_key()
    assert llm.client is not first and llm.client.api_key == "sk-ant-admin-key"
    admin = llm.client
    await llm._refresh_key()
    assert llm.client is admin  # unchanged key: the client is kept
    keys[0] = "boom"
    await llm._refresh_key()
    assert llm.client is admin  # a failed lookup changes nothing
    keys[0] = None
    await llm._refresh_key()
    assert llm.client.api_key == "sk-ant-deploy-key"


async def test_an_injected_client_is_never_replaced() -> None:
    async def provider() -> str | None:
        return "sk-ant-admin-key"

    client = object()
    llm = AnthropicLlm("k", BudgetGuard(MemorySpendStore(), 10, 1), client=client, key_provider=provider)
    await llm._refresh_key()
    assert llm.client is client


def test_topic_discovery_is_a_cron_job_flow_and_not_startable_over_mcp() -> None:
    from app.flows import CRON_FLOWS, MCP_KICKOFF_ALLOWLIST, SPECS
    from app.metrics import FLOWS

    assert "topic_discovery_flow" in SPECS and "topic_discovery_flow" in CRON_FLOWS and "topic_discovery_flow" in FLOWS
    assert "topic_discovery_flow" not in MCP_KICKOFF_ALLOWLIST
