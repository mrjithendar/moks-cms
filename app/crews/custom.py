"""Custom crews, made in the admin (crew-jobs plan PR 6; admin-settings plan P4).

A custom crew is a declarative spec an admin writes on AI & SEO → Crews → New crew (moks-cms table seo_custom_crews,
served to this service by GET /internal/seo-agent/custom-crews). It runs with the same plumbing and guardrails as the
built-in crews (app/crews/common.py): the untrusted-data rule and the skills rule in every system prompt, the
sequential process, no delegation, memory or code execution, the token and wall-clock caps, and tools only from the
allowlist below. A custom crew is run only by a custom flow (app/flows/custom.py), and never publishes anything.

Spec:
- agents (1–8): key, role, goal, backstory, tools (a subset of CUSTOM_TOOLS), optional model and output-token limit;
- tasks (1–12), run in order: key, the agent that does it, label, instructions, expected output, and the earlier tasks
  whose output it reads (context; none named = the task before it);
- inputs: the placeholder names the instructions may use ({topic}); `today` is always there.

`validate_crew` is the one check (the web app calls POST /custom/validate before it saves a spec, and this service
checks again before it runs one), so a spec the admin saved can never widen what an agent may do.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .common import AgentDef
from .config import CREW_IDS, MODEL_RE, PLACEHOLDER, render

# The tools a custom crew's agent may hold: read-only, and usable without a fixed article or a news run (so not
# gsc_queries_for_page, which needs the article being optimised, nor the News Desk's tools). app/tools ALLOWED_TOOLS.
CUSTOM_TOOLS = ("read_article", "vector_search", "gsc_queries_for_topic", "style_guide", "fetch_allowlisted_docs")
KEY = r"^[a-z][a-z0-9_]{1,39}$"
ALWAYS = ("today",)


class CustomAgent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=KEY)
    role: str = Field(min_length=2, max_length=300)
    goal: str = Field(min_length=2, max_length=1500)
    backstory: str = Field(min_length=2, max_length=4000)
    tools: list[str] = Field(default_factory=list, max_length=len(CUSTOM_TOOLS))
    model: str | None = Field(default=None, pattern=MODEL_RE)
    max_tokens: int | None = Field(default=None, ge=256, le=16_000)

    @field_validator("tools")
    @classmethod
    def _tools(cls, v: list[str]) -> list[str]:
        bad = [t for t in v if t not in CUSTOM_TOOLS]
        if bad:
            raise ValueError(f"tool(s) a custom crew may not use: {', '.join(bad)} (allowed: {', '.join(CUSTOM_TOOLS)})")
        return list(dict.fromkeys(v))


class CustomTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=KEY)
    agent: str = Field(pattern=KEY)
    label: str = Field(min_length=1, max_length=120)
    instructions: str = Field(min_length=2, max_length=8000)
    expected_output: str = Field(min_length=2, max_length=2000)
    context: list[str] = Field(default_factory=list, max_length=12)


class CustomCrewSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=KEY)
    label: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    inputs: list[str] = Field(default_factory=list, max_length=12)
    agents: list[CustomAgent] = Field(min_length=1, max_length=8)
    tasks: list[CustomTask] = Field(min_length=1, max_length=12)

    @field_validator("key")
    @classmethod
    def _not_builtin(cls, v: str) -> str:
        if v in CREW_IDS:
            raise ValueError(f"{v} is a built-in crew; pick another key")
        return v

    @field_validator("inputs")
    @classmethod
    def _inputs(cls, v: list[str]) -> list[str]:
        bad = [i for i in v if not re.fullmatch(KEY, i) or i in ALWAYS]
        if bad:
            raise ValueError(f"input names must be lower-case words and not {', '.join(ALWAYS)}: {', '.join(bad)}")
        return list(dict.fromkeys(v))

    @model_validator(mode="after")
    def _structure(self) -> CustomCrewSpec:
        agents = [a.key for a in self.agents]
        if len(set(agents)) != len(agents):
            raise ValueError("agent keys must be unique")
        seen: list[str] = []
        names = set(self.inputs) | set(ALWAYS)
        for t in self.tasks:
            if t.key in seen:
                raise ValueError(f"task key {t.key} is used twice")
            if t.agent not in agents:
                raise ValueError(f"task {t.key}: no agent {t.agent}")
            later = [c for c in t.context if c not in seen]
            if later:
                raise ValueError(f"task {t.key} can read only earlier tasks, not {', '.join(later)}")
            unknown = sorted({m.group(1) for m in PLACEHOLDER.finditer(t.instructions)} - names)
            if unknown:
                raise ValueError(f"task {t.key} uses inputs the crew does not have: {', '.join(unknown)}")
            seen.append(t.key)
        return self


class SpecError(ValueError):
    def __init__(self, issues: list[str]):
        super().__init__("; ".join(issues))
        self.issues = issues


def issues_of(e: ValidationError) -> list[str]:
    return [f"{'.'.join(str(p) for p in err['loc']) or 'spec'}: {err['msg']}" for err in e.errors()][:30]


def validate_crew(data: Any) -> CustomCrewSpec:
    try:
        return CustomCrewSpec.model_validate(data)
    except ValidationError as e:
        raise SpecError(issues_of(e)) from e


def agent_defs(spec: CustomCrewSpec) -> list[AgentDef]:
    return [AgentDef(a.key, a.role, a.goal, a.backstory, list(a.tools), max_tokens=a.max_tokens, model=a.model) for a in spec.agents]


def task_text(spec: CustomCrewSpec, task: CustomTask, inputs: dict[str, str], now: datetime | None = None) -> str:
    """A task's description: its instructions with the inputs filled in, then the inputs as a data block (untrusted:
    they may come from a flow step's earlier crew output)."""
    from ..tools import data_block

    values = {**{k: inputs.get(k, "") for k in spec.inputs}, "today": (now or datetime.now(UTC)).date().isoformat()}
    return f"{render(task.instructions, values)}\n\n{data_block('inputs', values)}"


async def run_custom_crew(spec: CustomCrewSpec, inputs: dict[str, str], *, settings: Any, llm: Any, web: Any, retriever: Any, version: int | None = None) -> Any:
    """One run of a custom crew; returns the CrewOutcome (its `output` is the last task's text)."""
    from crewai import Task

    from ..tools import ToolContext
    from .common import build_agents, make_crew, run_crew

    ctx = ToolContext(web, retriever, settings.docs_allowlist)
    crew_name = f"custom_{spec.key}"

    def build(loop: Any, run: Any) -> tuple[Any, list[Any]]:
        agents = build_agents(agent_defs(spec), settings, llm, loop, run, ctx, draft_id=None, purpose=f"custom.{spec.key}", prompt_version=f"custom-{spec.key}-v{version or 0}", crew=crew_name)
        built: dict[str, Any] = {}
        tasks: list[Any] = []
        for t in spec.tasks:
            # The tasks it names, or else the one before it (the first task reads only its inputs).
            context = [built[c] for c in t.context] if t.context else tasks[-1:]
            task = Task(description=task_text(spec, t, inputs), expected_output=t.expected_output, agent=agents[t.agent], context=context)
            built[t.key] = task
            tasks.append(task)
        return make_crew(agents, tasks, settings), tasks

    return await run_crew(crew_name, build, settings, ctx, tags=("custom",))
