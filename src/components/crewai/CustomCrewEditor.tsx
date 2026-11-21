"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/news/api";
import { Field } from "@/components/news/Fld";
import { Alert, Button, Input, Textarea } from "@/components/ui/form";

/** The tools a custom crew's agent may hold: the agent's CUSTOM_TOOLS (moks-seo-agent app/crews/custom.py). */
export const CUSTOM_TOOLS: { name: string; hint: string }[] = [
  { name: "vector_search", hint: "search this site's articles by meaning" },
  { name: "read_article", hint: "read one of this site's articles" },
  { name: "gsc_queries_for_topic", hint: "Search Console queries about a topic" },
  { name: "style_guide", hint: "the site's writing style guide" },
  { name: "fetch_allowlisted_docs", hint: "official documentation pages (allowlisted domains)" },
];

type Agent = { key: string; role: string; goal: string; backstory: string; tools: string[]; model?: string | null };
type Task = { key: string; agent: string; label: string; instructions: string; expected_output: string; context: string[] };
export type CrewSpec = { key: string; label: string; description: string; inputs: string[]; agents: Agent[]; tasks: Task[] };

export const BLANK_CREW: CrewSpec = {
  key: "",
  label: "",
  description: "",
  inputs: ["topic"],
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

/**
 * AI & SEO → Crews → New crew / a custom crew: agents (role, goal, backstory, tools from the allowlist, model) and
 * tasks in order (instructions with {input} placeholders, expected output, the earlier tasks they read). The SEO
 * agent checks the spec when you save; the rules every crew follows (untrusted data, no delegation or code, the
 * caps) are added by its code and are not part of the spec.
 */
export function CustomCrewEditor({ initial, isNew, enabled, usedBy }: { initial: CrewSpec; isNew: boolean; enabled: boolean; usedBy: string[] }) {
  const router = useRouter();
  const [s, setS] = useState<CrewSpec>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  const setAgent = (i: number, a: Partial<Agent>) => setS((x) => ({ ...x, agents: x.agents.map((y, j) => (j === i ? { ...y, ...a } : y)) }));
  const setTask = (i: number, t: Partial<Task>) => setS((x) => ({ ...x, tasks: x.tasks.map((y, j) => (j === i ? { ...y, ...t } : y)) }));
  const call = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
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
      const spec = { ...s, agents: s.agents.map((a) => ({ ...a, model: a.model || null })) };
      await api("/api/admin/crewai/custom/crews", "POST", { spec });
      if (isNew) router.push(`/admin/crewai/crews/custom/${s.key}`);
    }, "Saved. The SEO agent checked it; flows can use it now.");

  return (
    <div className="space-y-8">
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Key" hint="2–40 lower-case letters, digits or _; it cannot change later or be a built-in crew's.">
          <Input value={s.key} disabled={!isNew} onChange={(e) => setS({ ...s, key: e.target.value.trim() })} />
        </Field>
        <Field label="Name"><Input value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })} maxLength={120} /></Field>
        <div className="sm:col-span-2"><Field label="Description"><Textarea rows={2} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></Field></div>
        <div className="sm:col-span-2">
          <Field label="Inputs (comma-separated)" hint="Names the instructions may use as {name}; {today} is always there. A flow fills them in.">
            <Input value={s.inputs.join(", ")} onChange={(e) => setS({ ...s, inputs: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </Field>
        </div>
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
              <Field label="Model (optional)" hint="Empty: the crews' default model."><Input value={a.model ?? ""} placeholder="claude-…" onChange={(e) => setAgent(i, { model: e.target.value.trim() })} /></Field>
            </div>
            <Field label="Goal"><Textarea rows={2} value={a.goal} onChange={(e) => setAgent(i, { goal: e.target.value })} /></Field>
            <Field label="Backstory"><Textarea rows={2} value={a.backstory} onChange={(e) => setAgent(i, { backstory: e.target.value })} /></Field>
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
              <Button variant="ghost" onClick={() => setS({ ...s, agents: move(s.agents, i, -1) })} disabled={i === 0}>Up</Button>
              <Button variant="ghost" onClick={() => setS({ ...s, agents: move(s.agents, i, 1) })} disabled={i === s.agents.length - 1}>Down</Button>
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
                  <select className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm" value={t.agent} onChange={(e) => setTask(i, { agent: e.target.value })}>
                    {s.agents.map((a) => <option key={a.key} value={a.key}>{a.role || a.key}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Instructions" hint="Use {input} names and {today}."><Textarea rows={4} value={t.instructions} onChange={(e) => setTask(i, { instructions: e.target.value })} /></Field>
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
                <Button variant="ghost" onClick={() => setS({ ...s, tasks: move(s.tasks, i, -1) })} disabled={i === 0}>Up</Button>
                <Button variant="ghost" onClick={() => setS({ ...s, tasks: move(s.tasks, i, 1) })} disabled={i === s.tasks.length - 1}>Down</Button>
                <Button variant="ghost" onClick={() => setS({ ...s, tasks: s.tasks.filter((_, j) => j !== i) })} disabled={s.tasks.length === 1}>Remove</Button>
              </div>
            </div>
          );
        })}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={save}>{isNew ? "Create crew" : "Save"}</Button>
        {!isNew && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => call(() => api(`/api/admin/crewai/custom/crews/${s.key}`, "PATCH", { enabled: !enabled }), enabled ? "Switched off." : "Switched on.")}>{enabled ? "Switch off" : "Switch on"}</Button>
            <Button
              variant="ghost"
              disabled={busy || usedBy.length > 0}
              onClick={() => {
                if (window.confirm(`Delete the custom crew ${s.label || s.key}? Its run history stays.`)) call(async () => { await api(`/api/admin/crewai/custom/crews/${s.key}`, "DELETE"); router.push("/admin/crewai/crews"); }, "Deleted.");
              }}
            >
              Delete
            </Button>
          </>
        )}
        {usedBy.length > 0 && <span className="text-xs text-fg-subtle">Used by {usedBy.join(", ")}: it cannot be deleted while a flow uses it.</span>}
      </div>
      {msg && (
        <Alert tone={msg.ok ? "success" : "error"}>
          {msg.text}
          {msg.issues && msg.issues.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{msg.issues.map((x) => <li key={x}>{x}</li>)}</ul>}
        </Alert>
      )}
    </div>
  );
}
