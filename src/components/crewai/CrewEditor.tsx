"use client";

import { diffWords } from "diff";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, Input, Select, Textarea } from "@/components/ui/form";
import type { AgentCrew } from "@/lib/seo-agent/client";

/**
 * The crew editor (CrewAI console → Crews → <crew>, D-98). Agents' role, goal, backstory, model, output tokens,
 * iterations and tools; tasks' instructions and expected output. What the code adds to every task (data blocks, output
 * format, rules) is shown but not editable. A field differs from the code's default → "changed", with a word diff.
 *
 * - Save as new version (optionally active at once): the agent checks the configuration against the crew's code and
 *   keeps only what differs; versions are never edited.
 * - Test run: the edited configuration, unsaved, replayed on a finished run of a flow that uses this crew (like
 *   Jenkins Replay). It saves nothing; the test run opens in the console and can be saved as a version from there.
 */

type AgentState = { role: string; goal: string; backstory: string; model: string; max_tokens: string; max_iter: string; tools: string[] };
type TaskState = { instructions: string; expected_output: string };
type Overlay = { agents?: Record<string, Record<string, unknown>>; tasks?: Record<string, Record<string, unknown>> };
export type SourceRun = { runId: string; flow: string; label: string; number: number | null; status: string; startedAt: string };

type ApiError = { error?: string; issues?: string[]; reference?: string };
const message = (d: ApiError) => [d.error ?? "Something went wrong.", ...(d.issues ?? [])].join("\n") + (d.reference ? ` (ref ${d.reference})` : "");

function initial(crew: AgentCrew, overlay: Overlay) {
  const agents: Record<string, AgentState> = {};
  for (const a of crew.agents) {
    const o = overlay.agents?.[a.key] ?? {};
    agents[a.key] = {
      role: typeof o.role === "string" ? o.role : a.role,
      goal: typeof o.goal === "string" ? o.goal : a.goal,
      backstory: typeof o.backstory === "string" ? o.backstory : a.backstory,
      model: typeof o.model === "string" ? o.model : "",
      max_tokens: typeof o.max_tokens === "number" ? String(o.max_tokens) : "",
      max_iter: typeof o.max_iter === "number" ? String(o.max_iter) : "",
      tools: Array.isArray(o.tools) ? (o.tools as string[]) : [...a.tools],
    };
  }
  const tasks: Record<string, TaskState> = {};
  for (const t of crew.tasks) {
    const o = overlay.tasks?.[t.key] ?? {};
    tasks[t.key] = { instructions: typeof o.instructions === "string" ? o.instructions : t.instructions, expected_output: typeof o.expected_output === "string" && t.output_editable ? o.expected_output : t.expected_output };
  }
  return { agents, tasks };
}

/** Only what differs from the code's defaults (the agent normalises it again before it is stored). */
function overlayOf(crew: AgentCrew, agents: Record<string, AgentState>, tasks: Record<string, TaskState>): Overlay {
  const out: Required<Overlay> = { agents: {}, tasks: {} };
  for (const a of crew.agents) {
    const s = agents[a.key]!;
    const d: Record<string, unknown> = {};
    for (const f of ["role", "goal", "backstory"] as const) if (s[f].trim() !== a[f].trim()) d[f] = s[f].trim();
    if (s.model) d.model = s.model;
    if (s.max_tokens) d.max_tokens = Number(s.max_tokens);
    if (s.max_iter) d.max_iter = Number(s.max_iter);
    if (s.tools.join(",") !== a.tools.join(",")) d.tools = s.tools;
    if (Object.keys(d).length) out.agents[a.key] = d;
  }
  for (const t of crew.tasks) {
    const s = tasks[t.key]!;
    const d: Record<string, unknown> = {};
    if (s.instructions.trim() !== t.instructions.trim()) d.instructions = s.instructions.trim();
    if (t.output_editable && s.expected_output.trim() !== t.expected_output.trim()) d.expected_output = s.expected_output.trim();
    if (Object.keys(d).length) out.tasks[t.key] = d;
  }
  const o: Overlay = {};
  if (Object.keys(out.agents).length) o.agents = out.agents;
  if (Object.keys(out.tasks).length) o.tasks = out.tasks;
  return o;
}

function count(o: Overlay): number {
  return Object.values(o.agents ?? {}).reduce((n, a) => n + Object.keys(a).length, 0) + Object.values(o.tasks ?? {}).reduce((n, t) => n + Object.keys(t).length, 0);
}

function WordDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-surface-muted p-3 text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]" aria-label="Changes against the code's default">
      {parts.map((p, i) => (p.added ? <ins key={i} className="bg-emerald-100 no-underline dark:bg-emerald-500/20">{p.value}</ins> : p.removed ? <del key={i} className="bg-red-100 dark:bg-red-500/20">{p.value}</del> : <span key={i}>{p.value}</span>))}
    </div>
  );
}

function TextField({ id, label, value, def, onChange, rows, hint }: { id: string; label: string; value: string; def: string; onChange: (v: string) => void; rows: number; hint?: string }) {
  const [diff, setDiff] = useState(false);
  const changed = value.trim() !== def.trim();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
          {changed && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-normal text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">changed</span>}
        </label>
        {changed && (
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-fg-muted underline" onClick={() => setDiff(!diff)}>{diff ? "Hide changes" : "Show changes"}</button>
            <button type="button" className="text-fg-muted underline" onClick={() => onChange(def)}>Reset to default</button>
          </span>
        )}
      </div>
      <Textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} className="text-sm" spellCheck />
      {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
      {changed && diff && <WordDiff before={def} after={value} />}
    </div>
  );
}

export function CrewEditor({ crew, overlay, loaded, activeVersion, sources, preselect }: { crew: AgentCrew; overlay: Overlay; loaded: { version: number | null; label: string; baseHash: string | null }; activeVersion: number | null; sources: SourceRun[]; preselect: string | null }) {
  const router = useRouter();
  const start = useMemo(() => initial(crew, overlay), [crew, overlay]);
  const [agents, setAgents] = useState(start.agents);
  const [tasks, setTasks] = useState(start.tasks);
  const [note, setNote] = useState("");
  const [source, setSource] = useState(preselect ?? sources[0]?.runId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const current = overlayOf(crew, agents, tasks);
  const changes = count(current);
  const dirty = JSON.stringify(current) !== JSON.stringify(overlayOf(crew, start.agents, start.tasks));

  const post = async (body: unknown) => {
    try {
      const res = await fetch(`/api/admin/crewai/crews/${crew.crew}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { ok: res.ok, data: (await res.json().catch(() => ({}))) as ApiError & Record<string, unknown> };
    } catch {
      return { ok: false, data: { error: "Network error." } as ApiError & Record<string, unknown> };
    }
  };

  const save = async (activate: boolean) => {
    setBusy(activate ? "activate" : "save");
    setResult(null);
    const r = await post({ action: "save", config: current, note, activate });
    setBusy(null);
    if (!r.ok) return setResult({ ok: false, text: message(r.data) });
    const v = (r.data.version as { version?: number } | undefined)?.version;
    setNote("");
    router.push(`/admin/crewai/crews/${crew.crew}?version=${v}&saved=1`);
    router.refresh();
  };

  const check = async () => {
    setBusy("check");
    setResult(null);
    const r = await post({ action: "validate", config: current });
    setBusy(null);
    setResult(r.ok ? { ok: true, text: `The agent accepts this configuration (${changes} change${changes === 1 ? "" : "s"} from the code's defaults).` } : { ok: false, text: message(r.data) });
  };

  const test = async () => {
    if (!source) return setResult({ ok: false, text: "Choose a run to replay." });
    setBusy("test");
    setResult(null);
    const r = await post({ action: "test", config: current, sourceRunId: source, ...(loaded.version && !dirty ? { version: loaded.version } : {}), ...(note ? { note } : {}) });
    setBusy(null);
    if (!r.ok) return setResult({ ok: false, text: message(r.data) });
    router.push(`/admin/crewai/runs/${String(r.data.runId)}`);
  };

  const setAgent = (key: string, patch: Partial<AgentState>) => setAgents((a) => ({ ...a, [key]: { ...a[key]!, ...patch } }));
  const setTask = (key: string, patch: Partial<TaskState>) => setTasks((t) => ({ ...t, [key]: { ...t[key]!, ...patch } }));
  const upstream = loaded.baseHash && loaded.baseHash !== crew.default_hash;

  return (
    <div className="space-y-8">
      <p className="text-sm text-fg-muted">
        Editing: <strong className="text-fg">{loaded.label}</strong>
        {loaded.version != null && loaded.version === activeVersion ? " (the active version)" : ""} · {changes} change{changes === 1 ? "" : "s"} from the code&apos;s defaults{dirty ? " · not saved" : ""}.
      </p>
      {upstream && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          The code&apos;s defaults for this crew changed after this version was saved (an agent update). Fields this version does not change follow the new defaults; compare the changed ones before you rely on it.
        </p>
      )}

      <section aria-labelledby="agents-h" className="space-y-4">
        <h2 id="agents-h" className="text-base font-semibold text-fg">Agents</h2>
        {crew.agents.map((a) => {
          const s = agents[a.key]!;
          const id = `agent-${a.key}`;
          return (
            <fieldset key={a.key} className="space-y-4 rounded-xl border border-line bg-surface p-4">
              <legend className="px-1 text-sm font-semibold text-fg">{a.role} <code className="ml-1 text-xs font-normal text-fg-subtle">{crew.crew}.{a.key}</code></legend>
              <TextField id={`${id}-role`} label="Role" value={s.role} def={a.role} onChange={(v) => setAgent(a.key, { role: v })} rows={1} />
              <TextField id={`${id}-goal`} label="Goal" value={s.goal} def={a.goal} onChange={(v) => setAgent(a.key, { goal: v })} rows={3} />
              <TextField id={`${id}-backstory`} label="Backstory" value={s.backstory} def={a.backstory} onChange={(v) => setAgent(a.key, { backstory: v })} rows={4} hint="The code adds the untrusted-data rule (and the skills rule when skills apply) to every backstory." />
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <label htmlFor={`${id}-model`} className="text-sm font-medium text-fg">Model</label>
                  <Select id={`${id}-model`} value={s.model} onChange={(e) => setAgent(a.key, { model: e.target.value })}>
                    <option value="">Default (settings)</option>
                    {crew.models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${id}-tokens`} className="text-sm font-medium text-fg">Output tokens</label>
                  <Input id={`${id}-tokens`} type="number" inputMode="numeric" min={256} max={64000} placeholder={a.max_tokens ? String(a.max_tokens) : "default"} value={s.max_tokens} onChange={(e) => setAgent(a.key, { max_tokens: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${id}-iter`} className="text-sm font-medium text-fg">Iterations</label>
                  <Input id={`${id}-iter`} type="number" inputMode="numeric" min={1} max={25} placeholder="default" value={s.max_iter} onChange={(e) => setAgent(a.key, { max_iter: e.target.value })} />
                </div>
              </div>
              <fieldset>
                <legend className="text-sm font-medium text-fg">Tools</legend>
                {crew.tools.length === 0 ? (
                  <p className="text-xs text-fg-subtle">This crew&apos;s agents have no tools.</p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {crew.tools.map((t) => (
                      <label key={t} className="inline-flex min-h-9 items-center gap-2 font-mono text-xs text-fg">
                        <input type="checkbox" className="h-4 w-4" checked={s.tools.includes(t)} onChange={(e) => setAgent(a.key, { tools: e.target.checked ? crew.tools.filter((x) => x === t || s.tools.includes(x)) : s.tools.filter((x) => x !== t) })} />
                        {t}{a.tools.includes(t) ? "" : " (not in the default)"}
                      </label>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-xs text-fg-subtle">Only tools this crew has in code. All of them read; none can publish or change anything.</p>
              </fieldset>
            </fieldset>
          );
        })}
      </section>

      <section aria-labelledby="tasks-h" className="space-y-4">
        <h2 id="tasks-h" className="text-base font-semibold text-fg">Tasks</h2>
        {crew.tasks.map((t) => {
          const s = tasks[t.key]!;
          const id = `task-${t.key}`;
          return (
            <fieldset key={t.key} className="space-y-4 rounded-xl border border-line bg-surface p-4">
              <legend className="px-1 text-sm font-semibold text-fg">{t.label} <span className="font-normal text-fg-subtle">· {crew.agents.find((a) => a.key === t.agent)?.role ?? t.agent}</span></legend>
              <TextField id={`${id}-instructions`} label="Instructions" value={s.instructions} def={t.instructions} onChange={(v) => setTask(t.key, { instructions: v })} rows={8} hint={t.variables.length ? `Placeholders: ${t.variables.map((v) => `{${v}}`).join(", ")} (replaced at run time).` : undefined} />
              {t.output_editable ? (
                <TextField id={`${id}-output`} label="Expected output" value={s.expected_output} def={t.expected_output} onChange={(v) => setTask(t.key, { expected_output: v })} rows={2} />
              ) : (
                <div>
                  <p className="text-sm font-medium text-fg">Expected output <span className="font-normal text-fg-subtle">(fixed: the code reads this answer)</span></p>
                  <p className="mt-1 rounded-lg bg-surface-muted p-2 text-xs text-fg-muted [overflow-wrap:anywhere]">{t.expected_output}</p>
                </div>
              )}
              {t.contract && (
                <div>
                  <p className="text-sm font-medium text-fg">Added by the code <span className="font-normal text-fg-subtle">(not editable)</span></p>
                  <p className="mt-1 rounded-lg bg-surface-muted p-2 text-xs whitespace-pre-wrap text-fg-muted [overflow-wrap:anywhere]">{t.contract}</p>
                </div>
              )}
            </fieldset>
          );
        })}
      </section>

      <div className="sticky bottom-0 z-10 -mx-1 rounded-lg border border-line bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-sm backdrop-blur">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <label htmlFor="crew-note" className="text-xs font-medium text-fg-muted">Note for this version</label>
              <Input id="crew-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What changed and why" />
            </div>
            <Button type="button" variant="ghost" loading={busy === "check"} onClick={() => void check()}>Check</Button>
            <Button type="button" variant="secondary" loading={busy === "save"} disabled={!dirty && loaded.version != null} onClick={() => void save(false)}>Save as new version</Button>
            <Button type="button" loading={busy === "activate"} disabled={!dirty && loaded.version != null && loaded.version === activeVersion} onClick={() => void save(true)}>Save and activate</Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <label htmlFor="crew-source" className="text-xs font-medium text-fg-muted">Test run: replay this run with the prompts above (nothing is saved)</label>
              <Select id="crew-source" value={source} onChange={(e) => setSource(e.target.value)} disabled={sources.length === 0}>
                {sources.length === 0 && <option value="">No finished run of {crew.replay_flows.join(" or ")} to replay yet</option>}
                {sources.map((r) => <option key={r.runId} value={r.runId}>{r.label} #{r.number ?? "?"} · {r.status} · {r.startedAt.slice(0, 16).replace("T", " ")} UTC</option>)}
              </Select>
            </div>
            <Button type="button" variant="secondary" loading={busy === "test"} disabled={!source} onClick={() => void test()}>Test run</Button>
            {source && <Link href={`/admin/crewai/runs/${source}`} className="pb-3 text-xs text-fg-muted underline">open that run</Link>}
          </div>
          {result && <p role={result.ok ? "status" : "alert"} className={`text-sm whitespace-pre-wrap ${result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{result.text}</p>}
        </div>
      </div>
    </div>
  );
}

/** Activate a saved version, or go back to the code's defaults (Versions list on the crew page). */
export function VersionActions({ crew, version, active }: { crew: string; version: number | null; active: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (active) return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">active</span>;
  const go = async () => {
    const what = version == null ? "Run this crew with the code's defaults again (no active version)?" : `Make v${version} the version this crew runs from its next run?`;
    if (!window.confirm(what)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/crewai/crews/${crew}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(version == null ? { action: "defaults" } : { action: "activate", version }) });
      if (!res.ok) setError(message((await res.json().catch(() => ({}))) as ApiError));
      else router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-end">
      <Button type="button" size="sm" variant="ghost" loading={busy} onClick={() => void go()}>{version == null ? "Use the code's defaults" : "Activate"}</Button>
      {error && <span role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </span>
  );
}
