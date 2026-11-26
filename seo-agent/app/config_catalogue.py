"""GET /config-catalogue: everything this service defines in code that the CrewAI configuration bundle describes.

The web app's configuration export (moks-cms lib/crewai/bundle, AI & SEO → Configuration) writes a portable bundle of
the CrewAI setup: crews, their agents and tasks, flows, skills, tools, prompts, schedules and providers. Most of it is
data the web app keeps (catalogue rows, crew versions, skills, schedules); this endpoint is the part that is code here,
read from the registries at request time, so a crew, flow or tool added to the code appears in the next export without
anyone listing it:

- `crews`: every crew in `crews.config.registry()` with its code defaults (the same entries GET /crews returns);
- `flows`: every flow in `flows.SPECS` with its input schema and start rules (the same entries GET /flows returns);
- `tools`: every tool an agent can be given (`tools.ALL_TOOLS`): what it tells the model, which crews may use it, and
  whether a crew made in the admin (a spec crew) may hold it (`crews.custom.CUSTOM_TOOLS`);
- `guardrails`: the code-owned rules every crew agent's system prompt carries. They are listed so a reviewer sees them
  next to the editable prompts; nothing in a bundle can change them;
- `models`: the models an agent can be set to (the ones with prices: a cost is never guessed).

Nothing here is a secret: no keys, tokens or URLs with credentials. The bundle is data only: this service never runs
code from it, and every crew or flow spec in it is checked again (POST /custom/validate, /crews/{crew}/validate) before
the web app saves it.
"""

from __future__ import annotations

from typing import Any

from .crews import config as crew_config
from .crews.common import UNTRUSTED
from .crews.custom import CUSTOM_TOOLS
from .crews.skills import SKILLS_RULE
from .flows import catalogue as flow_catalogue
from .news.tools import NEWS_TOOL_DESCRIPTIONS
from .tools import ALL_TOOLS, NEWS_TOOLS, TOOL_DESCRIPTIONS

FORMAT = 1

GUARDRAILS: tuple[dict[str, str], ...] = (
    {"id": "untrusted-data", "title": "Untrusted data", "applies_to": "every crew agent's system prompt", "text": UNTRUSTED},
    {"id": "skills", "title": "Skills", "applies_to": "agents that are given skills", "text": SKILLS_RULE},
    {
        "id": "process",
        "title": "How crews run",
        "applies_to": "every crew",
        "text": (
            "Crews run their tasks in order (sequential process), without delegation, memory or code execution, within "
            "the token and wall-clock caps of the settings. Agents hold only tools from the allowlist. A crew's output is a "
            "draft a person reviews: no agent can publish, approve or change anything."
        ),
    },
)


def tools() -> list[dict[str, Any]]:
    crews = crew_config.registry().values()
    out = []
    for name in sorted(ALL_TOOLS | set(NEWS_TOOL_DESCRIPTIONS)):
        groups = [g for g, on in (("seo", name in TOOL_DESCRIPTIONS), ("news", name in NEWS_TOOLS or name in NEWS_TOOL_DESCRIPTIONS)) if on]
        out.append(
            {
                "name": name,
                "description": TOOL_DESCRIPTIONS.get(name) or NEWS_TOOL_DESCRIPTIONS.get(name, ""),
                "groups": groups,
                "read_only": True,
                "custom": name in CUSTOM_TOOLS,
                "crews": sorted(c.crew for c in crews if name in c.allowed_tools()),
                "agents": sorted(f"{c.crew}.{a.key}" for c in crews for a in c.agents if name in a.tools),
            }
        )
    return out


def catalogue(version: str) -> dict[str, Any]:
    return {
        "format": FORMAT,
        "service": "moks-seo-agent",
        "version": version,
        "crews": [crew_config.catalogue(c) for c in crew_config.registry().values()],
        "flows": flow_catalogue(),
        "tools": tools(),
        "custom_tools": list(CUSTOM_TOOLS),
        "guardrails": [dict(g) for g in GUARDRAILS],
        "models": crew_config.models(),
    }
