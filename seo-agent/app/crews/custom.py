"""Crews defined by a spec, made in the admin (crew-jobs plan PR 6; admin-settings plan P4; unified catalogue 2026-11-24).

A spec crew is a declarative spec an admin writes on AI & SEO → Crews → New crew (or gets by duplicating any crew; moks-cms
table crewai_crews since migration 0041, seo_custom_crews before; served to this service by GET
/internal/seo-agent/custom-crews). It runs with the same plumbing and guardrails as the
built-in crews (app/crews/common.py): the untrusted-data rule and the skills rule in every system prompt, the
sequential process, no delegation, memory or code execution, the token and wall-clock caps, and tools only from the
allowlist below. A custom crew is run only by a custom flow (app/flows/custom.py), and never publishes anything.

Spec:
- agents (1–8): key, role, goal, backstory, tools (a subset of CUSTOM_TOOLS), optional model and output-token limit;
- tasks (1–12), run in order: key, the agent that does it, label, instructions, expected output, and the earlier tasks
  whose output it reads (context; none named = the task before it);
- inputs: the placeholder names the instructions may use ({topic}); `today` is always there. Each is a name, or
  {name, label, description, required, default} (the input schema the console's forms and a flow step's check use);
- output (optional): the output schema: {format: text | json, required_keys}; a json output that does not parse or lacks
  a key fails the step that ran the crew (so its retry policy applies);
- model (optional): the crew's default model for agents that name none.

Any crew can run from a spec: `materialize()` turns a code crew (its defaults plus its active version) into one, which is
how Duplicate copies a code crew and how a flow step runs a code crew outside its own flow (with the tools that need no
fixed article: CUSTOM_TOOLS).

`validate_crew` is the one check (the web app calls POST /custom/validate before it saves a spec, and this service
checks again before it runs one), so a spec the admin saved can never widen what an agent may do.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, ValidationInfo, field_validator, model_validator

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
    max_iter: int | None = Field(default=None, ge=1, le=25)

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


class InputDef(BaseModel):
    """One input of a crew: what a flow step or Run with parameters must (or may) give it."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=KEY)
    label: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=500)
    required: bool = False
    default: str = Field(default="", max_length=4000)


class OutputDef(BaseModel):
    """The crew's output schema: free text, or a JSON object with these keys (checked after each run)."""

    model_config = ConfigDict(extra="forbid")
    format: str = Field(default="text", pattern=r"^(text|json)$")
    required_keys: list[str] = Field(default_factory=list, max_length=20)
    description: str = Field(default="", max_length=500)

    @field_validator("required_keys")
    @classmethod
    def _keys(cls, v: list[str]) -> list[str]:
        bad = [k for k in v if not re.fullmatch(r"^[A-Za-z_][A-Za-z0-9_]{0,59}$", k)]
        if bad:
            raise ValueError(f"output keys are words of letters, digits and _: {', '.join(bad)}")
        return list(dict.fromkeys(v))


class CustomCrewSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=KEY)
    label: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    inputs: list[InputDef] = Field(default_factory=list, max_length=12)
    output: OutputDef | None = None
    model: str | None = Field(default=None, pattern=MODEL_RE)
    agents: list[CustomAgent] = Field(min_length=1, max_length=8)
    tasks: list[CustomTask] = Field(min_length=1, max_length=12)

    @field_validator("key")
    @classmethod
    def _not_builtin(cls, v: str, info: ValidationInfo) -> str:
        # A code crew's own key is allowed only when this service materializes it (a flow step running a code crew).
        if v in CREW_IDS and not (info.context or {}).get("code_crew"):
            raise ValueError(f"{v} is the key of a crew defined in code; pick another key")
        return v

    @field_validator("inputs", mode="before")
    @classmethod
    def _input_names(cls, v: Any) -> Any:
        # Specs saved before 2026-11-24 list names only: ["topic"].
        return [{"name": i} if isinstance(i, str) else i for i in v] if isinstance(v, list) else v

    @field_validator("inputs")
    @classmethod
    def _inputs(cls, v: list[InputDef]) -> list[InputDef]:
        bad = [i.name for i in v if i.name in ALWAYS]
        if bad:
            raise ValueError(f"input names must be lower-case words and not {', '.join(ALWAYS)}: {', '.join(bad)}")
        seen: dict[str, InputDef] = {}
        for i in v:
            seen.setdefault(i.name, i)
        return list(seen.values())

    @property
    def input_names(self) -> list[str]:
        return [i.name for i in self.inputs]

    @model_validator(mode="after")
    def _structure(self) -> CustomCrewSpec:
        agents = [a.key for a in self.agents]
        if len(set(agents)) != len(agents):
            raise ValueError("agent keys must be unique")
        seen: list[str] = []
        names = set(self.input_names) | set(ALWAYS)
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


def validate_crew(data: Any, *, code_crew: bool = False) -> CustomCrewSpec:
    try:
        return CustomCrewSpec.model_validate(data, context={"code_crew": code_crew})
    except ValidationError as e:
        raise SpecError(issues_of(e)) from e


def agent_defs(spec: CustomCrewSpec) -> list[AgentDef]:
    return [AgentDef(a.key, a.role, a.goal, a.backstory, list(a.tools), max_tokens=a.max_tokens, model=a.model or spec.model, max_iter=a.max_iter) for a in spec.agents]


def missing_inputs(spec: CustomCrewSpec, inputs: dict[str, str]) -> list[str]:
    """Required inputs that are empty after defaults are applied."""
    return [i.name for i in spec.inputs if i.required and not str(inputs.get(i.name) or i.default or "").strip()]


def with_defaults(spec: CustomCrewSpec, inputs: dict[str, str]) -> dict[str, str]:
    return {**{i.name: i.default for i in spec.inputs if i.default}, **{k: v for k, v in inputs.items() if str(v).strip()}}


FENCE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$")


def check_output(spec: CustomCrewSpec, text: str) -> str | None:
    """None when the output fits the crew's output schema; otherwise why not (the step fails, and may be retried)."""
    out = spec.output
    if out is None or out.format == "text":
        return None if (text or "").strip() or out is None else "the crew returned no text"
    body = (text or "").strip()
    m = FENCE.match(body)
    if m:
        body = m.group(1)
    try:
        data = json.loads(body)
    except (TypeError, ValueError):
        return "the crew's output is not JSON, but its output schema says json"
    if not isinstance(data, dict):
        return "the crew's output is JSON, but not an object"
    missing = [k for k in out.required_keys if k not in data]
    return f"the crew's output lacks {', '.join(missing)}" if missing else None


def materialize(effective: Any, *, key: str | None = None, label: str | None = None) -> dict[str, Any]:
    """A code crew (crews/config.py Effective: its defaults plus the version it runs) as a spec. Tools are those a spec
    crew may hold (CUSTOM_TOOLS); the others need a fixed article or a news run and are left out. The inputs are the
    placeholders its instructions use. Code-owned output contracts are not copied: nothing parses a spec crew's answer."""
    crew = effective.crew
    agents = []
    for a in effective.agents():
        agents.append({"key": a.key if re.fullmatch(KEY, a.key) else f"a_{a.key}"[:40], "role": a.role[:300], "goal": a.goal[:1500], "backstory": a.backstory[:4000],
                       "tools": [t for t in a.tools if t in CUSTOM_TOOLS], **({"model": a.model} if a.model else {}), **({"max_tokens": min(a.max_tokens, 16_000)} if a.max_tokens and a.max_tokens >= 256 else {}),
                       **({"max_iter": a.max_iter} if a.max_iter else {})})
    names: list[str] = []
    tasks = []
    for t in crew.tasks:
        text = effective.instructions(t.key, **{v: "{" + v + "}" for v in t.variables})[:8000]
        for m in PLACEHOLDER.finditer(text):
            if m.group(1) not in ALWAYS and re.fullmatch(KEY, m.group(1)) and m.group(1) not in names:
                names.append(m.group(1))
        tasks.append({"key": t.key if re.fullmatch(KEY, t.key) else f"t_{t.key}"[:40], "agent": t.agent if re.fullmatch(KEY, t.agent) else f"a_{t.agent}"[:40], "label": t.label[:120] or t.key,
                      "instructions": PLACEHOLDER.sub(lambda m: m.group(0) if re.fullmatch(KEY, m.group(1)) or m.group(1) in ALWAYS else m.group(1), text), "expected_output": effective.expected_output(t.key)[:2000] or "The result."})
    return {"key": key or crew.crew, "label": (label or crew.label)[:120], "description": crew.description[:1000], "inputs": [{"name": n} for n in names[:12]], "agents": agents[:8], "tasks": tasks[:12]}


def task_text(spec: CustomCrewSpec, task: CustomTask, inputs: dict[str, str], now: datetime | None = None) -> str:
    """A task's description: its instructions with the inputs filled in, then the inputs as a data block (untrusted:
    they may come from a flow step's earlier crew output)."""
    from ..tools import data_block

    values = {**{k: inputs.get(k, "") for k in spec.input_names}, "today": (now or datetime.now(UTC)).date().isoformat()}
    return f"{render(task.instructions, values)}\n\n{data_block('inputs', values)}"


async def run_custom_crew(spec: CustomCrewSpec, inputs: dict[str, str], *, settings: Any, llm: Any, web: Any, retriever: Any, version: int | None = None) -> Any:
    """One run of a custom crew; returns the CrewOutcome (its `output` is the last task's text)."""
    from crewai import Task

    from ..tools import ToolContext
    from .common import build_agents, make_crew, run_crew

    ctx = ToolContext(web, retriever, settings.docs_allowlist)
    crew_name = f"custom_{spec.key}"

    def build(loop: Any, run: Any) -> tuple[Any, list[Any]]:
        agents = build_agents(agent_defs(spec), settings, llm, loop, run, ctx, draft_id=None, purpose=f"custom.{spec.key}", prompt_version=f"custom-{spec.key}-v{version or 0}", crew=crew_name, default_model=spec.model)
        built: dict[str, Any] = {}
        tasks: list[Any] = []
        for t in spec.tasks:
            # The tasks it names, or else the one before it (the first task reads only its inputs).
            context = [built[c] for c in t.context] if t.context else tasks[-1:]
            expected = t.expected_output
            if spec.output is not None and spec.output.format == "json" and t is spec.tasks[-1]:
                keys = ", ".join(spec.output.required_keys) or "the keys the task asks for"
                expected = f"{expected}\n\nAnswer with one JSON object and nothing else, with: {keys}."
            task = Task(description=task_text(spec, t, inputs), expected_output=expected, agent=agents[t.agent], context=context)
            built[t.key] = task
            tasks.append(task)
        return make_crew(agents, tasks, settings), tasks

    return await run_crew(crew_name, build, settings, ctx, tags=("custom",))
