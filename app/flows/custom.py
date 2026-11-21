"""Custom flows, made in the admin, run by one generic interpreter (crew-jobs plan PR 6; admin-settings plan P4).

A custom flow is a declarative spec an admin writes on AI & SEO → Flows → New flow (moks-cms table seo_custom_flows,
served by GET /internal/seo-agent/custom-flows). `custom_flow` runs it: {flow: <key>, inputs: {...}, dry_run}. It can be
started by hand (Run with parameters), by a schedule (a system job with these inputs) or by the console's test run
(dry_run: no draft is created). Its steps, in order:

- crew: run one custom crew (app/crews/custom.py) with inputs built from the flow's inputs and earlier steps, and keep
  its output under a name;
- condition: compare a value (an earlier output, or an input) with a fixed one: contains / does not contain / at least
  N characters; when it does not hold, stop the flow (outcome "stopped") or skip the next step;
- draft: create a draft in the review queue from earlier outputs (title, description, body as MDX, collection,
  category). A person reviews and approves it like every AI draft.

What a custom flow can never do: publish, approve, schedule or submit anything (there is no such step; publish_flow
stays approval-only), start another flow, or call a tool outside the crews' allowlist. Values are text templates:
"{input.topic}", "{steps.research}"; anything else in braces stays as written.
"""

from __future__ import annotations

import re
from functools import partial
from typing import Annotated, Any, ClassVar, Literal

from crewai.flow import persist, start
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ..crews.custom import KEY, SpecError, issues_of, run_custom_crew, validate_crew
from ..runs import INSTANCE_ONLY
from ..state import RunState, _In
from .base import SeoFlow

REF = re.compile(r"\{(input|steps)\.([a-z][a-z0-9_]{0,39})\}")
MAX_VALUE = 60_000


class CrewStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["crew"]
    crew: str = Field(pattern=KEY)
    inputs: dict[str, str] = Field(default_factory=dict)
    save_as: str = Field(pattern=KEY)


class ConditionStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["condition"]
    value: str = Field(min_length=1, max_length=200)
    op: Literal["contains", "not_contains", "min_length"]
    operand: str = Field(max_length=500)
    otherwise: Literal["stop", "skip_next"] = "stop"

    @model_validator(mode="after")
    def _operand(self) -> ConditionStep:
        if self.op == "min_length" and not self.operand.isdigit():
            raise ValueError("min_length needs a whole number")
        return self


class DraftStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["draft"]
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(default="", max_length=1000)
    body: str = Field(min_length=1, max_length=1000)
    collection: Literal["blog", "news"] = "blog"
    category: str | None = Field(default=None, max_length=60)


Step = Annotated[CrewStep | ConditionStep | DraftStep, Field(discriminator="kind")]


class CustomFlowSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=KEY)
    label: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    inputs: list[str] = Field(default_factory=list, max_length=12)
    steps: list[Step] = Field(min_length=1, max_length=20)

    @field_validator("inputs")
    @classmethod
    def _inputs(cls, v: list[str]) -> list[str]:
        bad = [i for i in v if not re.fullmatch(KEY, i)]
        if bad:
            raise ValueError(f"input names must be lower-case words: {', '.join(bad)}")
        return list(dict.fromkeys(v))

    @model_validator(mode="after")
    def _refs(self) -> CustomFlowSpec:
        saved: list[str] = []
        for n, s in enumerate(self.steps, 1):
            texts = list(s.inputs.values()) if isinstance(s, CrewStep) else [s.value] if isinstance(s, ConditionStep) else [s.title, s.description, s.body]
            for t in texts:
                for kind, name in REF.findall(t):
                    if kind == "input" and name not in self.inputs:
                        raise ValueError(f"step {n} uses input {name}, which the flow does not have")
                    if kind == "steps" and name not in saved:
                        raise ValueError(f"step {n} uses steps.{name} before a crew step saves it")
            if isinstance(s, CrewStep):
                if s.save_as in saved:
                    raise ValueError(f"step {n}: {s.save_as} is saved twice")
                saved.append(s.save_as)
        if not any(isinstance(s, CrewStep) for s in self.steps):
            raise ValueError("a flow needs at least one crew step")
        return self


def validate_flow(data: Any, crews: set[str] | None = None) -> CustomFlowSpec:
    """The one check of a flow spec (POST /custom/validate and before each run). `crews`: the custom crews that exist
    (None = not checked here)."""
    try:
        spec = CustomFlowSpec.model_validate(data)
    except ValidationError as e:
        raise SpecError(issues_of(e)) from e
    if crews is not None:
        missing = sorted({s.crew for s in spec.steps if isinstance(s, CrewStep)} - crews)
        if missing:
            raise SpecError([f"no custom crew {', '.join(missing)} (make it under Crews → New crew, or switch it on)"])
    return spec


def fill(template: str, values: dict[str, dict[str, str]]) -> str:
    return REF.sub(lambda m: values.get(m.group(1), {}).get(m.group(2), ""), template)[:MAX_VALUE]


def holds(step: ConditionStep, value: str) -> bool:
    if step.op == "contains":
        return step.operand.lower() in value.lower()
    if step.op == "not_contains":
        return step.operand.lower() not in value.lower()
    return len(value.strip()) >= int(step.operand)


class CustomFlowInput(_In):
    flow: str = Field(pattern=KEY)
    inputs: dict[str, str] = Field(default_factory=dict, max_length=12)
    dry_run: bool = False
    trigger: str = Field(default="manual", max_length=20)

    @field_validator("inputs")
    @classmethod
    def _sizes(cls, v: dict[str, str]) -> dict[str, str]:
        if any(len(x) > 4000 for x in v.values()):
            raise ValueError("an input is at most 4,000 characters")
        return v


class CustomFlowState(RunState):
    flow: str = ""
    inputs: dict[str, str] = Field(default_factory=dict)
    dry_run: bool = False
    trigger: str = "manual"
    steps: list[dict[str, Any]] = Field(default_factory=list)
    saved: dict[str, str] = Field(default_factory=dict)
    draft_id: str | None = None
    errors: list[str] = Field(default_factory=list)


async def _specs(web: Any) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """The enabled custom crews and flows, by key, as the web app serves them ({key, version, spec})."""
    crews = {str(r["key"]): r for r in (await web.custom_crews() or []) if isinstance(r, dict) and r.get("key")}
    flows = {str(r["key"]): r for r in (await web.custom_flows() or []) if isinstance(r, dict) and r.get("key")}
    return crews, flows


@persist(INSTANCE_ONLY)
class CustomFlow(SeoFlow[CustomFlowState]):
    FLOW: ClassVar[str] = "custom_flow"

    @start()
    async def interpret(self) -> None:
        s = self.state
        crews, flows = await self.retry(lambda: _specs(self.deps.web))
        row = flows.get(s.flow)
        if not row:
            s.outcome, s.errors = "failed", [*s.errors, f"no custom flow {s.flow} (deleted, switched off, or never saved)"]
            raise SpecError(s.errors[-1:])
        spec = validate_flow(row.get("spec"), set(crews))
        values: dict[str, dict[str, str]] = {"input": {k: str(s.inputs.get(k, "")) for k in spec.inputs}, "steps": {}}
        skip = False
        for n, step in enumerate(spec.steps, 1):
            name = f"{n}-{step.kind}"
            if skip:
                s.steps.append({"step": name, "outcome": "skipped"})
                skip = False
                continue
            async with self.step(name):
                if isinstance(step, CrewStep):
                    c = crews[step.crew]
                    cspec = validate_crew(c.get("spec"))
                    o = await run_custom_crew(cspec, {k: fill(v, values) for k, v in step.inputs.items()}, settings=self.deps.settings, llm=self.deps.llm, web=self.deps.web, retriever=self.deps.retriever, version=c.get("version"))
                    values["steps"][step.save_as] = str(getattr(o, "output", "") or "")[:MAX_VALUE]
                    s.saved[step.save_as] = values["steps"][step.save_as][:2000]
                    s.steps.append({"step": name, "outcome": o.status, "crew": step.crew, "tokens": o.tokens, "cost_usd": round(o.cost_usd, 6)})
                elif isinstance(step, ConditionStep):
                    ok = holds(step, fill(step.value, values))
                    s.steps.append({"step": name, "outcome": "held" if ok else f"not held: {step.otherwise}"})
                    if not ok and step.otherwise == "stop":
                        s.outcome = "stopped"
                        return
                    skip = not ok
                else:
                    doc = {"title": fill(step.title, values)[:110], "description": fill(step.description, values)[:300], "body": fill(step.body, values), "collection": step.collection, "category": step.category}
                    if s.dry_run:
                        s.steps.append({"step": name, "outcome": "dry_run", "title": doc["title"]})
                        continue
                    r = await self.retry(partial(self.deps.web.custom_save_draft, {**doc, "flow": spec.key, "runId": s.id}))
                    if r.get("errors"):
                        s.errors.append("; ".join(map(str, r["errors"]))[:500])
                        s.steps.append({"step": name, "outcome": "refused", "errors": r["errors"]})
                        s.outcome = "failed_validation"
                        return
                    s.draft_id = str(r.get("draftId") or "") or None
                    s.steps.append({"step": name, "outcome": "ready_for_review", "draft_id": s.draft_id})
        s.outcome = s.outcome or ("dry_run" if s.dry_run else "done")
