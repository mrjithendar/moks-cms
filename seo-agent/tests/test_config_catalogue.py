"""GET /config-catalogue (app/config_catalogue.py): the code-defined part of the web app's CrewAI configuration bundle.

The checks compare against the registries themselves, never a list written here, so a crew, flow or tool added to the
code is expected in the catalogue without touching this file.
"""

from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from app.crews import config as crew_config
from app.crews.custom import CUSTOM_TOOLS
from app.flows import SPECS
from app.llm import FakeLlm
from app.main import create_app, memory_container
from app.news.tools import NEWS_TOOL_DESCRIPTIONS, NewsToolContext
from app.tools import ALL_TOOLS, ALLOWED_TOOLS, SECRETISH, ToolContext, build_tools
from tests.conftest import FakeWebApp, settings

AUTH = {"Authorization": "Bearer " + "t" * 40}


@pytest.fixture
def cat(llm: FakeLlm, web: FakeWebApp) -> dict:
    c = memory_container(settings(), llm=llm, web=web)
    with TestClient(create_app(c)) as client:
        assert client.get("/config-catalogue").status_code == 401
        r = client.get("/config-catalogue", headers=AUTH)
        assert r.status_code == 200
        return r.json()


def test_the_catalogue_lists_every_registered_crew_flow_and_tool(cat: dict) -> None:
    assert cat["service"] == "moks-seo-agent" and cat["format"] == 1 and cat["version"]
    assert {c["crew"] for c in cat["crews"]} == set(crew_config.registry())
    assert {f["name"] for f in cat["flows"]} == set(SPECS)
    tools = {t["name"]: t for t in cat["tools"]}
    assert set(tools) == ALL_TOOLS | set(NEWS_TOOL_DESCRIPTIONS)
    assert cat["custom_tools"] == list(CUSTOM_TOOLS) and all(tools[t]["custom"] for t in CUSTOM_TOOLS)
    assert cat["models"] == crew_config.models()
    # Every tool a crew's agent holds in code is described, and names that crew and agent.
    for crew in crew_config.registry().values():
        for agent in crew.agents:
            for t in agent.tools:
                assert crew.crew in tools[t]["crews"] and f"{crew.crew}.{agent.key}" in tools[t]["agents"]
    assert all(t["description"] and t["read_only"] for t in tools.values())
    assert {g["id"] for g in cat["guardrails"]} >= {"untrusted-data", "skills", "process"}


def test_tool_descriptions_are_the_ones_the_agents_get(cat: dict) -> None:
    """The catalogue reads the same text build_tools and the News Desk hand to CrewAI (no second copy to drift)."""
    tools = {t["name"]: t for t in cat["tools"]}
    seo = build_tools(sorted(ALLOWED_TOOLS), ToolContext(None, None, ()))
    assert {s.name: s.description for s in seo} == {n: tools[n]["description"] for n in ALLOWED_TOOLS if "seo" in tools[n]["groups"]}
    news = NewsToolContext(None, None, items=[], allow_hosts=(), writing_profile={}, image_profile={}).news_tool_specs()
    assert {n: s.description for n, s in news.items()} == NEWS_TOOL_DESCRIPTIONS


def test_the_catalogue_carries_no_secrets(cat: dict) -> None:
    text = json.dumps(cat)
    assert not SECRETISH.search(text)
    assert not re.search(r"(?i)(api[_-]?key|password|secret|token)\"\s*:\s*\"[^\"]+", text)


def test_a_crews_full_definition_validates_as_no_change() -> None:
    """An export writes each code crew in full (every agent and task as it runs); importing it unchanged must be a no-op
    overlay, fixed expected outputs included, so a re-import never creates a version."""
    for crew in crew_config.registry().values():
        full = {
            "agents": {a.key: {"role": a.role, "goal": a.goal, "backstory": a.backstory, "tools": list(a.tools), **({"max_tokens": a.max_tokens} if a.max_tokens else {})} for a in crew.agents},
            "tasks": {t.key: {"instructions": t.instructions, "expected_output": t.expected_output} for t in crew.tasks},
        }
        assert crew_config.normalize(crew, crew_config.validate(crew, full)) == {}, crew.crew


def test_a_fixed_expected_output_still_cannot_change() -> None:
    crew = crew_config.registry()["editorial"]
    fixed = next(t for t in crew.tasks if not t.output_editable)
    try:
        crew_config.validate(crew, {"tasks": {fixed.key: {"expected_output": "Something else."}}})
    except crew_config.OverlayError as e:
        assert e.issues[0].startswith(f"tasks.{fixed.key}.expected_output")
    else:
        raise AssertionError("a changed fixed expected output was accepted")


def test_the_web_apps_fixture_has_the_catalogues_shape(cat: dict) -> None:
    """moks-cms tests its export and import against a copy of this catalogue (tests/fixtures/seo-agent/
    config-catalogue.json). Its keys must be the ones this service serves; refresh the copy when this fails."""
    from tests.moks_cms import www

    fixture = json.loads(www("tests/fixtures/seo-agent/config-catalogue.json").read_text())
    assert set(fixture) == set(cat)
    for part in ("crews", "flows", "tools", "guardrails"):
        assert set(fixture[part][0]) == set(cat[part][0]), part
    assert set(fixture["crews"][0]["agents"][0]) == set(cat["crews"][0]["agents"][0])
    assert set(fixture["crews"][0]["tasks"][0]) == set(cat["crews"][0]["tasks"][0])
