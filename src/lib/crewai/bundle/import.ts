import "server-only";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "@/lib/audit";
import { cronError } from "@/lib/news/cron";
import { jobConfigSchema, jobInput, sourceInput } from "@/lib/news/schema";
import type { Actor } from "@/lib/posts";
import { AgentError, validateCrewConfig, validateCustomSpec, validateFlowInputs, type AgentDeps } from "@/lib/seo-agent/client";
import { createSkill, deleteSkill, listSkills, skillCreateSchema, updateSkill } from "@/lib/seo-agent/skills";
import { createCategory, crewsOfSpec, deleteCategory, deleteItem, restoreItem, setEnabled, updateCategory, updateItem, createItem } from "../catalog";
import { activeVersions, saveVersion } from "../crews";
import { createSchedule, deleteSchedule, listSchedules, scheduleInput, updateSchedule } from "../schedules";
import { checkStructure } from "./check";
import { configChecksum, fromFiles, itemChecksum, verifyManifest, type Files, type Issue } from "./files";
import { BUNDLE_KIND, editable, emptyConfig, idOf, IMPORTABLE, KIND_INFO, KINDS, LEGACY_KIND, ref, stable, type Agent, type Crew, type CrewConfig, type Flow, type Kind, type Task } from "./model";
import { exportRuntime, loadAgentSide, type AgentSide, type Runtime } from "./runtime";
import { baseline as loadBaseline, forgetStatus, recordSync, type SyncSource } from "./sync";

/**
 * Import a configuration bundle (D-101): read → validate (schemas, manifest, references, duplicates) → plan against what
 * runs now (added, changed, unchanged, in conflict, removed) → apply in one transaction → verify → record.
 *
 * Conflicts: an item the bundle changes that also changed here since the last sync (the baseline of
 * crewai_config_syncs), or any differing item when there has been no sync yet, is a conflict. The policy decides:
 * "skip" keeps this site's version (the default for deployments: nothing changed in the admin is overwritten silently),
 * "overwrite" applies the bundle, "fail" refuses the whole import.
 *
 * Nothing is removed unless `prune` is set, and even then never what is defined in code (code crews and flows), shipped
 * with the CMS (built-in skills and schedules) or not in a kind the import covers.
 *
 * An item the agent or a check refuses fails the whole import (nothing is applied, the configuration stays as it was),
 * unless `allowPartial` is set, which leaves the refused items out. The SEO agent checks every crew and flow spec, crew
 * version and schedule input it would save, so a bundle can never widen what an agent may do.
 */

export type Policy = "skip" | "overwrite" | "fail";
export const POLICIES: readonly Policy[] = ["skip", "overwrite", "fail"];
export const importOptionsSchema = z
  .object({
    policy: z.enum(["skip", "overwrite", "fail"]).default("skip"),
    prune: z.boolean().default(false),
    kinds: z.array(z.enum(IMPORTABLE as [Kind, ...Kind[]])).max(20).optional(),
    only: z.array(z.string().max(200)).max(2000).optional(),
    activate: z.boolean().default(true),
    allowPartial: z.boolean().default(false),
  })
  .strict();
export type ImportOptions = z.output<typeof importOptionsSchema>;
/** The options as a request sends them: nothing filled in, so each route keeps its own default policy. */
export const importRequestOptions = z.object({
  policy: z.enum(["skip", "overwrite", "fail"]).optional(),
  prune: z.boolean().optional(),
  kinds: z.array(z.enum(IMPORTABLE as [Kind, ...Kind[]])).max(20).optional(),
  only: z.array(z.string().max(200)).max(2000).optional(),
  activate: z.boolean().optional(),
  allowPartial: z.boolean().optional(),
});

export type Action = "create" | "update" | "unchanged" | "conflict" | "remove" | "keep" | "error";
export type PlanItem = { ref: string; kind: Kind; id: string; action: Action; changes: string[]; error?: string; path?: string; selected: boolean; apply: boolean };
export type Plan = {
  format: 1 | 2;
  ok: boolean;
  issues: Issue[];
  warnings: string[];
  items: PlanItem[];
  counts: Record<Action, number>;
  toApply: number;
  bundleChecksum: string;
  runtimeChecksum: string;
  baseline: { revision: string | null; at: string } | null;
  policy: Policy;
  prune: boolean;
  agent: { reachable: boolean; version: string | null };
};

export class ImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
    readonly plan?: Plan,
    readonly recordId?: string,
  ) {
    super(message);
  }
}

// --- reading ----------------------------------------------------------------------------------------------------------

const legacySchema = z
  .object({
    kind: z.literal(LEGACY_KIND),
    format: z.literal(1),
    exportedAt: z.string().max(40).optional(),
    source: z.string().max(200).optional(),
    schedules: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
    crews: z.array(z.object({ crew: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), version: z.number().int().positive().optional(), note: z.string().max(500).default(""), config: z.record(z.string(), z.unknown()), baseHash: z.string().max(64).nullable().optional(), promptVersion: z.string().max(100).nullable().optional() }).strict()).max(20).default([]),
    skills: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  })
  .strict();
type Legacy = z.output<typeof legacySchema>;

export type Bundle = { format: 2; files: Files } | { format: 1; legacy: Legacy };

/** What a request may send: {files} (format 2, or {kind: "moks-crewai-bundle", files}), or a format 1 file. */
export function readBundle(input: unknown): Bundle {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!o) throw new ImportError("Send a configuration bundle: {files: {path: text}} or a moks-crewai-config file.", 400);
  if (o.kind === LEGACY_KIND) {
    const r = legacySchema.safeParse(o);
    if (!r.success) throw new ImportError("The moks-crewai-config file is not valid.", 400, r.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "file"}: ${i.message}`));
    return { format: 1, legacy: r.data };
  }
  if (o.kind !== undefined && o.kind !== BUNDLE_KIND) throw new ImportError(`Unknown bundle kind ${String(o.kind).slice(0, 60)}: expected ${BUNDLE_KIND} or ${LEGACY_KIND}.`, 400);
  const files = o.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || !Object.values(files).every((v) => typeof v === "string")) throw new ImportError("files is an object of path → text.", 400);
  return { format: 2, files: files as Files };
}

// --- comparing --------------------------------------------------------------------------------------------------------

const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length <= 48 && !s.includes("\n") ? s : null;
};

/** The fields that differ, readable ("cron: 10 6 * * * → 30 5 * * *", "instructions"). */
export function changesOf(kind: Kind, before: unknown, after: unknown): string[] {
  const a = (editable(kind, before) ?? {}) as Record<string, unknown>;
  const b = (editable(kind, after) ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (stable(a[k]) === stable(b[k])) continue;
    const x = short(a[k] ?? null);
    const y = short(b[k] ?? null);
    if (k === "enabled") out.push(b[k] === false ? "switched off" : "switched on");
    else out.push(x !== null && y !== null ? `${k}: ${x} → ${y}` : k);
  }
  return out;
}

const byId = (config: CrewConfig, kind: Kind) => new Map((config[kind] as unknown[]).map((i) => [idOf(kind, i), i]));

// --- internal state of one plan (never sent to a browser) -------------------------------------------------------------

type Prepared = {
  overlays: Map<string, { config: Record<string, unknown>; default_hash: string; prompt_version: string; note: string }>;
  specs: Map<string, Record<string, unknown>>; // "crews:key" | "flows:key" → the spec the agent returned
  deleted: Set<string>; // "crews:key" | "flows:key" deleted in the admin
  legacyNotes: Map<string, string>;
};
type Internal = { bundle: CrewConfig; runtime: Runtime; agent: AgentSide; prepared: Prepared; base: Record<string, string> | null; scope: Set<string> | null; opts: ImportOptions };
export type Planned = { plan: Plan; internal: Internal };

const agentMessage = (e: unknown) => (e instanceof AgentError ? [e.message, ...e.issues].join(" ").slice(0, 800) : String((e as Error)?.message ?? e).slice(0, 800));
const unreachable = (e: unknown) => !(e instanceof AgentError) || e.status >= 500;

/** A legacy file → the items it describes (schedules, crew versions as full crews, skills), on top of what runs now. */
function fromLegacy(l: Legacy, runtime: Runtime, agent: AgentSide, issues: Issue[], warnings: string[], notes: Map<string, string>): { config: CrewConfig; scope: Set<string> } {
  const config = emptyConfig();
  const scope = new Set<string>();
  for (const s of l.schedules) {
    const r = KIND_INFO.get("schedules")!.schema.safeParse(s);
    if (!r.success) issues.push({ path: `schedules/${String(s.name ?? "?")}`, severity: "error", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    else {
      config.schedules.push(r.data as CrewConfig["schedules"][number]);
      scope.add(ref("schedules", idOf("schedules", r.data)));
    }
  }
  const skills = byId(runtime.config, "skills");
  for (const s of l.skills) {
    const r = KIND_INFO.get("skills")!.schema.safeParse({ ...s, builtin: Boolean((skills.get(String(s.name)) as { builtin?: boolean } | undefined)?.builtin) });
    if (!r.success) issues.push({ path: `skills/${String(s.name ?? "?")}`, severity: "error", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    else {
      config.skills.push(r.data as CrewConfig["skills"][number]);
      scope.add(ref("skills", idOf("skills", r.data)));
    }
  }
  const crews = byId(runtime.config, "crews");
  const defs = new Map((agent.catalogue?.crews ?? []).map((c) => [c.crew, c]));
  for (const c of l.crews) {
    const cur = crews.get(c.crew) as Crew | undefined;
    const def = defs.get(c.crew);
    scope.add(ref("crews", c.crew));
    if (!def || !cur) {
      issues.push({ path: `crews/${c.crew}`, severity: "error", message: agent.catalogue ? `This site has no crew ${c.crew} defined in code.` : "The SEO agent must answer to check a crew's configuration; try again when it is online." });
      continue;
    }
    if (c.baseHash && c.baseHash !== def.default_hash) warnings.push(`Crew ${c.crew}: written for other code defaults (another agent version): check it before relying on it.`);
    notes.set(c.crew, [`Imported${c.version ? ` (v${c.version} in the file)` : ""}`, c.note].filter(Boolean).join(": "));
    const oa = (c.config.agents ?? {}) as Record<string, Record<string, unknown>>;
    const ot = (c.config.tasks ?? {}) as Record<string, Record<string, unknown>>;
    config.crews.push(cur);
    for (const a of def.agents) {
      const o = oa[a.key] ?? {};
      config.agents.push({ crew: c.crew, key: a.key, role: String(o.role ?? a.role), goal: String(o.goal ?? a.goal), backstory: String(o.backstory ?? a.backstory), tools: (o.tools as string[] | undefined) ?? a.tools, model: (o.model as string | undefined) ?? null, max_tokens: (o.max_tokens as number | undefined) ?? a.max_tokens ?? null, max_iter: (o.max_iter as number | undefined) ?? null });
      scope.add(ref("agents", `${c.crew}.${a.key}`));
    }
    for (const t of def.tasks) {
      const o = ot[t.key] ?? {};
      config.tasks.push({ crew: c.crew, key: t.key, agent: t.agent, label: t.label, instructions: String(o.instructions ?? t.instructions), expected_output: String((t.output_editable ? o.expected_output : undefined) ?? t.expected_output), variables: t.variables, contract: t.contract, output_editable: t.output_editable });
      scope.add(ref("tasks", `${c.crew}.${t.key}`));
    }
    for (const k of Object.keys(oa)) if (!def.agents.some((a) => a.key === k)) issues.push({ path: `crews/${c.crew}`, severity: "error", message: `agents.${k}: the ${c.crew} crew has no such agent (${def.agents.map((a) => a.key).join(", ")})` });
    for (const k of Object.keys(ot)) if (!def.tasks.some((t) => t.key === k)) issues.push({ path: `crews/${c.crew}`, severity: "error", message: `tasks.${k}: the ${c.crew} crew has no such task (${def.tasks.map((t) => t.key).join(", ")})` });
  }
  return { config, scope };
}

/** The bundle in the form this site stores it (defaults filled, lists without repeats), so equal means equal. */
function normalize(b: CrewConfig, agent: AgentSide): CrewConfig {
  const uniq = (l: string[]) => [...new Set(l)];
  const defs = new Map((agent.catalogue?.crews ?? []).map((c) => [c.crew, c]));
  const code = new Set(b.crews.filter((c) => c.definition === "code").map((c) => c.key));
  return {
    ...b,
    skills: b.skills.map((s) => ({ ...s, agents: uniq(s.agents), tags: uniq(s.tags) })),
    tasks: b.tasks.map((t) => (code.has(t.crew) ? t : { ...t, context: t.context ?? [] })),
    agents: b.agents.map((a) => {
      const def = code.has(a.crew) ? defs.get(a.crew)?.agents.find((x) => x.key === a.key) : undefined;
      return { ...a, tools: uniq(a.tools), max_tokens: a.max_tokens ?? def?.max_tokens ?? null };
    }),
    flows: b.flows.map((f) => {
      if (f.definition !== "content" || !f.content) return f;
      const r = jobConfigSchema.safeParse({ ...f.content.config, source_ids: [] });
      if (!r.success) return f;
      const config = { ...r.data } as Record<string, unknown>;
      delete config.source_ids;
      return { ...f, content: { ...f.content, sources: uniq(f.content.sources), config } };
    }),
  };
}

/** References inside the bundle and to what this site has (crews ↔ agents ↔ tasks, flows → crews, schedules → flows…). */
function checkReferences(b: CrewConfig, runtime: Runtime, agent: AgentSide, paths: Map<string, string>, scope: Set<string> | null): Issue[] {
  const issues: Issue[] = [];
  const at = (kind: Kind, id: string) => paths.get(ref(kind, id)) ?? `${kind}/${id}`;
  const err = (kind: Kind, id: string, message: string) => issues.push({ path: at(kind, id), severity: "error", message, ref: ref(kind, id) });
  const rt = runtime.config;
  const crewKeys = new Set([...b.crews.map((c) => c.key), ...rt.crews.map((c) => c.key)]);
  const categories = new Set([...b.categories.map((c) => c.slug), ...rt.categories.map((c) => c.slug)]);
  // The bundle's own structure (check.ts): errors only; its "not in the bundle" warnings are checked against the site below.
  issues.push(...checkStructure(b, paths).filter((i) => i.severity === "error" && (!scope || !i.ref || scope.has(i.ref))));
  const tasksOf = new Map<string, Task[]>();
  for (const t of b.tasks) tasksOf.set(t.crew, [...(tasksOf.get(t.crew) ?? []), t]);
  const agentsOf = new Map<string, Agent[]>();
  for (const a of b.agents) agentsOf.set(a.crew, [...(agentsOf.get(a.crew) ?? []), a]);

  for (const c of b.crews) {
    const tfiles = new Map((tasksOf.get(c.key) ?? []).map((t) => [t.key, t]));
    for (const cat of c.categories) if (!categories.has(cat)) err("crews", c.key, `unknown category ${cat} (add it to categories/categories.yaml)`);
    if (c.definition === "code") {
      const def = agent.catalogue?.crews.find((x) => x.crew === c.key);
      if (agent.catalogue && !def) err("crews", c.key, `the SEO agent has no crew ${c.key} defined in code (make it a spec crew to add it here)`);
      if (def) {
        const ka = def.agents.map((a) => a.key);
        const kt = def.tasks.map((t) => t.key);
        if (stable(ka) !== stable(c.agents)) err("crews", c.key, `defined in code: its agents are ${ka.join(", ")} (the bundle lists ${c.agents.join(", ")}); duplicate the crew in the admin to change its structure`);
        if (stable(kt) !== stable(c.tasks)) err("crews", c.key, `defined in code: its tasks are ${kt.join(", ")} in that order (the bundle lists ${c.tasks.join(", ")}); duplicate the crew in the admin to change its structure`);
        for (const t of def.tasks) {
          const bt = tfiles.get(t.key);
          if (bt && !t.output_editable && bt.expected_output.trim() !== t.expected_output.trim()) err("tasks", `${c.key}.${t.key}`, "expected_output is fixed by the code (it parses this answer)");
        }
        for (const a of agentsOf.get(c.key) ?? []) {
          const bad = a.tools.filter((t) => !def.tools.includes(t));
          if (bad.length) err("agents", `${c.key}.${a.key}`, `tools not allowed for this crew: ${bad.join(", ")} (allowed: ${def.tools.join(", ") || "none"})`);
        }
      }
    } else {
      const custom = agent.catalogue?.custom_tools ?? [];
      if (custom.length) for (const a of agentsOf.get(c.key) ?? []) {
        const bad = a.tools.filter((t) => !custom.includes(t));
        if (bad.length) err("agents", `${c.key}.${a.key}`, `tools a crew made in the admin may not use: ${bad.join(", ")} (allowed: ${custom.join(", ")})`);
      }
    }
  }

  const agentFlows = new Map((agent.catalogue?.flows ?? []).map((f) => [f.name, f]));
  const specFlows = new Set([...b.flows, ...rt.flows].filter((f) => f.definition === "spec").map((f) => f.key));
  const sources = new Set([...b.sources, ...rt.sources].map((s) => s.url));
  for (const f of b.flows) {
    for (const cat of f.categories) if (!categories.has(cat)) err("flows", f.key, `unknown category ${cat} (add it to categories/categories.yaml)`);
    if (f.definition === "code") {
      if (agent.catalogue && !agentFlows.has(f.flow_name)) err("flows", f.key, `the SEO agent has no flow ${f.flow_name}`);
      if (f.key !== f.flow_name) err("flows", f.key, `a flow defined in code keeps its name as its key (${f.flow_name})`);
    }
    if (f.definition === "spec") {
      if (!f.spec) err("flows", f.key, "a spec flow needs its spec (inputs and steps)");
      for (const crew of crewsOfSpec(f.spec ?? null)) if (!crewKeys.has(crew)) err("flows", f.key, `step crew ${crew} is neither in the bundle nor on this site`);
      for (const s of ((f.spec?.steps as { kind?: string; flow?: string }[] | undefined) ?? []).filter((s) => s.kind === "flow"))
        if (s.flow && agent.catalogue && !agentFlows.has(s.flow)) err("flows", f.key, `step flow ${s.flow} is not a flow of the SEO agent`);
    }
    if (f.definition === "content") {
      if (!f.content) err("flows", f.key, "a content flow needs its settings (content)");
      if (!/^content_[0-9a-f]{12}$/.test(f.key)) err("flows", f.key, "a content flow's key is content_ and 12 hex digits (it comes from its settings' id)");
      for (const url of f.content?.sources ?? []) if (!sources.has(url)) err("flows", f.key, `source ${url} is neither in sources/sources.yaml nor on this site`);
    }
  }
  for (const s of b.schedules) {
    const f = agentFlows.get(s.flow);
    if (agent.catalogue && !f) err("schedules", s.name, `the SEO agent has no flow ${s.flow}`);
    else if (f && !f.schedulable) err("schedules", s.name, `${s.flow} cannot be scheduled`);
    if (s.flow === "custom_flow") {
      const target = typeof s.inputs.flow === "string" ? s.inputs.flow : "";
      if (!specFlows.has(target)) err("schedules", s.name, `inputs.flow ${target || "(missing)"} is not a spec flow in the bundle or on this site`);
    }
  }
  return issues;
}

// --- planning ---------------------------------------------------------------------------------------------------------

type PlanCtx = { db?: Db; deps?: AgentDeps; agent?: AgentSide };

export async function planImport(bundle: Bundle, rawOpts: Partial<ImportOptions> = {}, ctx: PlanCtx = {}): Promise<Planned> {
  const opts = importOptionsSchema.parse(rawOpts);
  const d = ctx.db ?? (await getDb());
  const agent = ctx.agent ?? (await loadAgentSide(ctx.deps));
  const runtime = await exportRuntime({ db: d, agent });
  const issues: Issue[] = [];
  const warnings: string[] = [];
  const prepared: Prepared = { overlays: new Map(), specs: new Map(), deleted: new Set(), legacyNotes: new Map() };
  let config: CrewConfig;
  let paths = new Map<string, string>();
  let scope: Set<string> | null = null;
  if (bundle.format === 2) {
    const parsed = fromFiles(bundle.files);
    issues.push(...parsed.issues, ...verifyManifest(bundle.files, parsed));
    config = parsed.config;
    paths = parsed.paths;
  } else {
    if (opts.prune) throw new ImportError("A moks-crewai-config file holds only part of the configuration: it cannot remove anything.", 400);
    const l = fromLegacy(bundle.legacy, runtime, agent, issues, warnings, prepared.legacyNotes);
    config = l.config;
    scope = l.scope;
  }
  if (!agent.catalogue) warnings.push(`The SEO agent did not answer (${agent.error ?? "unreachable"}): crews, flows and schedule inputs it would check are refused until it is online.`);
  issues.push(...checkReferences(config, runtime, agent, paths, scope));
  const bundleCfg = normalize(config, agent);

  for (const r of rowsOf<{ kind: string; key: string }>(await d.execute(sql`select 'crews' as kind, key from crewai_crews where deleted_at is not null union all select 'flows', key from crewai_flows where deleted_at is not null`))) prepared.deleted.add(`${r.kind}:${r.key}`);

  const base = (await loadBaseline(d).catch(() => null)) ?? null;
  const builtinSchedules = new Set((await listSchedules(d)).filter((s) => s.builtin).map((s) => s.name));
  const codeCrews = new Set(runtime.config.crews.filter((c) => c.definition === "code").map((c) => c.key));
  const baseItems = base?.items ?? null;
  const kinds = new Set<Kind>(opts.kinds?.length ? opts.kinds : IMPORTABLE);
  // A crew's agents and tasks go with it: choosing one of them chooses the crew.
  if (kinds.has("crews") || kinds.has("agents") || kinds.has("tasks")) ["crews", "agents", "tasks"].forEach((k) => kinds.add(k as Kind));
  const only = opts.only?.length ? new Set(opts.only) : null;
  const items: PlanItem[] = [];
  const itemOf = new Map<string, PlanItem>();
  const errorAt = (r: string, message: string) => {
    const it = itemOf.get(r);
    if (it) Object.assign(it, { action: "error", error: it.error ? `${it.error}; ${message}` : message });
  };
  const crewOf = (kind: Kind, id: string) => (kind === "crews" ? id : kind === "agents" || kind === "tasks" ? id.split(".")[0]! : null);
  const isSelected = (kind: Kind, id: string) => {
    if (!kinds.has(kind)) return false;
    if (!only) return true;
    const crew = crewOf(kind, id);
    return only.has(ref(kind, id)) || (crew !== null && only.has(ref("crews", crew)));
  };

  /** Compare one bundle item with what runs now and the baseline. */
  const assess = (it: PlanItem, item: unknown) => {
    const cur = byId(runtime.config, it.kind).get(it.id);
    if (!cur) {
      if (prepared.deleted.has(it.ref)) Object.assign(it, { action: "conflict", changes: ["deleted here (restorable): the bundle brings it back"] });
      else Object.assign(it, { action: "create", changes: [] });
      return;
    }
    if (itemChecksum(it.kind, cur) === itemChecksum(it.kind, item)) return void Object.assign(it, { action: "unchanged", changes: [] });
    it.changes = changesOf(it.kind, cur, item);
    const unchangedHere = baseItems ? baseItems[it.ref] === itemChecksum(it.kind, cur) : false;
    it.action = unchangedHere ? "update" : "conflict";
    if (!unchangedHere) it.changes.push(baseItems ? (it.ref in baseItems ? "also changed here since the last sync" : "not in the last sync") : "no earlier sync to compare with");
  };
  for (const k of KINDS) {
    if (!k.importable) continue;
    const b = byId(bundleCfg, k.kind);
    const r = byId(runtime.config, k.kind);
    for (const [id, item] of b) {
      const key = ref(k.kind, id);
      const it: PlanItem = { ref: key, kind: k.kind, id, action: "unchanged", changes: [], path: paths.get(key), selected: isSelected(k.kind, id), apply: false };
      items.push(it);
      itemOf.set(key, it);
      assess(it, item);
    }
    if (scope) continue;
    for (const [id, cur] of r) {
      if (b.has(id)) continue;
      const key = ref(k.kind, id);
      const removable = removableReason(k.kind, cur, builtinSchedules, codeCrews);
      const selected = isSelected(k.kind, id);
      const it: PlanItem = { ref: key, kind: k.kind, id, action: opts.prune && selected && removable === null ? "remove" : "keep", changes: [removable ?? (opts.prune ? "not in the bundle: removed" : "not in the bundle: kept (removal is off)")], selected, apply: false };
      items.push(it);
      itemOf.set(key, it);
    }
  }
  // An item problem refuses the item, unless the import would not change it (then it is a warning: nothing is saved).
  for (const i of issues) {
    if (i.severity !== "error" || !i.ref) continue;
    if (itemOf.get(i.ref)?.action === "unchanged") {
      i.severity = "warning";
      i.message = `${i.message} (unchanged here, so not refused)`;
    } else errorAt(i.ref, i.message);
  }

  // The agent's checks, for what would be saved (spec checks also normalise: a spec equal after them is unchanged).
  const changed = (r: string) => ["create", "update", "conflict"].includes(itemOf.get(r)?.action ?? "");
  /** Changed, or already refused: the local checks still run, so every reason is listed. */
  const pending = (r: string) => changed(r) || itemOf.get(r)?.action === "error";
  const unitChanged = (crew: string) => [ref("crews", crew), ...bundleCfg.agents.filter((a) => a.crew === crew).map((a) => ref("agents", `${a.crew}.${a.key}`)), ...bundleCfg.tasks.filter((t) => t.crew === crew).map((t) => ref("tasks", `${t.crew}.${t.key}`))].some(changed);
  const enabledSpecCrews = [...new Set([...runtime.config.crews, ...bundleCfg.crews].filter((c) => c.definition === "spec" && c.enabled).map((c) => c.key))];
  for (const c of bundleCfg.crews) {
    const crewRef = ref("crews", c.key);
    if (!isSelected("crews", c.key) || !unitChanged(c.key) || itemOf.get(crewRef)?.action === "error") continue;
    const agents = bundleCfg.agents.filter((a) => a.crew === c.key);
    const tasks = c.tasks.map((k) => bundleCfg.tasks.find((t) => t.crew === c.key && t.key === k)!).filter(Boolean);
    try {
      if (c.definition === "code") {
        const def = agent.catalogue?.crews.find((x) => x.crew === c.key);
        if (!def) throw new ImportError("The SEO agent must answer to check a crew's configuration; try again when it is online.", 503);
        const cfg = {
          agents: Object.fromEntries(agents.map((a) => [a.key, { role: a.role, goal: a.goal, backstory: a.backstory, tools: a.tools, ...(a.model ? { model: a.model } : {}), ...(a.max_tokens ? { max_tokens: a.max_tokens } : {}), ...(a.max_iter ? { max_iter: a.max_iter } : {}) }])),
          tasks: Object.fromEntries(tasks.map((t) => [t.key, { instructions: t.instructions, ...(def.tasks.find((x) => x.key === t.key)?.output_editable ? { expected_output: t.expected_output } : {}) }])),
        };
        const ok = await validateCrewConfig(c.key, cfg, ctx.deps);
        prepared.overlays.set(c.key, { ...ok, note: prepared.legacyNotes.get(c.key) ?? "" });
        if (c.code && c.code.default_hash !== ok.default_hash) warnings.push(`Crew ${c.key}: exported from another version of the SEO agent's code (${c.code.prompt_version} → ${ok.prompt_version}); its prompts are applied on top of this version's code.`);
      } else {
        const spec = { key: c.key, label: c.label, description: c.description, inputs: c.inputs ?? [], output: c.output ?? null, model: c.model ?? null, agents: agents.map((a) => ({ key: a.key, role: a.role, goal: a.goal, backstory: a.backstory, tools: a.tools, model: a.model, max_tokens: a.max_tokens, max_iter: a.max_iter })), tasks: tasks.map((t) => ({ key: t.key, agent: t.agent, label: t.label, instructions: t.instructions, expected_output: t.expected_output, context: t.context ?? [] })) };
        const checked = (await validateCustomSpec("crew", spec, undefined, ctx.deps)).spec;
        prepared.specs.set(crewRef, checked);
        adoptCrewSpec(bundleCfg, c.key, checked);
        for (const r0 of [crewRef, ...bundleCfg.agents.filter((a) => a.crew === c.key).map((a) => ref("agents", `${c.key}.${a.key}`)), ...bundleCfg.tasks.filter((t) => t.crew === c.key).map((t) => ref("tasks", `${c.key}.${t.key}`))]) {
          const it = itemOf.get(r0);
          const [kind, id] = [r0.slice(0, r0.indexOf(":")) as Kind, r0.slice(r0.indexOf(":") + 1)];
          if (it && it.action !== "error") assess(it, byId(bundleCfg, kind).get(id));
        }
      }
    } catch (e) {
      const msg = e instanceof ImportError ? e.message : unreachable(e) ? "the SEO agent must answer to check this crew; try again when it is online" : agentMessage(e);
      errorAt(crewRef, msg);
    }
  }
  for (const f of bundleCfg.flows) {
    const fr = ref("flows", f.key);
    if (!isSelected("flows", f.key) || !changed(fr)) continue;
    if (f.definition === "spec") {
      try {
        const checked = (await validateCustomSpec("flow", { ...(f.spec ?? {}), key: f.key, label: f.label, description: f.description }, enabledSpecCrews, ctx.deps)).spec;
        prepared.specs.set(fr, checked);
        const own = { ...checked };
        delete own.key;
        delete own.label;
        delete own.description;
        f.spec = own;
        const it = itemOf.get(fr);
        if (it && it.action !== "error") assess(it, f);
      } catch (e) {
        errorAt(fr, unreachable(e) ? "the SEO agent must answer to check this flow; try again when it is online" : agentMessage(e));
      }
    }
    if (f.definition === "content" && f.content) {
      const job = jobInput.safeParse({ name: f.label, description: f.description, enabled: f.enabled, cron: f.content.cron, timezone: f.content.timezone, mode: f.content.mode, writing_profile_key: f.content.writing_profile_key, image_profile_key: f.content.image_profile_key, review_priority: f.content.review_priority, config: { ...f.content.config, source_ids: [] } });
      if (!job.success) errorAt(fr, job.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const cron = cronError(f.content.cron, f.content.timezone);
      if (cron) errorAt(fr, `cron: ${cron}`);
      const profiles = rowsOf<{ kind: string; key: string }>(await d.execute(sql`select 'writing' as kind, key from news_writing_profiles union all select 'image', key from news_image_profiles`));
      if (!profiles.some((p) => p.kind === "writing" && p.key === f.content!.writing_profile_key)) errorAt(fr, `writing profile ${f.content.writing_profile_key} does not exist on this site`);
      if (!profiles.some((p) => p.kind === "image" && p.key === f.content!.image_profile_key)) errorAt(fr, `image profile ${f.content.image_profile_key} does not exist on this site`);
    }
  }
  let agentDown = false;
  for (const s of bundleCfg.schedules) {
    const sr = ref("schedules", s.name);
    if (!isSelected("schedules", s.name) || !pending(sr)) continue;
    const v = scheduleInput.safeParse(s);
    if (!v.success) {
      errorAt(sr, v.error.issues.map((i) => `${i.path.join(".") || "schedule"}: ${i.message}`).join("; "));
      continue;
    }
    const cur = byId(runtime.config, "schedules").get(s.name) as CrewConfig["schedules"][number] | undefined;
    if (cur && cur.flow !== s.flow) {
      errorAt(sr, `this site's ${s.name} runs ${cur.flow}, the bundle's runs ${s.flow}: rename one of them`);
      continue;
    }
    if (agentDown) continue;
    try {
      await validateFlowInputs(s.flow, s.inputs, ctx.deps);
    } catch (e) {
      if (unreachable(e)) {
        agentDown = true;
        warnings.push("The SEO agent did not answer, so schedule inputs were not checked; the dispatcher checks them at every start.");
      } else errorAt(sr, `inputs: ${agentMessage(e)}`);
    }
  }
  for (const s of bundleCfg.skills) {
    const sr = ref("skills", s.name);
    if (!isSelected("skills", s.name) || !pending(sr)) continue;
    const v = skillCreateSchema.safeParse({ name: s.name, description: s.description, instructions: s.instructions, agents: s.agents, tags: s.tags, enabled: s.enabled });
    if (!v.success) errorAt(sr, v.error.issues.map((i) => `${i.path.join(".") || "skill"}: ${i.message}`).join("; "));
    if (s.builtin && itemOf.get(sr)?.action === "create") itemOf.get(sr)!.changes.push("shipped by another CMS version: created as this site's own skill");
  }
  for (const s of bundleCfg.sources) {
    const sr = ref("sources", s.url);
    if (!isSelected("sources", s.url) || !pending(sr)) continue;
    const v = sourceInput.safeParse(s);
    if (!v.success) errorAt(sr, v.error.issues.map((i) => `${i.path.join(".") || "source"}: ${i.message}`).join("; "));
  }

  // A selected item that needs an unselected new one.
  for (const it of items) {
    if (!it.selected || !["create", "update", "conflict"].includes(it.action)) continue;
    const needs: string[] = [];
    if (it.kind === "flows") {
      const f = byId(bundleCfg, "flows").get(it.id) as Flow;
      needs.push(...crewsOfSpec(f.spec ?? null).map((c) => ref("crews", c)), ...(f.content?.sources ?? []).map((u) => ref("sources", u)), ...f.categories.map((c) => ref("categories", c)));
    }
    if (it.kind === "crews") needs.push(...(byId(bundleCfg, "crews").get(it.id) as Crew).categories.map((c) => ref("categories", c)));
    if (it.kind === "schedules") {
      const s = byId(bundleCfg, "schedules").get(it.id) as CrewConfig["schedules"][number];
      if (s.flow === "custom_flow" && typeof s.inputs.flow === "string") needs.push(ref("flows", s.inputs.flow));
    }
    for (const n of needs) {
      const dep = itemOf.get(n);
      if (dep && dep.action === "create" && !dep.selected) errorAt(it.ref, `needs ${n.replace(":", " ")}, which is new: include it in the import`);
      if (dep && dep.action === "error" && dep.selected) errorAt(it.ref, `needs ${n.replace(":", " ")}, which is refused`);
    }
  }

  // Bundle-level problems (a file that cannot be read, a newer format) stop the import; item problems refuse their item.
  const errors = issues.filter((i) => i.severity === "error" && !i.ref);
  for (const it of items) it.apply = it.selected && (it.action === "create" || it.action === "update" || it.action === "remove" || (it.action === "conflict" && opts.policy === "overwrite"));
  // A crew is saved as one unit (one version, or one spec) with its agents and tasks: one of them held back holds it back.
  for (const c of bundleCfg.crews) {
    const members = items.filter((i) => crewOf(i.kind, i.id) === c.key && i.kind !== "categories");
    const held = members.find((i) => i.action === "error" || (i.action === "conflict" && !i.apply));
    if (!held) continue;
    for (const m of members) {
      if (m === held || !m.apply) continue;
      m.apply = false;
      m.changes.push(`held back with ${held.ref.replace(":", " ")} (${held.action === "error" ? "refused" : "in conflict"})`);
    }
  }
  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0, remove: 0, keep: 0, error: 0 } as Record<Action, number>;
  for (const it of items) counts[it.action]++;
  const refusedSelected = items.some((i) => i.selected && i.action === "error");
  const plan: Plan = {
    format: bundle.format,
    ok: errors.length === 0 && (!refusedSelected || opts.allowPartial) && !(opts.policy === "fail" && items.some((i) => i.selected && i.action === "conflict")),
    issues,
    warnings: [...new Set(warnings)],
    items,
    counts,
    toApply: items.filter((i) => i.apply).length,
    bundleChecksum: configChecksum(bundleCfg),
    runtimeChecksum: configChecksum(runtime.config),
    baseline: base ? { revision: base.record.revision, at: base.record.createdAt } : null,
    policy: opts.policy,
    prune: opts.prune,
    agent: runtime.report.agent,
  };
  if (opts.policy === "fail" && items.some((i) => i.selected && i.action === "conflict")) plan.warnings.push("The policy is fail and some items are in conflict: nothing is applied.");
  return { plan, internal: { bundle: bundleCfg, runtime, agent, prepared, base: baseItems, scope, opts } };
}

/** Why an item this site has, and the bundle lacks, is never removed (null: it can be). */
function removableReason(kind: Kind, item: unknown, builtinSchedules: Set<string>, codeCrews: Set<string>): string | null {
  const o = item as Record<string, unknown>;
  if ((kind === "crews" || kind === "flows") && o.definition === "code") return "defined in code: never removed by an import (switch it off instead)";
  if ((kind === "agents" || kind === "tasks") && codeCrews.has(String(o.crew))) return "part of a crew defined in code: never removed by an import";
  if (kind === "skills" && o.builtin) return "shipped with the CMS: never removed by an import (switch it off instead)";
  if (kind === "schedules" && builtinSchedules.has(String(o.name))) return "shipped with the CMS: never removed by an import (pause it instead)";
  return null;
}

// --- applying ---------------------------------------------------------------------------------------------------------

export type ApplyMeta = { source: SyncSource; revision?: string | null; ref?: string | null; url?: string | null; label?: string };
export type ApplyResult = { recordId: string; applied: Record<string, number>; status: "applied" | "unchanged"; runtimeChecksum: string; verified: true };

/** A uuid whose first 12 hex digits give `key` (content_<12 hex>) back: a content flow keeps its key across sites. */
function jobIdFor(key: string): string {
  const h = key.slice("content_".length) + randomBytes(10).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Apply a plan made by planImport (computed again just before, by the caller), in one transaction, then verify it. */
export async function applyImport(planned: Planned, actor: Actor, meta: ApplyMeta, ctx: PlanCtx = {}): Promise<ApplyResult> {
  const { plan, internal } = planned;
  const d = ctx.db ?? (await getDb());
  const { bundle, runtime, prepared, opts } = internal;
  if (!plan.ok) {
    const issues = [...plan.issues.filter((i) => i.severity === "error" && !i.ref).map((i) => `${i.path}: ${i.message}`), ...plan.items.filter((i) => i.selected && i.action === "error").map((i) => `${i.ref}: ${i.error}`)].slice(0, 30);
    const recordId = await recordSync({ direction: "import", mode: "apply", source: meta.source, status: "refused", policy: opts.policy, revision: meta.revision ?? null, ref: meta.ref ?? null, url: meta.url ?? null, bundleChecksum: plan.bundleChecksum, runtimeChecksum: plan.runtimeChecksum, summary: { counts: plan.counts, format: plan.format }, plan: compactPlan(plan), error: [refusal(plan), ...issues].join("\n"), actor: actor.label }, d).catch(() => undefined);
    throw new ImportError(refusal(plan), 409, issues, plan, recordId);
  }
  const todo = plan.items.filter((i) => i.apply && i.action !== "error");
  const want = (kind: Kind, id: string) => todo.find((i) => i.kind === kind && i.id === id);
  const label = meta.label ?? `${meta.source}${meta.revision ? `@${meta.revision.slice(0, 12)}` : ""}`;
  const note = `Imported from ${label}`;
  const applied: Record<string, number> = {};
  const count = (k: string) => (applied[k] = (applied[k] ?? 0) + 1);
  try {
    const result = await d.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const w = { db, checked: true } as const;
      // Categories, then sources (flows name them).
      for (const c of bundle.categories) {
        const it = want("categories", c.slug);
        if (!it) continue;
        if (it.action === "create") await createCategory(actor, c, { db });
        else await updateCategory(actor, c.slug, c, { db });
        count("categories");
      }
      const sourceIds = new Map(runtime.sourceIds);
      for (const s of bundle.sources) {
        const it = want("sources", s.url);
        if (!it) continue;
        const { saveSource } = await import("@/lib/news/service");
        const r = await saveSource(actor, sourceIds.get(s.url) ?? null, s, db);
        sourceIds.set(s.url, r.id);
        count("sources");
      }
      // Crews (with their agents and tasks), switched on before the flows that run them.
      const later: (() => Promise<unknown>)[] = [];
      const rtCrews = byId(runtime.config, "crews");
      for (const c of bundle.crews) {
        const members = [ref("crews", c.key), ...bundle.agents.filter((a) => a.crew === c.key).map((a) => ref("agents", `${c.key}.${a.key}`)), ...bundle.tasks.filter((t) => t.crew === c.key).map((t) => ref("tasks", `${c.key}.${t.key}`))];
        if (!todo.some((i) => members.includes(i.ref))) continue;
        const cur = rtCrews.get(c.key) as Crew | undefined;
        if (prepared.deleted.has(ref("crews", c.key))) await restoreItem("crew", actor, c.key, { db });
        const metaPatch = { label: c.label, description: c.description, objective: c.objective, categories: c.categories, tags: c.tags };
        if (c.definition === "code") {
          if (!cur || changesOf("crews", { ...cur, agents: [], tasks: [] }, { ...c, agents: [], tasks: [] }).length || prepared.deleted.has(ref("crews", c.key))) await updateItem("crew", actor, c.key, metaPatch, {}, w);
          const ov = prepared.overlays.get(c.key);
          const active = (await activeVersions(db)).find((v) => v.crew === c.key);
          if (ov && stable(active?.config ?? {}) !== stable(ov.config)) {
            await saveVersion({ crew: c.key, config: ov.config, note: ov.note || note, source: "import", baseHash: ov.default_hash, promptVersion: ov.prompt_version, activate: opts.activate, actor: actor.label }, db);
          }
        } else {
          const spec = prepared.specs.get(ref("crews", c.key));
          if (!cur && !prepared.deleted.has(ref("crews", c.key))) await createItem("crew", actor, { key: c.key, ...metaPatch, enabled: false, spec, note }, {}, w);
          else await updateItem("crew", actor, c.key, { ...metaPatch, ...(spec && (!cur || stable(spec) !== stable(specOfCrew(cur, runtime.config))) ? { spec, note } : {}) }, {}, w);
        }
        const wasOn = cur?.enabled ?? false;
        if (c.enabled && (!wasOn || !cur)) await setEnabled("crew", actor, c.key, true, null, { db });
        if (!c.enabled && (wasOn || prepared.deleted.has(ref("crews", c.key)))) later.push(() => setEnabled("crew", actor, c.key, false, null, { db }));
        count("crews");
      }
      // Skills.
      const skills = new Map((await listSkills(db)).map((s) => [s.name, s]));
      for (const s of bundle.skills) {
        const it = want("skills", s.name);
        if (!it) continue;
        const body = { description: s.description, instructions: s.instructions, agents: s.agents, tags: s.tags, enabled: s.enabled };
        const cur = skills.get(s.name);
        if (cur) await updateSkill(actor, cur.id, body, db);
        else await createSkill(actor, { name: s.name, ...body }, db);
        count("skills");
      }
      // Flows.
      const rtFlows = byId(runtime.config, "flows");
      const flowLater: (() => Promise<unknown>)[] = [];
      for (const f of bundle.flows) {
        const it = want("flows", f.key);
        if (!it) continue;
        const cur = rtFlows.get(f.key) as Flow | undefined;
        const deleted = prepared.deleted.has(ref("flows", f.key));
        if (deleted) await restoreItem("flow", actor, f.key, { db });
        const metaPatch = { label: f.label, description: f.description, categories: f.categories, tags: f.tags };
        if (f.definition === "code") {
          await updateItem("flow", actor, f.key, metaPatch, {}, w);
        } else if (f.definition === "spec") {
          const spec = prepared.specs.get(ref("flows", f.key));
          if (!cur && !deleted) await createItem("flow", actor, { key: f.key, ...metaPatch, enabled: false, spec, note }, {}, w);
          else await updateItem("flow", actor, f.key, { ...metaPatch, ...(spec ? { spec, note } : {}) }, {}, w);
        } else {
          const { createJob, updateJob } = await import("@/lib/news/service");
          const source_ids = (f.content!.sources ?? []).map((u) => sourceIds.get(u)).filter((x): x is string => Boolean(x));
          const job = { name: f.label, description: f.description, enabled: false, cron: f.content!.cron, timezone: f.content!.timezone, mode: f.content!.mode, writing_profile_key: f.content!.writing_profile_key, image_profile_key: f.content!.image_profile_key, review_priority: f.content!.review_priority, config: { ...f.content!.config, source_ids } };
          const jobId = runtime.jobIds.get(f.key) ?? (deleted ? (rowsOf<{ id: string }>(await db.execute(sql`select content_job_id::text as id from crewai_flows where key = ${f.key}`))[0]?.id ?? null) : null);
          if (jobId) {
            const [cj] = rowsOf<{ enabled: boolean }>(await db.execute(sql`select enabled from news_jobs where id = ${jobId}::uuid`));
            await updateJob(actor, jobId, { ...job, enabled: Boolean(cj?.enabled) }, note, db);
          } else {
            await createJob(actor, job, { db, id: jobIdFor(f.key) });
            const [row] = rowsOf<{ key: string }>(await db.execute(sql`select key from crewai_flows where key = ${f.key}`));
            if (!row) throw new ImportError(`The content flow ${f.key} was created under another key.`, 500);
          }
          await updateItem("flow", actor, f.key, { categories: f.categories, tags: f.tags }, {}, w);
        }
        const wasOn = cur?.enabled ?? false;
        if (f.enabled && (!wasOn || !cur || deleted)) flowLater.unshift(() => setEnabled("flow", actor, f.key, true, null, { db }));
        if (!f.enabled && (wasOn || (cur && (cur.disabled_reason ?? null) !== (f.disabled_reason ?? null)))) flowLater.push(() => setEnabled("flow", actor, f.key, false, f.disabled_reason, { db }));
        count("flows");
      }
      for (const fn of flowLater) await fn();
      for (const fn of later) await fn();
      // Schedules (their flows exist now).
      const schedules = new Map((await listSchedules(db)).map((s) => [s.name, s]));
      for (const s of bundle.schedules) {
        const it = want("schedules", s.name);
        if (!it) continue;
        const v = scheduleInput.parse(s);
        const cur = schedules.get(s.name);
        if (cur) await updateSchedule(cur.id, { description: v.description, cron: v.cron, timezone: v.timezone, inputs: v.inputs, enabled: v.enabled }, actor.label, db);
        else await createSchedule(v, actor.label, db);
        count("schedules");
      }
      // Removals, only when asked: what refers to others first.
      const removals = todo.filter((i) => i.action === "remove");
      for (const kind of ["schedules", "flows", "skills", "crews", "sources", "categories"] as Kind[]) {
        for (const it of removals.filter((i) => i.kind === kind)) {
          if (kind === "schedules") {
            const cur = schedules.get(it.id);
            if (cur && !cur.builtin) await deleteSchedule(cur.id, db);
            else if (cur) await updateSchedule(cur.id, { enabled: false }, actor.label, db);
          }
          if (kind === "flows") await deleteItem("flow", actor, it.id, { db });
          if (kind === "crews") await deleteItem("crew", actor, it.id, { db });
          if (kind === "skills") {
            const cur = skills.get(it.id);
            if (cur && !cur.builtin) await deleteSkill(actor, cur.id, db);
          }
          if (kind === "sources") {
            const { deleteSource } = await import("@/lib/news/service");
            const id = runtime.sourceIds.get(it.id);
            if (id) await deleteSource(actor, id, db);
          }
          if (kind === "categories") await deleteCategory(actor, it.id, { db });
          count(`removed ${kind}`);
        }
      }

      // Verify: the configuration now holds what the bundle says, item by item.
      const after = await exportRuntime({ db, agent: internal.agent, sync: false });
      const now = new Map<string, unknown>();
      for (const k of IMPORTABLE) for (const item of after.config[k] as unknown[]) now.set(ref(k, idOf(k, item)), item);
      const wrong: string[] = [];
      for (const it of todo) {
        const got = now.get(it.ref);
        if (it.action === "remove") {
          if (got && !(it.kind === "schedules" || it.kind === "skills")) wrong.push(`${it.ref} is still there`);
          continue;
        }
        const wanted = (byId(bundle, it.kind).get(it.id) ?? null) as unknown;
        if (!got) wrong.push(`${it.ref} is missing`);
        else if (itemChecksum(it.kind, got) !== itemChecksum(it.kind, wanted)) wrong.push(`${it.ref}: ${changesOf(it.kind, wanted, got).join(", ") || "differs"}`);
      }
      if (wrong.length) throw new ImportError("The import did not verify: what was saved differs from the bundle, so nothing was changed.", 500, wrong.slice(0, 30));

      // The new baseline: everything the bundle and the site now agree on; a skipped conflict keeps its old value.
      const nextBase: Record<string, string> = { ...(internal.base ?? {}) };
      for (const it of plan.items) {
        const got = now.get(it.ref);
        if (it.action === "remove" && it.apply) delete nextBase[it.ref];
        else if ((it.apply || it.action === "unchanged") && got) nextBase[it.ref] = itemChecksum(it.kind, got);
      }
      const runtimeChecksum = configChecksum(after.config);
      const status = todo.length ? "applied" : "unchanged";
      const recordId = await recordSync(
        {
          direction: "import",
          mode: "apply",
          source: meta.source,
          status,
          policy: opts.policy,
          revision: meta.revision ?? null,
          ref: meta.ref ?? null,
          url: meta.url ?? null,
          bundleChecksum: plan.bundleChecksum,
          runtimeChecksum,
          summary: { counts: plan.counts, applied, format: plan.format, prune: opts.prune, kinds: opts.kinds ?? null, only: opts.only?.length ?? 0 },
          plan: compactPlan(plan),
          error: null,
          actor: actor.label,
          baseline: nextBase,
          snapshot: todo.length ? runtime.config : null,
        },
        db,
      );
      await audit(actor, "crewai.config.import", label, { applied, counts: plan.counts, policy: opts.policy, prune: opts.prune, revision: meta.revision ?? null, record: recordId }, { db });
      return { recordId, applied, status: status as ApplyResult["status"], runtimeChecksum, verified: true as const };
    });
    forgetStatus();
    return result;
  } catch (e) {
    const err = e instanceof ImportError ? e : new ImportError(`The import failed and nothing was changed: ${String((e as Error)?.message ?? e).slice(0, 500)}`, 500);
    const recordId = await recordSync({ direction: "import", mode: "apply", source: meta.source, status: "failed", policy: opts.policy, revision: meta.revision ?? null, ref: meta.ref ?? null, url: meta.url ?? null, bundleChecksum: plan.bundleChecksum, runtimeChecksum: plan.runtimeChecksum, summary: { counts: plan.counts }, plan: compactPlan(plan), error: [err.message, ...err.issues].join("\n"), actor: actor.label }, d).catch(() => undefined);
    await audit(actor, "crewai.config.import.failed", label, { error: err.message.slice(0, 300), record: recordId ?? null }).catch(() => undefined);
    throw new ImportError(err.message, err.status, err.issues, plan, recordId);
  }
}

/** Put the spec the agent returned (defaults filled, inputs as objects) back into the bundle's crew, agents and tasks, so
 * the plan compares, and the import verifies, what will actually be stored. */
function adoptCrewSpec(b: CrewConfig, key: string, spec: Record<string, unknown>) {
  const agents = (spec.agents as Record<string, unknown>[] | undefined) ?? [];
  const tasks = (spec.tasks as Record<string, unknown>[] | undefined) ?? [];
  const i = b.crews.findIndex((c) => c.key === key);
  if (i < 0) return;
  b.crews[i] = { ...b.crews[i]!, agents: agents.map((a) => String(a.key)), tasks: tasks.map((t) => String(t.key)), inputs: (spec.inputs as Crew["inputs"]) ?? [], output: (spec.output as Crew["output"]) ?? null, model: (spec.model as string | null | undefined) ?? null };
  b.agents = [...b.agents.filter((a) => a.crew !== key), ...agents.map((a) => ({ crew: key, key: String(a.key), role: String(a.role), goal: String(a.goal), backstory: String(a.backstory), tools: (a.tools as string[] | undefined) ?? [], model: (a.model as string | null | undefined) ?? null, max_tokens: (a.max_tokens as number | null | undefined) ?? null, max_iter: (a.max_iter as number | null | undefined) ?? null }))];
  b.tasks = [...b.tasks.filter((t) => t.crew !== key), ...tasks.map((t) => ({ crew: key, key: String(t.key), agent: String(t.agent), label: String(t.label), instructions: String(t.instructions), expected_output: String(t.expected_output), context: (t.context as string[] | undefined) ?? [] }))];
}

function specOfCrew(c: Crew, config: CrewConfig): Record<string, unknown> {
  const agents = config.agents.filter((a) => a.crew === c.key);
  const tasks = c.tasks.map((k) => config.tasks.find((t) => t.crew === c.key && t.key === k)!).filter(Boolean);
  return { key: c.key, label: c.label, description: c.description, inputs: c.inputs ?? [], output: c.output ?? null, model: c.model ?? null, agents: agents.map((a) => ({ key: a.key, role: a.role, goal: a.goal, backstory: a.backstory, tools: a.tools, model: a.model, max_tokens: a.max_tokens, max_iter: a.max_iter })), tasks: tasks.map((t) => ({ key: t.key, agent: t.agent, label: t.label, instructions: t.instructions, expected_output: t.expected_output, context: t.context ?? [] })) };
}

/** Why a plan cannot be applied, in one sentence. */
export function refusal(plan: Plan): string {
  const errors = plan.issues.filter((i) => i.severity === "error" && !i.ref).length;
  const refused = plan.items.filter((i) => i.selected && i.action === "error").length;
  const conflicts = plan.items.filter((i) => i.selected && i.action === "conflict").length;
  if (errors) return `The bundle has ${errors} problem${errors === 1 ? "" : "s"}: nothing was applied.`;
  if (refused) return `${refused} item${refused === 1 ? " was" : "s were"} refused: nothing was applied (allow a partial import to apply the rest).`;
  if (plan.policy === "fail" && conflicts) return `${conflicts} item${conflicts === 1 ? " is" : "s are"} in conflict and the policy is fail: nothing was applied.`;
  return "The plan cannot be applied.";
}

/** The plan as stored with a sync record: every item that is not unchanged, and the counts. */
export function compactPlan(plan: Plan) {
  return { ...plan, items: plan.items.filter((i) => i.action !== "unchanged" || i.apply).slice(0, 2000), issues: plan.issues.slice(0, 200) };
}

/** Plan, and (unless `dryRun`) apply: the one entry point of the routes, the repository sync and a deployment. */
export async function importBundle(input: unknown, opts: Partial<ImportOptions> & { dryRun?: boolean }, actor: Actor, meta: ApplyMeta, ctx: PlanCtx = {}): Promise<{ plan: Plan; result: ApplyResult | null; recordId: string | null }> {
  const bundle = readBundle(input);
  const { dryRun, ...rest } = opts;
  const planned = await planImport(bundle, rest, ctx);
  if (dryRun) {
    // A plan is recorded only when it is refused (a deployment's or a pull request's check that would fail): plans are
    // made all the time (every preview, every deploy before it applies) and change nothing.
    const recordId = meta.source === "admin" || planned.plan.ok ? null : await recordSync({ direction: "import", mode: "dry_run", source: meta.source, status: "refused", policy: planned.plan.policy, revision: meta.revision ?? null, ref: meta.ref ?? null, url: meta.url ?? null, bundleChecksum: planned.plan.bundleChecksum, runtimeChecksum: planned.plan.runtimeChecksum, summary: { counts: planned.plan.counts, format: planned.plan.format }, plan: compactPlan(planned.plan), error: planned.plan.ok ? null : refusal(planned.plan), actor: actor.label }, ctx.db).catch(() => null);
    return { plan: planned.plan, result: null, recordId };
  }
  const result = await applyImport(planned, actor, meta, ctx);
  return { plan: planned.plan, result, recordId: result.recordId };
}

/** Put the configuration back as it was before an applied import (its snapshot), as a new import. */
export async function rollbackImport(recordId: string, actor: Actor, ctx: PlanCtx = {}) {
  const { getSync } = await import("./sync");
  const rec = await getSync(recordId, ctx.db);
  if (!rec) throw new ImportError("No such import.", 404);
  if (!rec.snapshot) throw new ImportError("This import changed nothing, or kept no copy of what was there before.", 409);
  const { toFiles } = await import("./files");
  const files = toFiles({ ...emptyConfig(), ...rec.snapshot }, { source: "rollback", exportedAt: rec.createdAt, cmsVersion: process.env.GIT_SHA ?? "dev", agentVersion: null, unsupported: [] });
  return importBundle({ files }, { policy: "overwrite", prune: true }, actor, { source: "rollback", label: `rollback of ${recordId.slice(0, 8)}` }, ctx);
}
