import type { Issue } from "./files";
import { ref, type Agent, type CrewConfig, type Kind, type Task } from "./model";

/**
 * The checks a bundle passes on its own, without the site or the agent: each crew lists exactly the agents and tasks that
 * have files, a task's agent is one of its crew's, a task's context names earlier tasks, and what crews, flows and
 * schedules refer to inside the bundle exists. The import adds the site's and the agent's checks (import.ts); the site
 * repository's own check (jithendar.com scripts/crewconfig.py) does the same as this file, in Python.
 */
export function checkStructure(b: CrewConfig, paths: Map<string, string>): Issue[] {
  const issues: Issue[] = [];
  const at = (kind: Kind, id: string) => paths.get(ref(kind, id)) ?? `${kind}/${id}`;
  const err = (kind: Kind, id: string, message: string) => issues.push({ path: at(kind, id), severity: "error", message, ref: ref(kind, id) });
  const warn = (kind: Kind, id: string, message: string) => issues.push({ path: at(kind, id), severity: "warning", message, ref: ref(kind, id) });
  const agentsOf = new Map<string, Agent[]>();
  for (const a of b.agents) agentsOf.set(a.crew, [...(agentsOf.get(a.crew) ?? []), a]);
  const tasksOf = new Map<string, Task[]>();
  for (const t of b.tasks) tasksOf.set(t.crew, [...(tasksOf.get(t.crew) ?? []), t]);
  const crews = new Set(b.crews.map((c) => c.key));
  for (const c of b.crews) {
    const files = new Set((agentsOf.get(c.key) ?? []).map((a) => a.key));
    for (const a of c.agents) if (!files.has(a)) err("crews", c.key, `agent ${a} has no file agents/${c.key}/${a}.md`);
    for (const a of files) if (!c.agents.includes(a)) err("agents", `${c.key}.${a}`, `the crew ${c.key} does not list this agent (crews/${c.key}.yaml agents)`);
    const tfiles = new Map((tasksOf.get(c.key) ?? []).map((t) => [t.key, t]));
    for (const t of c.tasks) if (!tfiles.has(t)) err("crews", c.key, `task ${t} has no file tasks/${c.key}/${t}.md`);
    for (const t of tfiles.keys()) if (!c.tasks.includes(t)) err("tasks", `${c.key}.${t}`, `the crew ${c.key} does not list this task (crews/${c.key}.yaml tasks)`);
    c.tasks.forEach((tk, i) => {
      const t = tfiles.get(tk);
      if (!t) return;
      if (!c.agents.includes(t.agent)) err("tasks", `${c.key}.${tk}`, `agent ${t.agent} is not one of the crew's agents (${c.agents.join(", ")})`);
      for (const x of t.context ?? []) if (!c.tasks.slice(0, i).includes(x)) err("tasks", `${c.key}.${tk}`, `context ${x} is not an earlier task of the crew`);
    });
  }
  for (const a of b.agents) if (!crews.has(a.crew)) err("agents", `${a.crew}.${a.key}`, `no crew ${a.crew} in the bundle (crews/${a.crew}.yaml)`);
  for (const t of b.tasks) if (!crews.has(t.crew)) err("tasks", `${t.crew}.${t.key}`, `no crew ${t.crew} in the bundle (crews/${t.crew}.yaml)`);
  const categories = new Set(b.categories.map((c) => c.slug));
  const sources = new Set(b.sources.map((s) => s.url));
  const specFlows = new Set(b.flows.filter((f) => f.definition === "spec").map((f) => f.key));
  for (const c of b.crews) for (const cat of c.categories) if (!categories.has(cat)) warn("crews", c.key, `category ${cat} is not in categories/categories.yaml (the site must have it)`);
  for (const f of b.flows) {
    for (const cat of f.categories) if (!categories.has(cat)) warn("flows", f.key, `category ${cat} is not in categories/categories.yaml (the site must have it)`);
    for (const s of ((f.spec?.steps as { kind?: string; crew?: string }[] | undefined) ?? [])) if (s.kind === "crew" && s.crew && !crews.has(s.crew)) warn("flows", f.key, `step crew ${s.crew} is not in the bundle (the site must have it)`);
    for (const url of f.content?.sources ?? []) if (!sources.has(url)) warn("flows", f.key, `source ${url} is not in sources/sources.yaml (the site must have it)`);
  }
  for (const s of b.schedules) if (s.flow === "custom_flow" && !specFlows.has(String(s.inputs.flow ?? ""))) warn("schedules", s.name, `inputs.flow ${String(s.inputs.flow ?? "(missing)")} is not a spec flow in the bundle (the site must have it)`);
  return issues;
}
