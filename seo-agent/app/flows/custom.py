"""Flows defined by steps, made in the admin, run by one generic interpreter (crew-jobs plan PR 6; admin-settings plan
P4; unified catalogue 2026-11-24).

A step flow is a declarative spec an admin writes on AI & SEO → Flows → New flow, or gets by duplicating any flow (moks-cms
table crewai_flows since migration 0041, seo_custom_flows before; served by GET /internal/seo-agent/custom-flows).
`custom_flow` runs it: {flow: <key>, inputs: {...}, dry_run}. It can be started by hand (Run with parameters), by a
schedule, or by the console's test run (dry_run: crews run, but no draft is created and no other flow is started).
A test run may carry unsaved work, checked like a saved spec: `draft` (the flow being edited) and `crew_draft` (a crew
being edited, used by the steps that name its key). Drafts run only as test runs started by a person.

Steps run in order. Each kind:

- crew: run any crew with inputs built from the flow's inputs and earlier steps, and keep its output under a name. A crew
  defined by a spec runs as it is; a crew defined in code runs from its defaults plus its active version
  (app/crews/custom.py materialize), with the tools that need no fixed article. A crew with an output schema has its
  answer checked; one that does not fit fails the step;
- flow: start another flow (its own run, triggered by "flow", like a weekly fan-out) with templated inputs, wait for it
  and keep its outputs under a name. The runner's policy still decides what may be started this way (never an
  approval-only flow or the console's crew test run), and a flow switched off in the admin is refused;
- condition: compare a value with a fixed one; when it does not hold, stop the flow (outcome "stopped") or skip the next
  step;
- draft: create a draft in the review queue from earlier outputs. A person reviews it like every AI draft.

Every step may also have:

- id: how other steps name it (default: its save_as, else step<N>);
- needs: earlier steps that must have succeeded, or this one is skipped (and says which one did not);
- when: a condition on this step itself; when it does not hold the step is skipped;
- retry: {attempts, delay_seconds, backoff}: attempts after the first, each after delay × backoff^(n-1) seconds;
- timeout_seconds: each attempt's limit (a flow step's child run is cancelled when it runs out);
- on_failure: stop (default: the flow fails), continue (the next steps run; steps that need this one are skipped) or
  fallback (as continue, and the step named in `fallback`, a later step that runs only for this, runs).

Every step records what happened in its run-history row (app/run_history.py step_detail): attempts and their errors,
the condition and whether it held, the crew and its version or the child run, tokens and cost, and redacted metadata
of its inputs and output. Values are text templates: "{input.topic}", "{steps.research}"; anything else in braces stays
as written. What a step flow can never do: start a flow outside the runner's policy, or call a tool outside the crews'
allowlist.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from functools import partial
from typing import Annotated, Any, ClassVar, Literal

from crewai.flow import persist, start
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ..crews.custom import KEY, CustomCrewSpec, SpecError, check_output, issues_of, materialize, missing_inputs, run_custom_crew, validate_crew, with_defaults
from ..llm import BudgetExceeded
from ..logs import RUN_ONLY
from ..narrate import count
from ..redaction import metadata
from ..runs import INSTANCE_ONLY, TERMINAL, RunError
from ..state import RunState, _In
from .base import SeoFlow, StepRecord

log = logging.getLogger("seo_agent.flows.custom")

REF = re.compile(r"\{(input|steps)\.([a-z][a-z0-9_]{0,39})\}")
MAX_VALUE = 60_000
FLOW_NAME = r"^[a-z][a-z0-9_]{2,39}_flow$"
SELF = "custom_flow"
OPS = ("contains", "not_contains", "min_length", "equals", "not_equals", "empty", "not_empty")
_timeout = asyncio.wait_for  # an attempt's time limit (tests shorten it)


class Condition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str = Field(min_length=1, max_length=200)
    op: Literal["contains", "not_contains", "min_length", "equals", "not_equals", "empty", "not_empty"]
    operand: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def _operand(self) -> Condition:
        if self.op == "min_length" and not self.operand.isdigit():
            raise ValueError("min_length needs a whole number")
        return self


class Retry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attempts: int = Field(default=0, ge=0, le=5)
    delay_seconds: float = Field(default=0, ge=0, le=600)
    backoff: float = Field(default=1, ge=1, le=4)


class _Step(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(default=None, pattern=KEY)
    label: str = Field(default="", max_length=120)
    needs: list[str] = Field(default_factory=list, max_length=10)
    when: Condition | None = None
    retry: Retry | None = None
    timeout_seconds: int | None = Field(default=None, ge=5, le=3600)
    on_failure: Literal["stop", "continue", "fallback"] = "stop"
    fallback: str | None = Field(default=None, pattern=KEY)

    @model_validator(mode="after")
    def _fallback(self) -> _Step:
        if self.on_failure == "fallback" and not self.fallback:
            raise ValueError("on_failure fallback needs the id of the fallback step")
        if self.fallback and self.on_failure != "fallback":
            raise ValueError("a fallback step is used only with on_failure: fallback")
        return self


class CrewStep(_Step):
    kind: Literal["crew"]
    crew: str = Field(pattern=KEY)
    inputs: dict[str, str] = Field(default_factory=dict)
    save_as: str = Field(pattern=KEY)


class FlowStep(_Step):
    kind: Literal["flow"]
    flow: str = Field(pattern=FLOW_NAME)
    inputs: dict[str, str] = Field(default_factory=dict, max_length=20)
    save_as: str | None = Field(default=None, pattern=KEY)
    wait: bool = True


class ConditionStep(_Step):
    kind: Literal["condition"]
    value: str = Field(min_length=1, max_length=200)
    op: Literal["contains", "not_contains", "min_length", "equals", "not_equals", "empty", "not_empty"]
    operand: str = Field(default="", max_length=500)
    otherwise: Literal["stop", "skip_next"] = "stop"

    @model_validator(mode="after")
    def _operand(self) -> ConditionStep:
        if self.op == "min_length" and not self.operand.isdigit():
            raise ValueError("min_length needs a whole number")
        return self


class DraftStep(_Step):
    kind: Literal["draft"]
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(default="", max_length=1000)
    body: str = Field(min_length=1, max_length=1000)
    collection: Literal["blog", "news"] = "blog"
    category: str | None = Field(default=None, max_length=60)


Step = Annotated[CrewStep | FlowStep | ConditionStep | DraftStep, Field(discriminator="kind")]


def step_id(step: Any, n: int) -> str:
    return step.id or getattr(step, "save_as", None) or f"step{n}"


def _texts(s: Any) -> list[str]:
    if isinstance(s, (CrewStep, FlowStep)):
        out = list(s.inputs.values())
    elif isinstance(s, ConditionStep):
        out = [s.value]
    else:
        out = [s.title, s.description, s.body]
    return out + ([s.when.value] if s.when else [])


class CustomFlowSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=KEY)
    label: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    inputs: list[str] = Field(default_factory=list, max_length=12)
    steps: list[Step] = Field(min_length=1, max_length=30)

    @field_validator("inputs", mode="before")
    @classmethod
    def _input_names(cls, v: Any) -> Any:
        return [i.get("name") if isinstance(i, dict) else i for i in v] if isinstance(v, list) else v

    @field_validator("inputs")
    @classmethod
    def _inputs(cls, v: list[str]) -> list[str]:
        bad = [i for i in v if not isinstance(i, str) or not re.fullmatch(KEY, i)]
        if bad:
            raise ValueError(f"input names must be lower-case words: {', '.join(map(str, bad))}")
        return list(dict.fromkeys(v))

    @model_validator(mode="after")
    def _refs(self) -> CustomFlowSpec:
        saved: list[str] = []
        ids = [step_id(s, n) for n, s in enumerate(self.steps, 1)]
        if len(set(ids)) != len(ids):
            dup = sorted({i for i in ids if ids.count(i) > 1})
            raise ValueError(f"step ids must be unique: {', '.join(dup)} is used twice")
        for n, s in enumerate(self.steps, 1):
            for t in _texts(s):
                for kind, name in REF.findall(t):
                    if kind == "input" and name not in self.inputs:
                        raise ValueError(f"step {n} uses input {name}, which the flow does not have")
                    if kind == "steps" and name not in saved:
                        raise ValueError(f"step {n} uses steps.{name} before a step saves it")
            earlier = ids[: n - 1]
            for need in s.needs:
                if need not in earlier:
                    raise ValueError(f"step {n} needs {need}, which is not an earlier step")
            if s.fallback and s.fallback not in ids[n:]:
                raise ValueError(f"step {n}: its fallback {s.fallback} must be a later step")
            if isinstance(s, FlowStep) and s.flow == SELF:
                raise ValueError(f"step {n}: a flow step cannot start a step flow (custom_flow); add its steps here instead")
            save = getattr(s, "save_as", None)
            if save:
                if save in saved:
                    raise ValueError(f"step {n}: {save} is saved twice")
                saved.append(save)
        if not any(isinstance(s, (CrewStep, FlowStep)) for s in self.steps):
            raise ValueError("a flow needs at least one crew or flow step")
        return self


def code_crews() -> set[str]:
    from ..crews.config import registry

    return set(registry())


def validate_flow(data: Any, crews: set[str] | None = None) -> CustomFlowSpec:
    """The one check of a flow spec (POST /custom/validate and before each run). `crews`: the spec crews that exist and
    are on (None = not checked here); crews defined in code always exist. Flow steps are checked against the flows this
    service has."""
    try:
        spec = CustomFlowSpec.model_validate(data)
    except ValidationError as e:
        raise SpecError(issues_of(e)) from e
    from . import MANUAL_ONLY, SPECS, check_kickoff

    issues: list[str] = []
    for n, s in enumerate(spec.steps, 1):
        if isinstance(s, FlowStep):
            if s.flow not in SPECS:
                issues.append(f"step {n}: no flow {s.flow}")
            elif s.flow in MANUAL_ONLY:
                issues.append(f"step {n}: {s.flow} starts only from the CrewAI console")
            else:
                try:
                    check_kickoff(s.flow, "flow")
                except RunError as e:
                    issues.append(f"step {n}: {e}")
    if crews is not None:
        known = set(crews) | code_crews()
        missing = sorted({s.crew for s in spec.steps if isinstance(s, CrewStep)} - known)
        if missing:
            issues.append(f"no crew {', '.join(missing)} (make it under Crews → New crew, or switch it on)")
    if issues:
        raise SpecError(issues)
    return spec


def fill(template: str, values: dict[str, dict[str, str]]) -> str:
    return REF.sub(lambda m: values.get(m.group(1), {}).get(m.group(2), ""), template)[:MAX_VALUE]


def holds(step: Condition | ConditionStep, value: str) -> bool:
    op, operand = step.op, step.operand
    if op == "contains":
        return operand.lower() in value.lower()
    if op == "not_contains":
        return operand.lower() not in value.lower()
    if op == "min_length":
        return len(value.strip()) >= int(operand)
    if op == "equals":
        return value.strip().lower() == operand.strip().lower()
    if op == "not_equals":
        return value.strip().lower() != operand.strip().lower()
    if op == "empty":
        return not value.strip()
    return bool(value.strip())  # not_empty


class StepFailed(Exception):
    """A step did not do its job (the crew's answer did not fit, a child run failed, a draft was refused)."""


class _Continue(Exception):  # control flow: the step failed, the flow goes on
    pass


class CustomFlowInput(_In):
    flow: str = Field(pattern=KEY)
    inputs: dict[str, str] = Field(default_factory=dict, max_length=12)
    dry_run: bool = False
    trigger: str = Field(default="manual", max_length=20)
    draft: dict[str, Any] | None = None
    crew_draft: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _drafts_are_tests(self) -> CustomFlowInput:
        if (self.draft is not None or self.crew_draft is not None) and not self.dry_run:
            raise ValueError("unsaved drafts run only as a test run (dry_run)")
        if self.draft is not None and self.draft.get("key") != self.flow:
            raise ValueError("the draft's key must be the flow being tested")
        return self

    @field_validator("inputs")
    @classmethod
    def _sizes(cls, v: dict[str, str]) -> dict[str, str]:
        if any(len(x) > 4000 for x in v.values()):
            raise ValueError("an input is at most 4,000 characters")
        return v


class CustomFlowState(RunState):
    flow: str = ""
    flow_version: int | None = None
    inputs: dict[str, str] = Field(default_factory=dict)
    dry_run: bool = False
    trigger: str = "manual"
    steps: list[dict[str, Any]] = Field(default_factory=list)
    saved: dict[str, str] = Field(default_factory=dict)
    draft_id: str | None = None
    draft: dict[str, Any] | None = None
    crew_draft: dict[str, Any] | None = None
    errors: list[str] = Field(default_factory=list)


async def _specs(web: Any) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """The enabled spec crews and step flows, by key, as the web app serves them ({key, version, spec})."""
    crews = {str(r["key"]): r for r in (await web.custom_crews() or []) if isinstance(r, dict) and r.get("key")}
    flows = {str(r["key"]): r for r in (await web.custom_flows() or []) if isinstance(r, dict) and r.get("key")}
    return crews, flows


async def resolve_crew(key: str, rows: dict[str, dict[str, Any]], web: Any) -> tuple[CustomCrewSpec, int | None, str]:
    """The spec a crew step runs: (spec, version, source). A spec crew from the web app, else a crew defined in code."""
    row = rows.get(key)
    if row is not None:
        return validate_crew(row.get("spec")), row.get("version"), "spec"
    from ..crews import config as crew_config

    if key in crew_config.registry():
        eff = await crew_config.load(key, web)
        return validate_crew(materialize(eff), code_crew=True), eff.version, f"code:{eff.source}"
    raise SpecError([f"no crew {key} (deleted or switched off)"])


def _what(step: Any) -> str:
    """A step in a few words, for the flow's plan line."""
    if isinstance(step, CrewStep):
        return f"crew {step.crew}"
    if isinstance(step, FlowStep):
        return f"flow {step.flow}"
    if isinstance(step, ConditionStep):
        return f"condition {step.op} {step.operand}"
    return "draft"


@persist(INSTANCE_ONLY)
class CustomFlow(SeoFlow[CustomFlowState]):
    FLOW: ClassVar[str] = "custom_flow"

    @start()
    async def interpret(self) -> None:
        s = self.state
        crews, flows = await self.retry(lambda: _specs(self.deps.web))
        if (s.draft is not None or s.crew_draft is not None) and s.triggered_by != "manual":
            raise SpecError(["unsaved drafts run only as a test run started by a person"])
        if s.crew_draft is not None:
            c = validate_crew(s.crew_draft)
            crews = {**crews, c.key: {"key": c.key, "version": None, "spec": s.crew_draft}}
        row = {"key": s.flow, "version": None, "spec": s.draft} if s.draft is not None else flows.get(s.flow)
        if not row:
            s.outcome, s.errors = "failed", [*s.errors, f"no flow {s.flow} (deleted, switched off, or never saved)"]
            raise SpecError(s.errors[-1:])
        spec = validate_flow(row.get("spec"), set(crews))
        s.flow_version = int(row["version"]) if isinstance(row.get("version"), int) else None
        plan = "; ".join(f"{step_id(st, i)} {_what(st)}" for i, st in enumerate(spec.steps, 1))
        log.info(
            f"Flow {spec.key}" + (f" v{s.flow_version}" if s.flow_version else " (unsaved draft)") + f": {count(len(spec.steps), 'step')}: {plan}"
            + (". Dry run: no draft is saved and no other flow is started" if s.dry_run else ""),
            extra={"event": "flow_spec", "flow": spec.key, "version": s.flow_version, "steps": len(spec.steps), "dry_run": s.dry_run},
        )
        values: dict[str, dict[str, str]] = {"input": {k: str(s.inputs.get(k, "")) for k in spec.inputs}, "steps": {}}
        results: dict[str, str] = {}
        backups = {st.fallback for st in spec.steps if st.fallback}
        wanted: set[str] = set()
        skip_next = False
        for n, step in enumerate(spec.steps, 1):
            sid = step_id(step, n)
            name = f"{n}-{step.kind}"
            reason = None
            if skip_next:
                reason = "the condition before it did not hold"
            elif sid in backups and sid not in wanted:
                reason = "a fallback step: it runs only when the step it backs up fails"
            else:
                bad = [f"{x} {results.get(x, 'did not run')}" for x in step.needs if results.get(x) != "succeeded"]
                if bad:
                    reason = f"needs {', '.join(bad)}"
            skip_next = False
            if reason:
                results[sid] = "skipped"
                s.steps.append({"step": name, "id": sid, "outcome": "skipped", "reason": reason})
                log.info(f"step {sid} skipped: {reason}", extra={"event": "flow_step_skipped", "step_id": sid, "reason": reason})
                continue
            try:
                async with self.step(name) as rec:
                    rec.detail.update({"id": sid, "kind": step.kind, **({"label": step.label} if step.label else {}), "flow": spec.key, "flow_version": s.flow_version})
                    if step.when is not None:
                        value = fill(step.when.value, values)
                        held = holds(step.when, value)
                        rec.detail["when"] = {"op": step.when.op, "operand": step.when.operand, "value": metadata(value, 200), "held": held}
                        log.info(f"step {sid}: condition {step.when.op} {'held' if held else 'did not hold'}", extra={"event": "condition_evaluated", "step_id": sid, "op": step.when.op, "held": held})
                        if not held:
                            results[sid] = "skipped"
                            rec.detail["outcome"] = "skipped"
                            s.steps.append({"step": name, "id": sid, "outcome": "skipped", "reason": "its condition did not hold"})
                            continue
                    outcome = await self._attempts(step, sid, name, values, rec, crews)
                    results[sid] = "succeeded"
                    if outcome == "stop":
                        s.outcome = s.outcome or "stopped"  # a refused draft keeps its failed_validation
                        return
                    if outcome == "skip_next":
                        skip_next = True
            except _Continue:
                results[sid] = "failed"
                if step.on_failure == "fallback" and step.fallback:
                    wanted.add(step.fallback)
                continue
            except Exception:
                results[sid] = "failed"
                raise
        failed = sorted(k for k, v in results.items() if v == "failed")
        # Steps that failed with on_failure continue or fallback: the run succeeds, and says some steps did not.
        s.outcome = s.outcome or ("dry_run" if s.dry_run else "partial" if failed else "done")

    async def _attempts(self, step: Any, sid: str, name: str, values: dict[str, dict[str, str]], rec: StepRecord, crews: dict[str, dict[str, Any]]) -> str | None:
        """Run one step with its retry policy and timeout. Returns "stop" / "skip_next" for a condition step."""
        retry = step.retry or Retry()
        tries = 1 + retry.attempts
        attempts: list[dict[str, Any]] = []
        rec.detail["attempts"] = attempts
        for attempt in range(1, tries + 1):
            started = time.monotonic()
            try:
                run = self._run(step, sid, name, values, rec, crews)
                result = await (_timeout(run, step.timeout_seconds) if step.timeout_seconds else run)
                attempts.append({"attempt": attempt, "status": "succeeded", "seconds": round(time.monotonic() - started, 3)})
                return result
            except asyncio.CancelledError:
                raise
            except BudgetExceeded as e:  # never retried: the budget decides, not the step
                self.add_budget_cost(e)
                attempts.append({"attempt": attempt, "status": "failed", "error": f"budget: {str(e)[:300]}", "seconds": round(time.monotonic() - started, 3)})
                raise
            except Exception as e:
                why = f"timed out after {step.timeout_seconds} s" if isinstance(e, TimeoutError) else f"{type(e).__name__}: {str(e)[:500]}"
                attempts.append({"attempt": attempt, "status": "failed", "error": why, "seconds": round(time.monotonic() - started, 3)})
                if attempt < tries:
                    delay = retry.delay_seconds * (retry.backoff ** (attempt - 1))
                    log.warning(f"step {sid} attempt {attempt} of {tries} failed: {why}; retrying in {delay:g} s", extra={"event": "flow_step_retry", "step_id": sid, "attempt": attempt, "error": why, "delay_s": delay})
                    if delay:
                        await self.deps.sleep(delay)
                    continue
                rec.detail["failure"] = why
                self.state.errors.append(f"{sid}: {why}"[:500])
                self.state.steps.append({"step": name, "id": sid, "outcome": "failed", "error": why, "attempts": attempt})
                log.error(f"step {sid} failed after {attempt} attempt(s): {why}", extra={"event": "flow_step_failed", "step_id": sid, "attempts": attempt, "error": why, "on_failure": step.on_failure})
                if step.on_failure == "stop":
                    raise StepFailed(f"step {sid} failed: {why}") from e
                raise _Continue() from e
        return None

    async def _run(self, step: Any, sid: str, name: str, values: dict[str, dict[str, str]], rec: StepRecord, crews: dict[str, dict[str, Any]]) -> str | None:
        s = self.state
        if isinstance(step, CrewStep):
            cspec, version, source = await resolve_crew(step.crew, crews, self.deps.web)
            inputs = with_defaults(cspec, {k: fill(v, values) for k, v in step.inputs.items()})
            rec.detail.update({"crew": step.crew, "crew_version": version, "crew_source": source, "input": metadata(inputs)})
            missing = missing_inputs(cspec, inputs)
            if missing:
                raise StepFailed(f"required input(s) empty: {', '.join(missing)}")
            log.info(
                f"Step {sid}: the {step.crew} crew ({'v' + str(version) if version else source}) runs with {', '.join(f'{k} ({len(v):,} characters)' for k, v in inputs.items()) or 'no inputs'}",
                extra={"event": "custom_crew_started", "step_id": sid, "crew": step.crew, RUN_ONLY: {"inputs": {k: v[:1000] for k, v in inputs.items()}}},
            )
            o = await run_custom_crew(cspec, inputs, settings=self.deps.settings, llm=self.deps.llm, web=self.deps.web, retriever=self.deps.retriever, version=version)
            text = str(getattr(o, "output", "") or "")[:MAX_VALUE]
            rec.detail.update({"tokens": getattr(o, "tokens", 0), "cost_usd": round(float(getattr(o, "cost_usd", 0) or 0), 6), "crew_status": getattr(o, "status", None), "output": metadata(text)})
            if getattr(o, "status", "completed") not in ("completed",):
                raise StepFailed(f"the crew did not finish: {getattr(o, 'reason', None) or o.status}")
            problem = check_output(cspec, text)
            if problem:
                raise StepFailed(problem)
            values["steps"][step.save_as] = text
            s.saved[step.save_as] = text[:2000]
            log.info(f"Step {sid}: the {step.crew} crew's answer ({len(text):,} characters) is saved as {step.save_as}", extra={"event": "custom_crew_done", "step_id": sid, RUN_ONLY: {"answer": text[:3000]}})
            s.steps.append({"step": name, "id": sid, "outcome": o.status, "crew": step.crew, "crew_version": version, "tokens": o.tokens, "cost_usd": round(o.cost_usd, 6)})
            return None
        if isinstance(step, FlowStep):
            await self._child(step, sid, name, values, rec)
            return None
        if isinstance(step, ConditionStep):
            value = fill(step.value, values)
            ok = holds(step, value)
            rec.detail["condition"] = {"op": step.op, "operand": step.operand, "value": metadata(value, 200), "held": ok, "otherwise": step.otherwise}
            log.info(f"step {sid}: condition {step.op} {'held' if ok else 'did not hold: ' + step.otherwise}", extra={"event": "condition_evaluated", "step_id": sid, "op": step.op, "held": ok})
            s.steps.append({"step": name, "id": sid, "outcome": "held" if ok else f"not held: {step.otherwise}"})
            return None if ok else step.otherwise
        doc = {"title": fill(step.title, values)[:110], "description": fill(step.description, values)[:300], "body": fill(step.body, values), "collection": step.collection, "category": step.category}
        rec.detail["output"] = metadata(doc["title"], 200)
        words = len(doc["body"].split())
        if s.dry_run:
            s.steps.append({"step": name, "id": sid, "outcome": "dry_run", "title": doc["title"]})
            log.info(f"Step {sid}: dry run, the draft “{doc['title']}” ({count(words, 'word')}) is not saved", extra={"event": "custom_draft_dry_run", "step_id": sid})
            return None
        r = await self.retry(partial(self.deps.web.custom_save_draft, {**doc, "flow": s.flow, "runId": s.id}))
        if r.get("errors"):
            log.warning(f"Step {sid}: the web app refused the draft “{doc['title']}”: {'; '.join(map(str, r['errors']))[:400]}", extra={"event": "custom_draft_refused", "step_id": sid})
            s.errors.append("; ".join(map(str, r["errors"]))[:500])
            s.steps.append({"step": name, "id": sid, "outcome": "refused", "errors": r["errors"]})
            s.outcome = "failed_validation"
            return "stop"
        s.draft_id = str(r.get("draftId") or "") or None
        s.steps.append({"step": name, "id": sid, "outcome": "ready_for_review", "draft_id": s.draft_id})
        log.info(f"Step {sid}: saved draft {s.draft_id} “{doc['title']}” ({count(words, 'word')}, {doc['collection']}) for review in the review queue (a person decides what happens next)", extra={"event": "custom_draft_saved", "step_id": sid, "draft_id": s.draft_id})
        return None

    async def _child(self, step: FlowStep, sid: str, name: str, values: dict[str, dict[str, str]], rec: StepRecord) -> None:
        """Start another flow as a child run and (unless wait is off) wait for it to end."""
        s = self.state
        inputs = {k: fill(v, values) for k, v in step.inputs.items()}
        rec.detail.update({"child_flow": step.flow, "input": metadata(inputs)})
        if s.dry_run:
            s.steps.append({"step": name, "id": sid, "outcome": "dry_run", "flow": step.flow})
            rec.detail["outcome"] = "dry_run: not started"
            return
        runner = self.deps.runner
        if runner is None:
            raise StepFailed("this service cannot start other flows here")
        r = await runner.kickoff(step.flow, inputs, triggered_by="flow", actor=f"flow:{s.flow}"[:200])
        child = str(r.get("run_id") or "")
        rec.detail.update({"child_run_id": child, "child_existing": bool(r.get("existing"))})
        log.info(f"step {sid}: started {step.flow} (run {child})", extra={"event": "flow_step_child", "step_id": sid, "child_flow": step.flow, "child_run_id": child, "existing": bool(r.get("existing"))})
        if not step.wait:
            s.steps.append({"step": name, "id": sid, "outcome": "started", "flow": step.flow, "run_id": child})
            if step.save_as:
                values["steps"][step.save_as] = child
            return
        limit = float(step.timeout_seconds or getattr(self.deps.settings, "flow_timeout_s", 1800) or 1800)
        deadline = time.monotonic() + limit
        done: dict[str, Any] = {}
        try:
            while True:
                done = await runner.wait(child, max(1.0, min(30.0, deadline - time.monotonic())))
                if done.get("status") in TERMINAL or time.monotonic() >= deadline:
                    break
                await self.deps.sleep(1.0)
        except asyncio.CancelledError:
            await runner.cancel(child)
            raise
        status = done.get("status")
        if status not in TERMINAL:
            await runner.cancel(child)
            raise TimeoutError(f"{step.flow} run {child} was still running")
        out = json.dumps(done.get("outputs") or {}, default=str)[:MAX_VALUE]
        rec.detail.update({"child_status": status, "output": metadata(out)})
        log.log(logging.INFO if status == "succeeded" else logging.WARNING, f"Step {sid}: {step.flow} run {child} ended {status}", extra={"event": "flow_step_child_done", "step_id": sid, "child_run_id": child, "status": status})
        if status != "succeeded":
            raise StepFailed(f"{step.flow} run {child} ended {status}: {str(done.get('error') or '')[:300]}")
        if step.save_as:
            values["steps"][step.save_as] = out
            s.saved[step.save_as] = out[:2000]
        s.steps.append({"step": name, "id": sid, "outcome": "succeeded", "flow": step.flow, "run_id": child})
