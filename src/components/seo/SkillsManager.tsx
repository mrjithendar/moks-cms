"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Card } from "@/components/admin/ui";
import { Button } from "@/components/ui/form";
import type { Skill } from "@/lib/seo-agent/skills";

type Agent = { key: string; crew: string; label: string };
type Crew = { id: string; label: string };
type TagHelp = { tag: string; crew: string; meaning: string };
type Limits = { name: number; description: number; instructions: number; agents: number; tags: number };
type Draft = { name: string; description: string; instructions: string; agents: string[]; tags: string; enabled: boolean };

const input = "min-h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
const pill = "rounded-full px-2 py-0.5 text-xs font-semibold";
const splitTags = (s: string) => s.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);

async function call(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string };
    return [data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" ") + (data.reference ? ` (ref ${data.reference})` : "");
  } catch {
    return "Network error.";
  }
}

/** Skills page: filter by crew, add a skill, and edit, enable/disable, reset or delete each one. */
export function SkillsManager({ skills, crews, agents, tags, limits }: { skills: Skill[]; crews: Crew[]; agents: Agent[]; tags: TagHelp[]; limits: Limits }) {
  const [crew, setCrew] = useState("all");
  const [state, setState] = useState<"all" | "on" | "off">("all");
  const [adding, setAdding] = useState(false);
  const label = useMemo(() => new Map([...agents.map((a) => [a.key, `${crews.find((c) => c.id === a.crew)?.label.split(" (")[0] ?? a.crew}: ${a.label}`] as const), ...crews.map((c) => [`${c.id}.*`, `${c.label.split(" (")[0]}: every agent`] as const)]), [agents, crews]);
  const shown = skills.filter((s) => (crew === "all" || s.agents.some((a) => a.startsWith(`${crew}.`))) && (state === "all" || (state === "on") === s.enabled));
  const ctx = { crews, agents, tags, limits, label };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs text-fg-subtle">
          Crew
          <select className={input} value={crew} onChange={(e) => setCrew(e.target.value)}>
            <option value="all">All crews ({skills.length})</option>
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({skills.filter((s) => s.agents.some((a) => a.startsWith(`${c.id}.`))).length})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-fg-subtle">
          Status
          <select className={input} value={state} onChange={(e) => setState(e.target.value as typeof state)}>
            <option value="all">Enabled and disabled</option>
            <option value="on">Enabled ({skills.filter((s) => s.enabled).length})</option>
            <option value="off">Disabled ({skills.filter((s) => !s.enabled).length})</option>
          </select>
        </label>
        <span className="ml-auto">
          <Button type="button" size="sm" onClick={() => setAdding((v) => !v)}>
            {adding ? "Close" : "Add skill"}
          </Button>
        </span>
      </div>
      {adding && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-fg">New skill</h2>
          <SkillForm {...ctx} initial={{ name: "", description: "", instructions: "", agents: crew === "all" ? [] : agents.filter((a) => a.crew === crew).slice(0, 1).map((a) => a.key), tags: "", enabled: true }} onDone={() => setAdding(false)} />
        </Card>
      )}
      {shown.length === 0 ? <p className="text-sm text-fg-muted">No skills match these filters.</p> : shown.map((s) => <SkillCard key={s.id} skill={s} {...ctx} />)}
    </div>
  );
}

type Ctx = { crews: Crew[]; agents: Agent[]; tags: TagHelp[]; limits: Limits; label: Map<string, string> };

function SkillCard({ skill: s, ...ctx }: { skill: Skill } & Ctx) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (url: string, method: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    const err = await call(url, method, body);
    setBusy(false);
    if (err) setMsg(err);
    else router.refresh();
  };
  const base = `/api/admin/seo/skills/${s.id}`;
  return (
    <Card className={s.enabled ? "" : "opacity-75"}>
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="font-mono text-sm font-semibold text-fg">{s.name}</h2>
        <span className={`${pill} ${s.builtin ? "bg-surface-sunken text-fg-muted" : "bg-blue-50 text-blue-800 dark:bg-blue-500/10 dark:text-blue-300"}`}>{s.builtin ? "Default" : "Custom"}</span>
        {s.edited && <span className={`${pill} bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300`}>Edited</span>}
        <span className={`${pill} ${s.enabled ? "bg-green-50 text-green-800 dark:bg-green-500/10 dark:text-green-300" : "bg-surface-sunken text-fg-muted"}`}>{s.enabled ? "On" : "Off"}</span>
        <span className="text-xs text-fg-subtle">v{s.version}</span>
        <span className="ml-auto flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => act(base, "PATCH", { enabled: !s.enabled })}>
            {s.enabled ? "Disable" : "Enable"}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
          {s.builtin && s.edited && (
            <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => act(`${base}/reset`, "POST", undefined, `Put ${s.name} back to the default text, agents and tags?`)}>
              Reset
            </Button>
          )}
          {!s.builtin && (
            <Button type="button" size="sm" variant="danger" loading={busy} onClick={() => act(base, "DELETE", undefined, `Delete the skill ${s.name}? Runs stop using it.`)}>
              Delete
            </Button>
          )}
        </span>
      </div>
      <p className="mt-2 text-sm text-fg-muted">{s.description}</p>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-1 text-xs text-fg-subtle sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
        <dt className="font-medium">For</dt>
        <dd>{s.agents.map((a) => ctx.label.get(a) ?? a).join(" · ")}</dd>
        <dt className="font-medium">When</dt>
        <dd className="flex flex-wrap gap-1">{s.tags.length ? s.tags.map((t) => <code key={t} className="rounded bg-surface-sunken px-1 [overflow-wrap:anywhere]">{t}</code>) : "every run of these agents"}</dd>
      </dl>
      {msg && <p role="status" className="mt-2 text-xs text-red-700 dark:text-red-300">{msg}</p>}
      {editing ? (
        <div className="mt-4 border-t border-line pt-4">
          <SkillForm {...ctx} id={s.id} initial={{ name: s.name, description: s.description, instructions: s.instructions, agents: s.agents, tags: s.tags.join(", "), enabled: s.enabled }} onDone={() => setEditing(false)} />
        </div>
      ) : (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-fg-muted">Instructions</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md bg-surface-sunken p-3 text-xs text-fg">{s.instructions}</pre>
        </details>
      )}
    </Card>
  );
}

function SkillForm({ id, initial, onDone, crews, agents, tags, limits }: { id?: string; initial: Draft; onDone: () => void } & Ctx) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const toggle = (key: string) => set("agents", d.agents.includes(key) ? d.agents.filter((a) => a !== key) : [...d.agents, key]);
  const f = id ? `skill-${id}` : "skill-new";
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const body = { description: d.description, instructions: d.instructions, agents: d.agents, tags: splitTags(d.tags), ...(id ? {} : { name: d.name, enabled: d.enabled }) };
        const err = await call(id ? `/api/admin/seo/skills/${id}` : "/api/admin/seo/skills", id ? "PATCH" : "POST", body);
        setBusy(false);
        if (err) return setMsg(err);
        onDone();
        router.refresh();
      }}
    >
      {!id && (
        <label className="grid gap-1 text-xs text-fg-subtle" htmlFor={`${f}-name`}>
          Name (lowercase words joined by hyphens, cannot be changed later)
          <input id={`${f}-name`} required maxLength={limits.name} pattern="[a-z0-9]+(-[a-z0-9]+)*" className={`${input} font-mono`} value={d.name} onChange={(e) => set("name", e.target.value.toLowerCase())} placeholder="kubernetes-upgrades" />
        </label>
      )}
      <label className="grid gap-1 text-xs text-fg-subtle" htmlFor={`${f}-description`}>
        Description (one sentence: what the skill is for)
        <input id={`${f}-description`} required maxLength={limits.description} className={input} value={d.description} onChange={(e) => set("description", e.target.value)} />
      </label>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs text-fg-subtle">Agents that get it</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {crews.map((c) => (
            <div key={c.id} className="rounded-md border border-line p-2">
              <p className="mb-1 text-xs font-semibold text-fg">{c.label}</p>
              {[{ key: `${c.id}.*`, label: "Every agent of this crew" }, ...agents.filter((a) => a.crew === c.id)].map((a) => (
                <label key={a.key} className="flex items-center gap-2 text-xs text-fg-muted">
                  <input type="checkbox" checked={d.agents.includes(a.key)} onChange={() => toggle(a.key)} />
                  {a.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      </fieldset>
      <label className="grid gap-1 text-xs text-fg-subtle" htmlFor={`${f}-tags`}>
        When it applies: tags, separated by commas (empty = every run of these agents; otherwise a run with any one of them)
        <input id={`${f}-tags`} className={`${input} font-mono`} value={d.tags} onChange={(e) => set("tags", e.target.value)} placeholder="intent:troubleshooting, source:ml" />
      </label>
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer font-medium">Available tags</summary>
        <ul className="mt-2 grid gap-1">
          {tags.map((t) => (
            <li key={t.tag}>
              <code className="rounded bg-surface-sunken px-1">{t.tag}</code> <span className="text-fg-subtle">({crews.find((c) => c.id === t.crew)?.label.split(" (")[0] ?? t.crew})</span> {t.meaning}
            </li>
          ))}
        </ul>
      </details>
      <label className="grid gap-1 text-xs text-fg-subtle" htmlFor={`${f}-instructions`}>
        Instructions (Markdown, written to the agent; at most {limits.instructions.toLocaleString("en")} characters, {d.instructions.length.toLocaleString("en")} used)
        <textarea id={`${f}-instructions`} required maxLength={limits.instructions} className={`${input} min-h-48 py-2 font-mono`} value={d.instructions} onChange={(e) => set("instructions", e.target.value)} />
      </label>
      {!id && (
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Enabled (used from the next run)
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" loading={busy} disabled={d.agents.length === 0}>
          {id ? "Save skill" : "Add skill"}
        </Button>
        {msg && <span role="status" className="text-xs text-red-700 dark:text-red-300">{msg}</span>}
      </div>
    </form>
  );
}
