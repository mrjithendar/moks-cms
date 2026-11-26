"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/news/api";
import { Field } from "@/components/news/Fld";
import { Alert, Button, Input, Textarea } from "@/components/ui/form";
import type { Category } from "@/lib/crewai/catalog-shared";
import { CategoryPicker, TagInput } from "./CatalogDetails";

/** The tools a spec crew's agent may hold: the agent's CUSTOM_TOOLS (seo-agent/app/crews/custom.py). */
export const CUSTOM_TOOLS: { name: string; hint: string }[] = [
  { name: "vector_search", hint: "search this site's articles by meaning" },
  { name: "read_article", hint: "read one of this site's articles" },
  { name: "gsc_queries_for_topic", hint: "Search Console queries about a topic" },
  { name: "style_guide", hint: "the site's writing style guide" },
  { name: "fetch_allowlisted_docs", hint: "official documentation pages (allowlisted domains)" },
];

type Agent = { key: string; role: string; goal: string; backstory: string; tools: string[]; model?: string | null; max_tokens?: number | null; max_iter?: number | null };
type Task = { key: string; agent: string; label: string; instructions: string; expected_output: string; context: string[] };
export type InputDef = { name: string; label?: string; description?: string; required?: boolean; default?: string };
export type OutputDef = { format: "text" | "json"; required_keys: string[]; description?: string };
export type CrewSpec = { key: string; label: string; description: string; inputs: (string | InputDef)[]; output?: OutputDef | null; model?: string | null; agents: Agent[]; tasks: Task[] };
type Spec = Omit<CrewSpec, "inputs"> & { inputs: InputDef[] };

export const BLANK_CREW: CrewSpec = {
  key: "",
  label: "",
  description: "",
  inputs: [{ name: "topic", description: "What the crew works on", required: true }],
  output: null,
  model: null,
  agents: [{ key: "researcher", role: "Researcher", goal: "", backstory: "", tools: ["vector_search"], model: null }],
  tasks: [{ key: "research", agent: "researcher", label: "Research", instructions: "Research {topic}.", expected_output: "Notes with sources.", context: [] }],
};

const move = <T,>(list: T[], i: number, by: number) => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
};
const sel = "min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm";
const num = (v: string) => (v.trim() === "" ? null : Number.parseInt(v, 10));

/** The spec as the agent stores it: inputs as objects, empty optional fields left out. */
function clean(s: Spec): Record<string, unknown> {
  return {
    ...s,
    model: s.model || null,
    output: s.output && (s.output.format === "json" || s.output.description) ? s.output : null,
    inputs: s.inputs.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), label: i.label ?? "", description: i.description ?? "", required: Boolean(i.required), default: i.default ?? "" })),
    agents: s.agents.map((a) => ({ ...a, model: a.model || null, max_tokens: a.max_tokens || null, max_iter: a.max_iter || null })),
  };
}

/**
 * A crew defined by a spec (made here, or duplicated from any crew): its inputs (the input schema), agents (role, goal,
 * backstory, tools from the allowlist, model and limits), tasks in order, and its output schema. The SEO agent checks
 * the spec on every save and on Check; the rules every crew follows (untrusted data, no delegation or code, the caps)
 * are added by its code. Test run: the crew runs once on the inputs you give, unsaved, and nothing is published or drafted.
 */
export function CustomCrewEditor({ initial, isNew, categories = [] }: { initial: CrewSpec; isNew: boolean; categories?: Category[] }) {
  const router = useRouter();
  const [s, setS] = useState<Spec>({ ...initial, inputs: initial.inputs.map((i) => (typeof i === "string" ? { name: i } : i)) });
  const [meta, setMeta] = useState<{ categories: string[]; tags: string[] }>({ categories: ["custom"].filter((c) => categories.some((x) => x.slug === c)), tags: [] });
  const [note, setNote] = useState("");
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[]; runId?: string } | null>(null);
  const setAgent = (i: number, a: Partial<Agent>) => setS((x) => ({ ...x, agents: x.agents.map((y, j) => (j === i ? { ...y, ...a } : y)) }));
  const setTask = (i: number, t: Partial<Task>) => setS((x) => ({ ...x, tasks: x.tasks.map((y, j) => (j === i ? { ...y, ...t } : y)) }));
  const setInput = (i: number, p: Partial<InputDef>) => setS((x) => ({ ...x, inputs: x.inputs.map((y, j) => (j === i ? { ...y, ...p } : y)) }));
  const call = async (fn: () => Promise<{ runId?: string } | unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as { runId?: string } | undefined;
      setMsg({ ok: true, text: ok, runId: r?.runId });
      router.refresh();
    } catch (e) {
      const text = (e as Error).message;
      const [head, ...issues] = text.split(" · ");
      setMsg({ ok: false, text: head ?? text, issues });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    call(async () => {
      const spec = clean(s);
      if (isNew) {
        await api("/api/admin/crewai/catalog/crews", "POST", { key: s.key, label: s.label, description: s.description, categories: meta.categories, tags: meta.tags, spec });
        router.push(`/admin/crewai/crews/${s.key}`);
      } else {
        await api(`/api/admin/crewai/catalog/crews/${s.key}`, "PATCH", { spec, ...(note.trim() ? { note: note.trim() } : {}) });
        setNote("");
      }
    }, isNew ? "Created. The SEO agent checked it." : "Saved as a new version. The SEO agent checked it; flows run it from their next run.");
  const check = () => call(() => api("/api/admin/crewai/catalog/crews/validate", "POST", { spec: clean(s) }), "The SEO agent accepts this crew.");
  const test = () =>
    call(async () => {
      const key = `test_${s.key || "crew"}`.slice(0, 40);
      const names = s.inputs.map((i) => i.name).filter(Boolean);
      const draft = { key, label: `Test of ${s.label || s.key || "a crew"}`.slice(0, 120), inputs: names, steps: [{ kind: "crew", crew: s.key, inputs: Object.fromEntries(names.map((n) => [n, `{input.${n}}`])), save_as: "result" }] };
      return api<{ runId: string }>("/api/admin/crewai/catalog/flows/test", "POST", { draft, crewDraft: clean(s), inputs: testInputs });
    }, "Test run started: the crew runs once on these inputs. Nothing is saved, drafted or published.");

  return (
    <div className="space-y-8">
      <section aria-labelledby="crew-basics" className="grid gap-4 sm:grid-cols-2">
        <h2 id="crew-basics" className="sr-only">Crew</h2>
        <Field label="Key" hint="2–40 lower-case letters, digits or _; it cannot change later.">
          <Input value={s.key} disabled={!isNew} onChange={(e) => setS({ ...s, key: e.target.value.trim() })} />
        </Field>
        <Field label="Name"><Input value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })} maxLength={120} /></Field>
        <div className="sm:col-span-2"><Field label="Description"><Textarea rows={2} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></Field></div>
        {isNew && (
          <>
            <div className="sm:col-span-2"><CategoryPicker categories={categories} value={meta.categories} onChange={(c) => setMeta({ ...meta, categories: c })} /></div>
            <div className="space-y-1.5 sm:col-span-2"><label htmlFor="new-crew-tags" className="text-sm font-medium text-fg">Tags</label><TagInput id="new-crew-tags" value={meta.tags} onChange={(t) => setMeta({ ...meta, tags: t })} /></div>
          </>
        )}
      </section>

      <section aria-labelledby="crew-inputs" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 id="crew-inputs" className="text-base font-semibold text-fg">Inputs</h2>
            <p className="text-sm text-fg-muted">The input schema: what a flow step (or a test run) gives the crew. Instructions use them as {"{name}"}; {"{today}"} is always there.</p>
          </div>
          <Button variant="ghost" onClick={() => setS({ ...s, inputs: [...s.inputs, { name: `input_${s.inputs.length + 1}` }] })} disabled={s.inputs.length >= 12}>Add input</Button>
        </div>
        {s.inputs.length === 0 && <p className="text-sm text-fg-muted">No inputs: the crew works from its instructions alone.</p>}
        {s.inputs.map((inp, i) => (
          <div key={i} className="grid gap-3 rounded-lg border border-line p-3 xl:grid-cols-[10rem_minmax(0,1fr)_10rem_auto_auto] xl:items-end">
            <Field label="Name"><Input value={inp.name} onChange={(e) => setInput(i, { name: e.target.value.trim() })} /></Field>
            <Field label="Description"><Input value={inp.description ?? ""} maxLength={500} onChange={(e) => setInput(i, { description: e.target.value })} /></Field>
            <Field label="Default (optional)"><Input value={inp.default ?? ""} onChange={(e) => setInput(i, { default: e.target.value })} /></Field>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(inp.required)} onChange={(e) => setInput(i, { required: e.target.checked })} /> Required</label>
            <Button variant="ghost" onClick={() => setS({ ...s, inputs: s.inputs.filter((_, j) => j !== i) })} aria-label={`Remove input ${inp.name}`}>Remove</Button>
          </div>
        ))}
      </section>

      <section aria-labelledby="crew-llm" className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <h2 id="crew-llm" className="text-base font-semibold text-fg">Model</h2>
          <p className="text-sm text-fg-muted">The crew&apos;s default model; an agent can name its own below. Empty: the SEO agent&apos;s default model (Settings → AI &amp; models → LLM providers &amp; budget).</p>
        </div>
        <Field label="Default model (optional)"><Input value={s.model ?? ""} placeholder="claude-…" onChange={(e) => setS({ ...s, model: e.target.value.trim() || null })} /></Field>
      </section>

      <section aria-labelledby="agents" className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="agents" className="text-base font-semibold text-fg">Agents</h2>
          <Button variant="ghost" onClick={() => setS({ ...s, agents: [...s.agents, { key: `agent_${s.agents.length + 1}`, role: "", goal: "", backstory: "", tools: [], model: null }] })} disabled={s.agents.length >= 8}>Add agent</Button>
        </div>
        {s.agents.map((a, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-line p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Key"><Input value={a.key} onChange={(e) => setAgent(i, { key: e.target.value.trim() })} /></Field>
              <Field label="Role"><Input value={a.role} onChange={(e) => setAgent(i, { role: e.target.value })} /></Field>
              <Field label="Model (optional)" hint="Empty: the crew's default model."><Input value={a.model ?? ""} placeholder="claude-…" onChange={(e) => setAgent(i, { model: e.target.value.trim() })} /></Field>
            </div>
            <Field label="Goal"><Textarea rows={2} value={a.goal} onChange={(e) => setAgent(i, { goal: e.target.value })} /></Field>
            <Field label="Backstory"><Textarea rows={2} value={a.backstory} onChange={(e) => setAgent(i, { backstory: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Output tokens per answer (optional)" hint="256–16,000. Empty: the agent's default."><Input inputMode="numeric" value={a.max_tokens ?? ""} onChange={(e) => setAgent(i, { max_tokens: num(e.target.value) })} /></Field>
              <Field label="Iterations (optional)" hint="1–25 reasoning and tool rounds. Empty: the crews' default."><Input inputMode="numeric" value={a.max_iter ?? ""} onChange={(e) => setAgent(i, { max_iter: num(e.target.value) })} /></Field>
            </div>
            <fieldset>
              <legend className="text-sm font-medium text-fg">Tools</legend>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                {CUSTOM_TOOLS.map((t) => (
                  <label key={t.name} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={a.tools.includes(t.name)} onChange={(e) => setAgent(i, { tools: e.target.checked ? [...a.tools, t.name] : a.tools.filter((x) => x !== t.name) })} />
                    <span><code className="text-xs">{t.name}</code> <span className="text-xs text-fg-subtle">{t.hint}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setS({ ...s, agents: move(s.agents, i, -1) })} disabled={i === 0} aria-label={`Move agent ${a.key} up`}>Up</Button>
              <Button variant="ghost" onClick={() => setS({ ...s, agents: move(s.agents, i, 1) })} disabled={i === s.agents.length - 1} aria-label={`Move agent ${a.key} down`}>Down</Button>
              <Button variant="ghost" onClick={() => setS({ ...s, agents: s.agents.filter((_, j) => j !== i) })} disabled={s.agents.length === 1}>Remove</Button>
            </div>
          </div>
        ))}
      </section>

      <section aria-labelledby="tasks" className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="tasks" className="text-base font-semibold text-fg">Tasks, in order</h2>
          <Button variant="ghost" onClick={() => setS({ ...s, tasks: [...s.tasks, { key: `task_${s.tasks.length + 1}`, agent: s.agents[0]?.key ?? "", label: "", instructions: "", expected_output: "", context: [] }] })} disabled={s.tasks.length >= 12}>Add task</Button>
        </div>
        {s.tasks.map((t, i) => {
          const earlier = s.tasks.slice(0, i).map((x) => x.key);
          return (
            <div key={i} className="space-y-3 rounded-xl border border-line p-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Key"><Input value={t.key} onChange={(e) => setTask(i, { key: e.target.value.trim() })} /></Field>
                <Field label="Name"><Input value={t.label} onChange={(e) => setTask(i, { label: e.target.value })} /></Field>
                <Field label="Agent">
                  <select className={sel} value={t.agent} onChange={(e) => setTask(i, { agent: e.target.value })}>
                    {s.agents.map((a) => <option key={a.key} value={a.key}>{a.role || a.key}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Instructions" hint={`Use the inputs (${s.inputs.map((x) => `{${x.name}}`).join(", ") || "none yet"}) and {today}.`}><Textarea rows={4} value={t.instructions} onChange={(e) => setTask(i, { instructions: e.target.value })} /></Field>
              <Field label="Expected output"><Textarea rows={2} value={t.expected_output} onChange={(e) => setTask(i, { expected_output: e.target.value })} /></Field>
              {earlier.length > 0 && (
                <fieldset>
                  <legend className="text-sm font-medium text-fg">Reads the output of</legend>
                  <p className="text-xs text-fg-subtle">None ticked: the task just before it.</p>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {earlier.map((k) => (
                      <label key={k} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={t.context.includes(k)} onChange={(e) => setTask(i, { context: e.target.checked ? [...t.context, k] : t.context.filter((x) => x !== k) })} /> {k}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setS({ ...s, tasks: move(s.tasks, i, -1) })} disabled={i === 0} aria-label={`Move task ${t.key} up`}>Up</Button>
                <Button variant="ghost" onClick={() => setS({ ...s, tasks: move(s.tasks, i, 1) })} disabled={i === s.tasks.length - 1} aria-label={`Move task ${t.key} down`}>Down</Button>
                <Button variant="ghost" onClick={() => setS({ ...s, tasks: s.tasks.filter((_, j) => j !== i) })} disabled={s.tasks.length === 1}>Remove</Button>
              </div>
            </div>
          );
        })}
      </section>

      <section aria-labelledby="crew-output" className="space-y-3">
        <h2 id="crew-output" className="text-base font-semibold text-fg">Output</h2>
        <p className="text-sm text-fg-muted">The output schema: what the last task returns. JSON with required keys is checked after every run; an answer that does not fit fails the flow step that ran the crew, so its retry policy applies.</p>
        <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <Field label="Format">
            <select className={sel} value={s.output?.format ?? "text"} onChange={(e) => setS({ ...s, output: { format: e.target.value as OutputDef["format"], required_keys: s.output?.required_keys ?? [], description: s.output?.description ?? "" } })}>
              <option value="text">Text (Markdown or MDX)</option>
              <option value="json">A JSON object</option>
            </select>
          </Field>
          {s.output?.format === "json" && (
            <Field label="Required keys (comma-separated)"><Input value={(s.output.required_keys ?? []).join(", ")} onChange={(e) => setS({ ...s, output: { ...s.output!, required_keys: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} placeholder="title, summary" /></Field>
          )}
        </div>
      </section>

      <section aria-labelledby="crew-save" className="space-y-3 border-t border-line pt-6">
        <h2 id="crew-save" className="sr-only">Save and test</h2>
        {!isNew && <Field label="What changed (optional)" hint="Kept with the new version."><Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={save}>{isNew ? "Create crew" : "Save as new version"}</Button>
          <Button variant="secondary" disabled={busy} onClick={check}>Check</Button>
        </div>
      </section>

      <section aria-labelledby="crew-test" className="space-y-3 rounded-xl border border-line p-4">
        <h2 id="crew-test" className="text-base font-semibold text-fg">Test run</h2>
        <p className="text-sm text-fg-muted">Runs this crew as it is in the editor (saved or not) once, on the inputs below, before you switch it on or put it in a flow. It drafts and publishes nothing; model calls count in the LLM budget.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {s.inputs.filter((x) => x.name).map((x) => (
            <Field key={x.name} label={`${x.name}${x.required ? " *" : ""}`} hint={x.description}><Input value={testInputs[x.name] ?? ""} placeholder={x.default} onChange={(e) => setTestInputs({ ...testInputs, [x.name]: e.target.value })} /></Field>
          ))}
        </div>
        <Button variant="secondary" disabled={busy || !s.key} onClick={test}>Start test run</Button>
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
