"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type KeyboardEvent } from "react";
import { api } from "@/components/news/api";
import { Field } from "@/components/news/Fld";
import { Alert, Button, Input, Textarea } from "@/components/ui/form";
import type { Category } from "@/lib/crewai/catalog-shared";
import { CategoryPicker, TagInput } from "./CatalogDetails";

type Op = "contains" | "not_contains" | "min_length" | "equals" | "not_equals" | "empty" | "not_empty";
type Cond = { value: string; op: Op; operand: string };
type Rules = {
  id?: string | null;
  label?: string;
  needs?: string[];
  when?: Cond | null;
  retry?: { attempts: number; delay_seconds: number; backoff: number } | null;
  timeout_seconds?: number | null;
  on_failure?: "stop" | "continue" | "fallback";
  fallback?: string | null;
};
type CrewStep = Rules & { kind: "crew"; crew: string; inputs: Record<string, string>; save_as: string };
type FlowStep = Rules & { kind: "flow"; flow: string; inputs: Record<string, string>; save_as?: string | null; wait?: boolean };
type ConditionStep = Rules & { kind: "condition"; value: string; op: Op; operand: string; otherwise: "stop" | "skip_next" };
type DraftStep = Rules & { kind: "draft"; title: string; description: string; body: string; collection: "blog" | "news"; category: string | null };
type Step = CrewStep | FlowStep | ConditionStep | DraftStep;
export type FlowSpec = { key: string; label: string; description: string; inputs: string[]; steps: Step[] };
export type CrewOption = { key: string; label: string; inputs: { name: string; required?: boolean; description?: string }[]; enabled: boolean };
export type FlowOption = { name: string; label: string; inputs: { name: string; required: boolean }[] };

export const BLANK_FLOW: FlowSpec = { key: "", label: "", description: "", inputs: ["topic"], steps: [] };

const OPS: { id: Op; label: string; operand: boolean }[] = [
  { id: "not_empty", label: "is not empty", operand: false },
  { id: "empty", label: "is empty", operand: false },
  { id: "contains", label: "contains", operand: true },
  { id: "not_contains", label: "does not contain", operand: true },
  { id: "equals", label: "equals", operand: true },
  { id: "not_equals", label: "does not equal", operand: true },
  { id: "min_length", label: "is at least (characters)", operand: true },
];
const KIND: Record<Step["kind"], { name: string; icon: string; hint: string }> = {
  crew: { name: "Crew", icon: "◆", hint: "Run a crew and keep its output" },
  flow: { name: "Flow", icon: "↳", hint: "Start another flow and wait for it" },
  condition: { name: "Condition", icon: "◇", hint: "Check a value; stop or skip when it does not hold" },
  draft: { name: "Draft", icon: "✎", hint: "Put a draft in the review queue" },
};
const sel = "min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm";

export const stepId = (s: Step, n: number) => s.id || ("save_as" in s && s.save_as) || `step${n}`;
const move = <T,>(list: T[], from: number, to: number) => {
  if (to < 0 || to >= list.length || from === to) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
};

function summary(s: Step, crews: CrewOption[], flows: FlowOption[]): string {
  if (s.kind === "crew") return `${crews.find((c) => c.key === s.crew)?.label ?? (s.crew || "pick a crew")} → {steps.${s.save_as || "?"}}`;
  if (s.kind === "flow") return `${flows.find((f) => f.name === s.flow)?.label ?? (s.flow || "pick a flow")}${s.wait === false ? " (no wait)" : ""}`;
  if (s.kind === "condition") return `${s.value || "?"} ${OPS.find((o) => o.id === s.op)?.label ?? s.op} ${s.operand} · otherwise ${s.otherwise === "stop" ? "stop" : "skip next"}`;
  return `“${s.title || "untitled"}” to ${s.collection}`;
}

/** Problems the builder can see before the agent checks the spec (it checks everything again on save). */
function problems(s: FlowSpec): string[] {
  const out: string[] = [];
  const ids = s.steps.map((x, i) => stepId(x, i + 1));
  ids.forEach((id, i) => ids.indexOf(id) !== i && out.push(`Step ${i + 1}: the id ${id} is used twice.`));
  const saved: string[] = [];
  s.steps.forEach((st, i) => {
    const texts: unknown[] = st.kind === "crew" || st.kind === "flow" ? Object.values(st.inputs ?? {}) : st.kind === "condition" ? [st.value] : [st.title, st.description, st.body];
    if (st.when) texts.push(st.when.value);
    for (const t of texts.filter((x): x is string => typeof x === "string")) for (const m of t.matchAll(/\{(input|steps)\.([a-z][a-z0-9_]*)\}/g)) {
      if (m[1] === "input" && !s.inputs.includes(m[2]!)) out.push(`Step ${i + 1} uses {input.${m[2]}}, which the flow does not have.`);
      if (m[1] === "steps" && !saved.includes(m[2]!)) out.push(`Step ${i + 1} uses {steps.${m[2]}} before a step saves it.`);
    }
    for (const n of st.needs ?? []) if (!ids.slice(0, i).includes(n)) out.push(`Step ${i + 1} needs ${n}, which is not an earlier step.`);
    if (st.on_failure === "fallback" && !(st.fallback && ids.slice(i + 1).includes(st.fallback))) out.push(`Step ${i + 1}: pick a later step as its fallback.`);
    if (st.kind === "crew" && !st.crew) out.push(`Step ${i + 1}: pick a crew.`);
    if (st.kind === "flow" && !st.flow) out.push(`Step ${i + 1}: pick a flow.`);
    const save = "save_as" in st ? st.save_as : null;
    if (save) saved.push(save);
  });
  if (!s.steps.some((x) => x.kind === "crew" || x.kind === "flow")) out.push("A flow needs at least one crew or flow step.");
  return [...new Set(out)];
}

/** The spec as the agent stores it. */
function clean(s: FlowSpec): FlowSpec {
  return {
    ...s,
    steps: s.steps.map((st) => {
      const x = { ...st } as Step & Record<string, unknown>;
      if (!x.id) delete x.id;
      if (!x.label) delete x.label;
      if (!x.needs?.length) delete x.needs;
      if (!x.when) delete x.when;
      if (!x.retry || !x.retry.attempts) delete x.retry;
      if (!x.timeout_seconds) delete x.timeout_seconds;
      if (!x.on_failure || x.on_failure === "stop") delete x.on_failure;
      if (x.on_failure !== "fallback") delete x.fallback;
      if (x.kind === "flow" && !x.save_as) delete x.save_as;
      return x as Step;
    }),
  };
}

/**
 * The flow builder (AI & SEO → Flows → New flow, and every flow defined by steps). Steps run top to bottom: drag a step
 * by its handle, or select it and press Alt+↑ / Alt+↓, to reorder. Select a step to configure it on the right: what it
 * runs and with which inputs, when it runs (the steps it needs, a condition on it) and what happens when it fails
 * (retries, a time limit, stop / continue / a fallback step). Values are text with {input.name} and {steps.name}.
 * Check asks the SEO agent; Test run runs the draft in the editor without creating drafts or starting other flows.
 */
export function CustomFlowEditor({ initial, isNew, enabled, crews, flows, categories = [] }: { initial: FlowSpec; isNew: boolean; enabled: boolean; crews: CrewOption[]; flows: FlowOption[]; categories?: Category[] }) {
  const router = useRouter();
  // A saved spec may leave optional fields out; the editor works on a complete copy and compares against it.
  const [base] = useState<FlowSpec>(() => ({ ...initial, inputs: initial.inputs ?? [], steps: (initial.steps ?? []).map((x) => (x.kind === "draft" ? { ...x, description: x.description ?? "", category: x.category ?? null } : x.kind === "crew" || x.kind === "flow" ? { ...x, inputs: x.inputs ?? {} } : x)) }));
  const [s, setS] = useState<FlowSpec>(base);
  const [meta, setMeta] = useState<{ categories: string[]; tags: string[] }>({ categories: [], tags: [] });
  const [at, setAt] = useState<number | null>(base.steps.length ? 0 : null);
  const [drag, setDrag] = useState<number | null>(null);
  const [run, setRun] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[]; runId?: string } | null>(null);
  const issues = useMemo(() => problems(s), [s]);
  const dirty = JSON.stringify(s) !== JSON.stringify(base);
  const step = at == null ? null : (s.steps[at] ?? null);
  const setStep = (i: number, p: Partial<Step>) => setS((x) => ({ ...x, steps: x.steps.map((y, j) => (j === i ? ({ ...y, ...p } as Step) : y)) }));
  const reorder = (from: number, to: number) => {
    setS((x) => ({ ...x, steps: move(x.steps, from, to) }));
    setAt(to);
  };
  const call = async (fn: () => Promise<{ runId?: string } | unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as { runId?: string } | undefined;
      setMsg({ ok: true, text: ok, runId: r?.runId });
      router.refresh();
    } catch (e) {
      const [head, ...more] = (e as Error).message.split(" · ");
      setMsg({ ok: false, text: head ?? "Failed.", issues: more });
    } finally {
      setBusy(false);
    }
  };
  const add = (kind: Step["kind"]) => {
    const n = s.steps.length + 1;
    const c = crews.find((x) => x.enabled) ?? crews[0];
    const out = [...s.steps].reverse().find((x) => "save_as" in x && x.save_as) as CrewStep | undefined;
    const next: Step =
      kind === "crew"
        ? { kind, crew: c?.key ?? "", inputs: Object.fromEntries((c?.inputs ?? []).map((i) => [i.name, s.inputs.includes(i.name) ? `{input.${i.name}}` : ""])), save_as: n === 1 ? "result" : `result_${n}` }
        : kind === "flow"
          ? { kind, flow: flows[0]?.name ?? "", inputs: {}, save_as: null, wait: true }
          : kind === "condition"
            ? { kind, value: out ? `{steps.${out.save_as}}` : "", op: "min_length", operand: "200", otherwise: "stop" }
            : { kind, title: s.inputs[0] ? `{input.${s.inputs[0]}}` : "", description: "", body: out ? `{steps.${out.save_as}}` : "", collection: "blog", category: null };
    setS({ ...s, steps: [...s.steps, next] });
    setAt(s.steps.length);
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      reorder(i, e.key === "ArrowUp" ? i - 1 : i + 1);
    }
  };
  const save = () =>
    call(async () => {
      const spec = clean(s);
      if (isNew) {
        await api("/api/admin/crewai/catalog/flows", "POST", { key: s.key, label: s.label, description: s.description, categories: meta.categories, tags: meta.tags, spec });
        router.push(`/admin/crewai/flows/${s.key}`);
      } else {
        await api(`/api/admin/crewai/catalog/flows/${s.key}`, "PATCH", { spec, ...(note.trim() ? { note: note.trim() } : {}) });
        setNote("");
      }
    }, isNew ? "Created. The SEO agent checked it." : "Saved as a new version. The SEO agent checked it.");
  const ids = s.steps.map((x, i) => stepId(x, i + 1));
  const refsAt = (i: number) => [...s.inputs.map((k) => `{input.${k}}`), ...s.steps.slice(0, i).flatMap((x) => ("save_as" in x && x.save_as ? [`{steps.${x.save_as}}`] : []))];

  return (
    <div className="space-y-8">
      <section aria-labelledby="flow-basics" className="grid gap-4 sm:grid-cols-2">
        <h2 id="flow-basics" className="sr-only">Flow</h2>
        <Field label="Key" hint="2–40 lower-case letters, digits or _; it cannot change later.">
          <Input value={s.key} disabled={!isNew} onChange={(e) => setS({ ...s, key: e.target.value.trim() })} />
        </Field>
        <Field label="Name"><Input value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })} maxLength={120} /></Field>
        <div className="sm:col-span-2"><Field label="Description"><Textarea rows={2} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></Field></div>
        <div className="sm:col-span-2">
          <Field label="Inputs (comma-separated)" hint="What a run asks for (Run now, a schedule, a test run); steps use them as {input.name}.">
            <Input value={s.inputs.join(", ")} onChange={(e) => setS({ ...s, inputs: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </Field>
        </div>
        {isNew && (
          <>
            <div className="sm:col-span-2"><CategoryPicker categories={categories} value={meta.categories} onChange={(c) => setMeta({ ...meta, categories: c })} /></div>
            <div className="space-y-1.5 sm:col-span-2"><label htmlFor="new-flow-tags" className="text-sm font-medium text-fg">Tags</label><TagInput id="new-flow-tags" value={meta.tags} onChange={(t) => setMeta({ ...meta, tags: t })} /></div>
          </>
        )}
      </section>

      <section aria-labelledby="steps-h" className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="steps-h" className="text-base font-semibold text-fg">Steps</h2>
            <span className="text-xs text-fg-subtle">Drag ⠿ or Alt+↑/↓ to reorder</span>
          </div>
          {s.steps.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-4 text-sm text-fg-muted">No steps yet. Add a crew or a flow step to start; conditions and drafts work on their output.</p>
          ) : (
            <ol className="space-y-0" aria-label="Steps in run order">
              {s.steps.map((st, i) => {
                const rules = [st.needs?.length ? `needs ${st.needs.join(", ")}` : "", st.when ? "if…" : "", st.retry?.attempts ? `retry ×${st.retry.attempts}` : "", st.timeout_seconds ? `${st.timeout_seconds}s` : "", st.on_failure && st.on_failure !== "stop" ? (st.on_failure === "continue" ? "continue on failure" : `fallback → ${st.fallback}`) : "", ids.filter((_, j) => s.steps[j]?.fallback === ids[i]).length ? "fallback only" : ""].filter(Boolean);
                return (
                  <li
                    key={i}
                    draggable
                    onDragStart={() => setDrag(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (drag != null) reorder(drag, i);
                      setDrag(null);
                    }}
                    onDragEnd={() => setDrag(null)}
                    className={`relative pl-6 ${drag === i ? "opacity-50" : ""}`}
                  >
                    {i < s.steps.length - 1 && <span aria-hidden="true" className="absolute left-[11px] top-9 h-[calc(100%-1.25rem)] w-px bg-line" />}
                    <span aria-hidden="true" className="absolute left-0 top-3 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-xs text-fg-muted">{i + 1}</span>
                    <button
                      type="button"
                      onClick={() => setAt(i)}
                      onKeyDown={(e) => onKey(e, i)}
                      aria-current={at === i ? "step" : undefined}
                      aria-label={`Step ${i + 1}: ${KIND[st.kind].name} ${st.label || ids[i]}. Alt plus arrow keys to move.`}
                      className={`mb-2 ml-2 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded-lg border px-3 py-2 text-left ${at === i ? "border-accent bg-accent/5 ring-2 ring-accent/20" : "border-line bg-surface hover:border-line-strong"}`}
                    >
                      <span aria-hidden="true" className="mt-0.5 cursor-grab select-none text-fg-subtle" title="Drag to reorder">⠿</span>
                      <span aria-hidden="true" className="mt-0.5 text-accent-text">{KIND[st.kind].icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-fg">{st.label || `${KIND[st.kind].name} · ${ids[i]}`}</span>
                        <span className="block truncate text-xs text-fg-muted">{summary(st, crews, flows)}</span>
                        {rules.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{rules.map((r) => <span key={r} className="rounded bg-surface-muted px-1.5 py-0.5 text-[11px] text-fg-muted">{r}</span>)}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Add a step">
            {(Object.keys(KIND) as Step["kind"][]).map((k) => (
              <Button key={k} variant="secondary" size="sm" onClick={() => add(k)} title={KIND[k].hint} disabled={k === "crew" && crews.length === 0}>+ {KIND[k].name}</Button>
            ))}
          </div>
          {crews.length === 0 && <Alert tone="info">No crew is on yet: <Link className="underline" href="/admin/crewai/crews/new">make one</Link>, or duplicate one under Crews.</Alert>}
        </div>

        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          {!step || at == null ? (
            <p className="rounded-lg border border-dashed border-line p-4 text-sm text-fg-muted">Select a step to configure it.</p>
          ) : (
            <StepPanel
              key={at}
              step={step}
              index={at}
              count={s.steps.length}
              ids={ids}
              refs={refsAt(at)}
              crews={crews}
              flows={flows}
              onChange={(p) => setStep(at, p)}
              onMove={(by) => reorder(at, at + by)}
              onRemove={() => {
                setS({ ...s, steps: s.steps.filter((_, j) => j !== at) });
                setAt(s.steps.length > 1 ? Math.max(0, at - 1) : null);
              }}
            />
          )}
        </div>
      </section>

      {issues.length > 0 && (
        <Alert tone="info">
          Before it can run:
          <ul className="mt-1 list-disc pl-5 text-sm">{issues.map((x) => <li key={x}>{x}</li>)}</ul>
        </Alert>
      )}

      <section aria-labelledby="flow-save" className="space-y-3 border-t border-line pt-6">
        <h2 id="flow-save" className="sr-only">Save</h2>
        {!isNew && <Field label="What changed (optional)" hint="Kept with the new version."><Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={save}>{isNew ? "Create flow" : "Save as new version"}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => call(() => api("/api/admin/crewai/catalog/flows/validate", "POST", { spec: clean(s) }), "The SEO agent accepts this flow.")}>Check</Button>
          {dirty && !isNew && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
        </div>
      </section>

      <section aria-labelledby="run-h" className="space-y-3 rounded-xl border border-line p-4">
        <h2 id="run-h" className="text-base font-semibold text-fg">Test and run</h2>
        <p className="text-sm text-fg-muted">
          <strong>Test run</strong> runs the flow as it is in the editor (saved or not): its crews run, but no draft is created and no other flow is started; each step&apos;s result, retries and conditions are on the run page. <strong>Run now</strong> runs the saved flow for real{enabled ? "" : " once it is switched on"}. Model calls count in the LLM budget either way. To run it on a schedule, add one for it under <Link className="underline" href="/admin/crewai/schedules?flow=custom_flow">Schedules</Link>.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {s.inputs.map((k) => <Field key={k} label={k}><Input value={run[k] ?? ""} onChange={(e) => setRun({ ...run, [k]: e.target.value })} /></Field>)}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy || !s.key} onClick={() => call(() => api<{ runId: string }>("/api/admin/crewai/catalog/flows/test", "POST", dirty || isNew ? { draft: clean(s), inputs: run } : { flow: s.key, inputs: run }), "Test run started.")}>Test run</Button>
          {!isNew && <Button disabled={busy || !enabled || dirty} onClick={() => call(() => api<{ runId: string }>("/api/admin/crewai/flows/custom_flow", "POST", { inputs: { flow: s.key, inputs: run, dry_run: false } }), "Run started.")} title={dirty ? "Save first: Run now runs the saved flow." : !enabled ? "Switch the flow on first." : undefined}>Run now</Button>}
        </div>
      </section>

      {msg && (
        <Alert tone={msg.ok ? "success" : "error"}>
          {msg.text} {msg.runId && <Link className="underline" href={`/admin/crewai/runs/${msg.runId}`}>Open the run</Link>}
          {msg.issues && msg.issues.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{msg.issues.map((x) => <li key={x}>{x}</li>)}</ul>}
        </Alert>
      )}
    </div>
  );
}

function StepPanel({ step, index, count, ids, refs, crews, flows, onChange, onMove, onRemove }: { step: Step; index: number; count: number; ids: string[]; refs: string[]; crews: CrewOption[]; flows: FlowOption[]; onChange: (p: Partial<Step>) => void; onMove: (by: number) => void; onRemove: () => void }) {
  const earlier = ids.slice(0, index);
  const later = ids.slice(index + 1);
  const retry = step.retry ?? { attempts: 0, delay_seconds: 0, backoff: 1 };
  return (
    <div className="space-y-5 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Step {index + 1} · {KIND[step.kind].name}</h3>
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Move step up">↑</Button>
          <Button variant="ghost" size="sm" onClick={() => onMove(1)} disabled={index === count - 1} aria-label="Move step down">↓</Button>
          <Button variant="ghost" size="sm" onClick={onRemove} className="text-red-700 dark:text-red-300">Remove</Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name (optional)"><Input value={step.label ?? ""} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} /></Field>
        <Field label="Step id (optional)" hint={`Other steps name it by this. Now: ${ids[index]}`}><Input value={step.id ?? ""} onChange={(e) => onChange({ id: e.target.value.trim() || null })} /></Field>
      </div>

      {step.kind === "crew" && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Crew" hint="Any crew; one defined in code runs with the tools that need no fixed article.">
              <select className={sel} value={step.crew} onChange={(e) => { const c = crews.find((x) => x.key === e.target.value); onChange({ crew: e.target.value, inputs: Object.fromEntries((c?.inputs ?? []).map((k) => [k.name, step.inputs[k.name] ?? ""])) }); }}>
                {!crews.some((c) => c.key === step.crew) && <option value={step.crew}>{step.crew || "Pick a crew"}</option>}
                {crews.map((c) => <option key={c.key} value={c.key}>{c.label}{c.enabled ? "" : " (off)"}</option>)}
              </select>
            </Field>
            <Field label="Save its output as" hint="Later steps use it as {steps.name}."><Input value={step.save_as} onChange={(e) => onChange({ save_as: e.target.value.trim() })} /></Field>
          </div>
          <Inputs values={step.inputs} names={(crews.find((c) => c.key === step.crew)?.inputs ?? []).map((i) => ({ name: i.name, required: Boolean(i.required), hint: i.description }))} onChange={(inputs) => onChange({ inputs })} />
        </div>
      )}
      {step.kind === "flow" && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Flow" hint="Runs as its own run (trigger: another flow). Approval-only flows cannot be started here.">
              <select className={sel} value={step.flow} onChange={(e) => { const f = flows.find((x) => x.name === e.target.value); onChange({ flow: e.target.value, inputs: Object.fromEntries((f?.inputs ?? []).map((k) => [k.name, step.inputs[k.name] ?? ""])) }); }}>
                {!flows.some((f) => f.name === step.flow) && <option value={step.flow}>{step.flow || "Pick a flow"}</option>}
                {flows.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Save its outputs as (optional)" hint="The child run's outputs, as JSON text."><Input value={step.save_as ?? ""} onChange={(e) => onChange({ save_as: e.target.value.trim() || null })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={step.wait !== false} onChange={(e) => onChange({ wait: e.target.checked })} /> Wait for it to finish (its failure is this step&apos;s failure)</label>
          <Inputs values={step.inputs} names={(flows.find((f) => f.name === step.flow)?.inputs ?? []).map((i) => ({ name: i.name, required: i.required }))} onChange={(inputs) => onChange({ inputs })} free />
        </div>
      )}
      {step.kind === "condition" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Value"><Input value={step.value} placeholder="{steps.result}" onChange={(e) => onChange({ value: e.target.value })} /></Field>
          <Field label="Check">
            <select className={sel} value={step.op} onChange={(e) => onChange({ op: e.target.value as Op })}>{OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
          </Field>
          {OPS.find((o) => o.id === step.op)?.operand && <Field label={step.op === "min_length" ? "Characters" : "Text"}><Input value={step.operand} onChange={(e) => onChange({ operand: e.target.value })} /></Field>}
          <Field label="Otherwise">
            <select className={sel} value={step.otherwise} onChange={(e) => onChange({ otherwise: e.target.value as ConditionStep["otherwise"] })}>
              <option value="stop">stop the flow</option>
              <option value="skip_next">skip the next step</option>
            </select>
          </Field>
        </div>
      )}
      {step.kind === "draft" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title"><Input value={step.title} onChange={(e) => onChange({ title: e.target.value })} /></Field>
          <Field label="Description"><Input value={step.description} onChange={(e) => onChange({ description: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Body (MDX)"><Input value={step.body} placeholder="{steps.result}" onChange={(e) => onChange({ body: e.target.value })} /></Field></div>
          <Field label="Collection">
            <select className={sel} value={step.collection} onChange={(e) => onChange({ collection: e.target.value as DraftStep["collection"] })}>
              <option value="blog">Blog</option>
              <option value="news">News</option>
            </select>
          </Field>
          <Field label="Category (optional)"><Input value={step.category ?? ""} placeholder="kubernetes" onChange={(e) => onChange({ category: e.target.value.trim() || null })} /></Field>
        </div>
      )}
      {refs.length > 0 && <p className="text-xs text-fg-subtle">Available here: {refs.join(" · ")}</p>}

      <fieldset className="space-y-3 border-t border-line pt-4">
        <legend className="text-sm font-semibold text-fg">When it runs</legend>
        {earlier.length > 0 && (
          <div>
            <p className="text-sm text-fg">Needs <span className="text-xs text-fg-subtle" title="This step is skipped unless every step ticked here succeeded.">(skipped unless these succeeded)</span></p>
            <div className="mt-1 flex flex-wrap gap-3">
              {earlier.map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={(step.needs ?? []).includes(k)} onChange={(e) => onChange({ needs: e.target.checked ? [...(step.needs ?? []), k] : (step.needs ?? []).filter((x) => x !== k) })} /> {k}
                </label>
              ))}
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(step.when)} onChange={(e) => onChange({ when: e.target.checked ? { value: refs.at(-1) ?? "", op: "not_empty", operand: "" } : null })} /> Only if a condition holds</label>
        {step.when && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Value"><Input value={step.when.value} onChange={(e) => onChange({ when: { ...step.when!, value: e.target.value } })} /></Field>
            <Field label="Check"><select className={sel} value={step.when.op} onChange={(e) => onChange({ when: { ...step.when!, op: e.target.value as Op } })}>{OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></Field>
            {OPS.find((o) => o.id === step.when!.op)?.operand && <Field label="Against"><Input value={step.when.operand} onChange={(e) => onChange({ when: { ...step.when!, operand: e.target.value } })} /></Field>}
          </div>
        )}
      </fieldset>

      {(step.kind === "crew" || step.kind === "flow" || step.kind === "draft") && (
        <fieldset className="space-y-3 border-t border-line pt-4">
          <legend className="text-sm font-semibold text-fg">If it fails</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Retries" hint="Attempts after the first (0–5)."><Input inputMode="numeric" value={retry.attempts} onChange={(e) => onChange({ retry: { ...retry, attempts: Math.max(0, Math.min(5, Number.parseInt(e.target.value || "0", 10) || 0)) } })} /></Field>
            <Field label="Wait between (seconds)" hint="0–600."><Input inputMode="decimal" value={retry.delay_seconds} onChange={(e) => onChange({ retry: { ...retry, delay_seconds: Math.max(0, Math.min(600, Number(e.target.value) || 0)) } })} /></Field>
            <Field label="Backoff ×" hint="1–4: each wait is the last × this."><Input inputMode="decimal" value={retry.backoff} onChange={(e) => onChange({ retry: { ...retry, backoff: Math.max(1, Math.min(4, Number(e.target.value) || 1)) } })} /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Time limit (seconds, optional)" hint="5–3600 per attempt."><Input inputMode="numeric" value={step.timeout_seconds ?? ""} onChange={(e) => onChange({ timeout_seconds: e.target.value.trim() ? Number.parseInt(e.target.value, 10) : null })} /></Field>
            <Field label="Then">
              <select className={sel} value={step.on_failure ?? "stop"} onChange={(e) => onChange({ on_failure: e.target.value as Rules["on_failure"], fallback: e.target.value === "fallback" ? (step.fallback ?? later[0] ?? null) : null })}>
                <option value="stop">stop the flow (it fails)</option>
                <option value="continue">continue with the next steps</option>
                <option value="fallback" disabled={later.length === 0}>run a fallback step</option>
              </select>
            </Field>
            {step.on_failure === "fallback" && (
              <Field label="Fallback step" hint="It runs only when this step fails.">
                <select className={sel} value={step.fallback ?? ""} onChange={(e) => onChange({ fallback: e.target.value })}>{later.map((k) => <option key={k} value={k}>{k}</option>)}</select>
              </Field>
            )}
          </div>
        </fieldset>
      )}
    </div>
  );
}

function Inputs({ values, names, onChange, free = false }: { values: Record<string, string>; names: { name: string; required: boolean; hint?: string }[]; onChange: (v: Record<string, string>) => void; free?: boolean }) {
  const keys = [...new Set([...names.map((n) => n.name), ...Object.keys(values)])];
  const [extra, setExtra] = useState("");
  return (
    <div className="space-y-2">
      {keys.length === 0 && !free && <p className="text-xs text-fg-subtle">This crew takes no inputs.</p>}
      {keys.map((k) => {
        const n = names.find((x) => x.name === k);
        return (
          <Field key={k} label={`Input ${k}${n?.required ? " *" : ""}`} hint={n?.hint}>
            <div className="flex flex-wrap gap-2 sm:flex-nowrap">
              <Input value={values[k] ?? ""} onChange={(e) => onChange({ ...values, [k]: e.target.value })} placeholder={n?.required ? "required" : "optional"} />
              {!n && <Button variant="ghost" size="sm" onClick={() => { const v = { ...values }; delete v[k]; onChange(v); }} aria-label={`Remove input ${k}`}>×</Button>}
            </div>
          </Field>
        );
      })}
      {free && (
        <div className="flex flex-wrap gap-2 sm:flex-nowrap">
          <Input value={extra} placeholder="Add an input by name" onChange={(e) => setExtra(e.target.value.trim())} aria-label="New input name" />
          <Button variant="ghost" size="sm" disabled={!/^[a-z_][a-z0-9_]{0,59}$/.test(extra) || extra in values} onClick={() => { onChange({ ...values, [extra]: "" }); setExtra(""); }}>Add</Button>
        </div>
      )}
    </div>
  );
}
