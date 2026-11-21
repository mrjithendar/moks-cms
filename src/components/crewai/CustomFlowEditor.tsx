"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/news/api";
import { Field } from "@/components/news/Fld";
import { Alert, Button, Input, Textarea } from "@/components/ui/form";

type CrewStep = { kind: "crew"; crew: string; inputs: Record<string, string>; save_as: string };
type ConditionStep = { kind: "condition"; value: string; op: "contains" | "not_contains" | "min_length"; operand: string; otherwise: "stop" | "skip_next" };
type DraftStep = { kind: "draft"; title: string; description: string; body: string; collection: "blog" | "news"; category: string | null };
type Step = CrewStep | ConditionStep | DraftStep;
export type FlowSpec = { key: string; label: string; description: string; inputs: string[]; steps: Step[] };
export type CrewOption = { key: string; label: string; inputs: string[] };

export const BLANK_FLOW: FlowSpec = { key: "", label: "", description: "", inputs: ["topic"], steps: [] };

const sel = "min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm";
const move = <T,>(list: T[], i: number, by: number) => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
};

/**
 * AI & SEO → Flows → New flow / a custom flow: steps in order. A crew step runs one of your custom crews; a condition
 * checks an earlier output and stops the flow or skips the next step; a draft step puts a draft in the review queue.
 * Values are text with {input.name} and {steps.name}. There is no step that publishes: a person approves every draft.
 */
export function CustomFlowEditor({ initial, isNew, enabled, crews }: { initial: FlowSpec; isNew: boolean; enabled: boolean; crews: CrewOption[] }) {
  const router = useRouter();
  const [s, setS] = useState<FlowSpec>(initial);
  const [run, setRun] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[]; runId?: string } | null>(null);
  const setStep = (i: number, p: Partial<Step>) => setS((x) => ({ ...x, steps: x.steps.map((y, j) => (j === i ? ({ ...y, ...p } as Step) : y)) }));
  const call = async (fn: () => Promise<{ runId?: string } | unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as { runId?: string } | undefined;
      setMsg({ ok: true, text: ok, runId: r?.runId });
      router.refresh();
    } catch (e) {
      const [head, ...issues] = (e as Error).message.split(" · ");
      setMsg({ ok: false, text: head ?? "Failed.", issues });
    } finally {
      setBusy(false);
    }
  };
  const add = (kind: Step["kind"]) => {
    const n = s.steps.filter((x) => x.kind === "crew").length + 1;
    const c = crews[0];
    const step: Step =
      kind === "crew"
        ? { kind, crew: c?.key ?? "", inputs: Object.fromEntries((c?.inputs ?? []).map((k) => [k, s.inputs.includes(k) ? `{input.${k}}` : ""])), save_as: n === 1 ? "result" : `result_${n}` }
        : kind === "condition"
          ? { kind, value: "", op: "min_length", operand: "200", otherwise: "stop" }
          : { kind, title: s.inputs[0] ? `{input.${s.inputs[0]}}` : "", description: "", body: "", collection: "blog", category: null };
    setS({ ...s, steps: [...s.steps, step] });
  };
  const savedBefore = (i: number) => s.steps.slice(0, i).flatMap((x) => (x.kind === "crew" ? [x.save_as] : []));

  return (
    <div className="space-y-8">
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Key" hint="2–40 lower-case letters, digits or _; it cannot change later.">
          <Input value={s.key} disabled={!isNew} onChange={(e) => setS({ ...s, key: e.target.value.trim() })} />
        </Field>
        <Field label="Name"><Input value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })} maxLength={120} /></Field>
        <div className="sm:col-span-2"><Field label="Description"><Textarea rows={2} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></Field></div>
        <div className="sm:col-span-2">
          <Field label="Inputs (comma-separated)" hint="What a run asks for; steps use them as {input.name}.">
            <Input value={s.inputs.join(", ")} onChange={(e) => setS({ ...s, inputs: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </Field>
        </div>
      </section>

      <section aria-labelledby="steps" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="steps" className="text-base font-semibold text-fg">Steps, in order</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => add("crew")} disabled={crews.length === 0}>Add crew step</Button>
            <Button variant="ghost" onClick={() => add("condition")}>Add condition</Button>
            <Button variant="ghost" onClick={() => add("draft")}>Add draft step</Button>
          </div>
        </div>
        {crews.length === 0 && <Alert tone="info">Make a custom crew first (<Link className="underline" href="/admin/crewai/crews/custom/new">Crews → New crew</Link>); a flow runs your custom crews.</Alert>}
        {s.steps.length === 0 && <p className="text-sm text-fg-muted">No steps yet. A flow needs at least one crew step.</p>}
        {s.steps.map((st, i) => {
          const refs = [...s.inputs.map((k) => `{input.${k}}`), ...savedBefore(i).map((k) => `{steps.${k}}`)];
          return (
            <div key={i} className="space-y-3 rounded-xl border border-line p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Step {i + 1} · {st.kind === "crew" ? "Run a crew" : st.kind === "condition" ? "Condition" : "Draft for review"}</p>
              {st.kind === "crew" && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Crew">
                      <select className={sel} value={st.crew} onChange={(e) => { const c = crews.find((x) => x.key === e.target.value); setStep(i, { crew: e.target.value, inputs: Object.fromEntries((c?.inputs ?? []).map((k) => [k, st.inputs[k] ?? ""])) }); }}>
                        {crews.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                    </Field>
                    <Field label="Save its output as" hint="Later steps use it as {steps.name}."><Input value={st.save_as} onChange={(e) => setStep(i, { save_as: e.target.value.trim() })} /></Field>
                  </div>
                  {Object.keys(st.inputs).map((k) => (
                    <Field key={k} label={`Crew input ${k}`}><Input value={st.inputs[k]} onChange={(e) => setStep(i, { inputs: { ...st.inputs, [k]: e.target.value } })} /></Field>
                  ))}
                </>
              )}
              {st.kind === "condition" && (
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Value"><Input value={st.value} placeholder="{steps.result}" onChange={(e) => setStep(i, { value: e.target.value })} /></Field>
                  <Field label="Check">
                    <select className={sel} value={st.op} onChange={(e) => setStep(i, { op: e.target.value as ConditionStep["op"] })}>
                      <option value="min_length">is at least (characters)</option>
                      <option value="contains">contains</option>
                      <option value="not_contains">does not contain</option>
                    </select>
                  </Field>
                  <Field label={st.op === "min_length" ? "Characters" : "Text"}><Input value={st.operand} onChange={(e) => setStep(i, { operand: e.target.value })} /></Field>
                  <Field label="Otherwise">
                    <select className={sel} value={st.otherwise} onChange={(e) => setStep(i, { otherwise: e.target.value as ConditionStep["otherwise"] })}>
                      <option value="stop">stop the flow</option>
                      <option value="skip_next">skip the next step</option>
                    </select>
                  </Field>
                </div>
              )}
              {st.kind === "draft" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Title"><Input value={st.title} onChange={(e) => setStep(i, { title: e.target.value })} /></Field>
                  <Field label="Description"><Input value={st.description} onChange={(e) => setStep(i, { description: e.target.value })} /></Field>
                  <div className="sm:col-span-2"><Field label="Body (MDX)"><Input value={st.body} placeholder="{steps.result}" onChange={(e) => setStep(i, { body: e.target.value })} /></Field></div>
                  <Field label="Collection">
                    <select className={sel} value={st.collection} onChange={(e) => setStep(i, { collection: e.target.value as DraftStep["collection"] })}>
                      <option value="blog">Blog</option>
                      <option value="news">News</option>
                    </select>
                  </Field>
                  <Field label="Category (optional)"><Input value={st.category ?? ""} placeholder="kubernetes" onChange={(e) => setStep(i, { category: e.target.value.trim() || null })} /></Field>
                </div>
              )}
              {refs.length > 0 && <p className="text-xs text-fg-subtle">Available here: {refs.join(" · ")}</p>}
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setS({ ...s, steps: move(s.steps, i, -1) })} disabled={i === 0}>Up</Button>
                <Button variant="ghost" onClick={() => setS({ ...s, steps: move(s.steps, i, 1) })} disabled={i === s.steps.length - 1}>Down</Button>
                <Button variant="ghost" onClick={() => setS({ ...s, steps: s.steps.filter((_, j) => j !== i) })}>Remove</Button>
              </div>
            </div>
          );
        })}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={() => call(async () => { await api("/api/admin/crewai/custom/flows", "POST", { spec: s }); if (isNew) router.push(`/admin/crewai/flows/custom/${s.key}`); }, "Saved. The SEO agent checked it.")}>{isNew ? "Create flow" : "Save"}</Button>
        {!isNew && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => call(() => api(`/api/admin/crewai/custom/flows/${s.key}`, "PATCH", { enabled: !enabled }), enabled ? "Switched off." : "Switched on.")}>{enabled ? "Switch off" : "Switch on"}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`Delete the custom flow ${s.label || s.key}? Its schedules are removed; its run history stays.`)) call(async () => { await api(`/api/admin/crewai/custom/flows/${s.key}`, "DELETE"); router.push("/admin/crewai/flows"); }, "Deleted."); }}>Delete</Button>
          </>
        )}
      </div>

      {!isNew && enabled && (
        <section aria-labelledby="run" className="space-y-3 rounded-xl border border-line p-4">
          <h2 id="run" className="text-base font-semibold text-fg">Run it</h2>
          <p className="text-sm text-fg-muted">Test run: every step runs except the draft step, which only shows what it would create. Run now creates the draft for review. Model calls count in the LLM budget either way. To run it on a schedule, add a system job for the Custom flow with these inputs (AI &amp; SEO → Jobs → System jobs → New schedule).</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {initial.inputs.map((k) => <Field key={k} label={k}><Input value={run[k] ?? ""} onChange={(e) => setRun({ ...run, [k]: e.target.value })} /></Field>)}
          </div>
          <div className="flex flex-wrap gap-2">
            {([[true, "Test run"], [false, "Run now"]] as const).map(([dry, label]) => (
              <Button key={label} variant={dry ? "ghost" : "primary"} disabled={busy} onClick={() => call(() => api<{ runId: string }>("/api/admin/crewai/flows/custom_flow", "POST", { inputs: { flow: s.key, inputs: run, dry_run: dry } }), dry ? "Test run started." : "Run started.")}>{label}</Button>
            ))}
          </div>
        </section>
      )}
      {msg && (
        <Alert tone={msg.ok ? "success" : "error"}>
          {msg.text} {msg.runId && <Link className="underline" href={`/admin/crewai/runs/${msg.runId}`}>Open the run</Link>}
          {msg.issues && msg.issues.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{msg.issues.map((x) => <li key={x}>{x}</li>)}</ul>}
        </Alert>
      )}
    </div>
  );
}
