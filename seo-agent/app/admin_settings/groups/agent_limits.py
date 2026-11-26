"""Settings group "Agent limits": how long and how much a crew or flow may run.

Defaults are the ones in app/config.py; nothing here sets a value. The ranges only refuse values the code could not
work with (config.py's own clamps, and the 1–20 turns the per-agent override already allows).
"""

from __future__ import annotations

from ..registry import Field, Group

HOST = r"(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+"

GROUP = Group(
    id="agent-limits",
    title="Agent limits",
    description="How many turns, requests, tokens and seconds a crew or a flow may use, and which documentation sites agents may read.",
    fields=(
        Field(
            "CREW_MAX_ITER",
            "crew_max_iter",
            "Turns per agent",
            "The most turns one crew agent takes on a task. An agent's own setting in Crews wins.",
            "integer",
            unit="turns",
            min=1,
            max=20,
        ),
        Field(
            "CREW_MAX_RPM",
            "crew_max_rpm",
            "Model requests per minute, per crew",
            "A crew waits rather than send more than this many model requests in a minute.",
            "integer",
            unit="requests per minute",
            min=1,
            max=600,
        ),
        Field(
            "CREW_MAX_TOKENS_PER_RUN",
            "crew_max_tokens_per_run",
            "Tokens per crew run",
            "A crew run stops as incomplete once it has used this many tokens.",
            "integer",
            unit="tokens",
            min=1000,
            max=10_000_000,
        ),
        Field(
            "CREW_TIMEOUT_SECONDS",
            "crew_timeout_s",
            "Crew run time limit",
            "A crew run that takes longer stops as incomplete. Each agent gets half of it.",
            "integer",
            unit="seconds",
            min=60,
            max=7200,
        ),
        Field(
            "SEO_FLOW_TIMEOUT_SECONDS",
            "flow_timeout_s",
            "Flow run time limit",
            "The most time one flow run may take, crews included.",
            "integer",
            apply="restart",
            unit="seconds",
            min=60,
            max=86_400,
        ),
        Field(
            "SEO_LLM_TIMEOUT_SECONDS",
            "llm_timeout_s",
            "Model request time limit",
            "How long one request to the model may take before it fails.",
            "number",
            apply="restart",
            unit="seconds",
            min=30,
            max=900,
        ),
        Field(
            "SEO_AGENT_FANOUT_CONCURRENCY",
            "fanout_concurrency",
            "Articles worked on at once",
            "How many articles the weekly flow drafts at the same time.",
            "integer",
            unit="articles",
            min=1,
            max=16,
        ),
        Field(
            "SEO_AGENT_WEEKLY_MAX_ARTICLES",
            "weekly_max_articles",
            "Articles per weekly run",
            "The most articles the weekly recommendations flow drafts changes for, unless a run names its own limit.",
            "integer",
            unit="articles",
            min=1,
            max=25,
        ),
        Field(
            "SCHEDULE_CATCHUP_MINUTES",
            "schedule_catchup_min",
            "Run a missed schedule up to",
            "A scheduled run that was missed (the agent was down) still starts if it is no later than this.",
            "integer",
            unit="minutes",
            min=2,
            max=1440,
        ),
        Field(
            "SEO_AGENT_DOCS_ALLOWLIST",
            "docs_allowlist",
            "Documentation sites agents may read",
            "Host names only, one per entry (a host also allows its subdomains). Empty uses the built-in list.",
            "list",
            pattern=HOST,
            item_max=253,
        ),
    ),
)
