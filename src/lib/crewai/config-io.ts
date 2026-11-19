import "server-only";
import { z } from "zod";
import type { Db } from "@/db";
import type { Actor } from "../posts";
import { createSkill, listSkills, updateSkill } from "../seo-agent/skills";
import { activeVersions, saveVersion } from "./crews";
import { createSchedule, exportable, listSchedules, NAME, scheduleInput, updateSchedule } from "./schedules";

/**
 * Import and export of the CrewAI console's configuration (CrewAI console → Import / export, D-98): schedules, the
 * active crew configuration versions and the agent skills, as one JSON file. Use it to copy a site's setup to another
 * site, to keep it in the site's repository, or as a backup before a big change.
 *
 * - Export never contains secrets, run history or ids: schedules by name, crews by crew id, skills by name.
 * - Import is a plan first (what would be created, changed or left alone, and what is refused), then the same plan
 *   recomputed and applied. It only adds and changes: nothing missing from the file is deleted or paused.
 * - A crew's configuration becomes a new version (source "import"), checked by the SEO agent against the crew's code,
 *   so the agent must be reachable to import crews; it is made active when asked. An unchanged one is skipped.
 * - Schedules are matched by name; a schedule's flow cannot change on import (rename it instead). Their inputs are
 *   checked by the agent when it answers, and again by the dispatcher at every start.
 * - Skills are matched by name and go through the Skills page's own checks.
 */

export const BUNDLE_KIND = "moks-crewai-config";
export const BUNDLE_FORMAT = 1;

const scheduleItem = z
  .object({
    name: z.string().regex(NAME).max(64),
    flow: z.string().max(60),
    description: z.string().max(300).default(""),
    cron: z.string().max(120),
    timezone: z.string().max(64).default("Etc/UTC"),
    inputs: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
  })
  .strict();
const crewItem = z
  .object({
    crew: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    version: z.number().int().positive().optional(),
    note: z.string().max(500).default(""),
    config: z.record(z.string(), z.unknown()),
    baseHash: z.string().max(64).nullable().optional(),
    promptVersion: z.string().max(100).nullable().optional(),
  })
  .strict();
const skillItem = z
  .object({
    name: z.string().max(64),
    description: z.string().max(1024),
    instructions: z.string().max(8000),
    agents: z.array(z.string().max(80)).max(20),
    tags: z.array(z.string().max(80)).max(20).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

export const bundleSchema = z
  .object({
    kind: z.literal(BUNDLE_KIND),
    format: z.literal(BUNDLE_FORMAT),
    exportedAt: z.string().max(40).optional(),
    source: z.string().max(200).optional(),
    schedules: z.array(scheduleItem).max(200).default([]),
    crews: z.array(crewItem).max(20).default([]),
    skills: z.array(skillItem).max(200).default([]),
  })
  .strict();
export type Bundle = z.output<typeof bundleSchema>;
export type Parts = { schedules: boolean; crews: boolean; skills: boolean };

/** The file: schedules, the active version of each crew that has one, and the skills (built-in ones only when edited). */
export async function exportBundle(parts: Parts, source: string, db?: Db): Promise<Bundle> {
  const [schedules, crews, skills] = await Promise.all([parts.schedules ? listSchedules(db) : [], parts.crews ? activeVersions(db) : [], parts.skills ? listSkills(db) : []]);
  return {
    kind: BUNDLE_KIND,
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    source,
    schedules: schedules.map(exportable),
    crews: crews.map((v) => ({ crew: v.crew, version: v.version, note: v.note, config: v.config, baseHash: v.baseHash, promptVersion: v.promptVersion })),
    skills: skills.filter((s) => !s.builtin || s.edited || !s.enabled).map((s) => ({ name: s.name, description: s.description, instructions: s.instructions, agents: s.agents, tags: s.tags, enabled: s.enabled })),
  };
}

// --- import ------------------------------------------------------------------------------------------------------------

export type ItemPlan = { key: string; action: "create" | "update" | "unchanged" | "error"; changes: string[]; error?: string };
export type ImportPlan = { schedules: ItemPlan[]; crews: (ItemPlan & { config?: Record<string, unknown>; baseHash?: string; promptVersion?: string })[]; skills: ItemPlan[]; warnings: string[] };

/** What import needs from the SEO agent (lib/seo-agent/client.ts); a function that throws means "not reachable". */
export type AgentChecks = {
  crew: (crew: string, config: Record<string, unknown>) => Promise<{ config: Record<string, unknown>; default_hash: string; prompt_version: string }>;
  inputs: (flow: string, inputs: Record<string, unknown>) => Promise<{ inputs: Record<string, unknown> }>;
};

/** JSON with sorted keys, to compare configurations and inputs. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const reason = (e: unknown) => {
  const err = e as { message?: unknown; issues?: unknown; status?: unknown };
  const issues = Array.isArray(err.issues) && err.issues.length ? `: ${err.issues.slice(0, 5).join("; ")}` : "";
  return `${String(err.message ?? e)}${issues}`.slice(0, 600);
};
const unreachable = (e: unknown) => {
  const s = (e as { status?: unknown }).status;
  return typeof s !== "number" || s >= 500;
};

export async function planImport(b: Bundle, agent: AgentChecks, db?: Db): Promise<ImportPlan> {
  const warnings: string[] = [];
  const plan: ImportPlan = { schedules: [], crews: [], skills: [], warnings };
  const seen = (list: { name?: string; crew?: string }[], label: string) => {
    const keys = list.map((x) => x.name ?? x.crew ?? "");
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dup.length) throw Object.assign(new Error(`The file names the same ${label} twice: ${[...new Set(dup)].join(", ")}.`), { status: 400 });
  };
  seen(b.schedules, "schedule");
  seen(b.crews, "crew");
  seen(b.skills, "skill");

  const current = new Map((await listSchedules(db)).map((s) => [s.name, s]));
  let agentDown = false;
  for (const raw of b.schedules) {
    const p: ItemPlan = { key: raw.name, action: "unchanged", changes: [] };
    plan.schedules.push(p);
    const v = scheduleInput.safeParse(raw);
    if (!v.success) {
      Object.assign(p, { action: "error", error: v.error.issues.map((i) => `${i.path.join(".") || "schedule"}: ${i.message}`).join("; ") });
      continue;
    }
    if (!agentDown) {
      try {
        await agent.inputs(v.data.flow, v.data.inputs);
      } catch (e) {
        if (unreachable(e)) {
          agentDown = true;
          warnings.push("The SEO agent did not answer, so schedule inputs were not checked; the dispatcher checks them at every start.");
        } else {
          Object.assign(p, { action: "error", error: `inputs: ${reason(e)}` });
          continue;
        }
      }
    }
    const cur = current.get(v.data.name);
    if (!cur) {
      Object.assign(p, { action: "create", changes: [`${v.data.flow} · ${v.data.cron} (${v.data.timezone})${v.data.enabled ? "" : " · paused"}`] });
      continue;
    }
    if (cur.flow !== v.data.flow) {
      Object.assign(p, { action: "error", error: `this site's ${cur.name} runs ${cur.flow}, the file's runs ${v.data.flow}: rename one of them` });
      continue;
    }
    if (cur.cron !== v.data.cron) p.changes.push(`time: ${cur.cron} → ${v.data.cron}`);
    if (cur.timezone !== v.data.timezone) p.changes.push(`time zone: ${cur.timezone} → ${v.data.timezone}`);
    if (stable(cur.inputs) !== stable(v.data.inputs)) p.changes.push("inputs");
    if (cur.enabled !== v.data.enabled) p.changes.push(v.data.enabled ? "resumed" : "paused");
    if (cur.description !== v.data.description) p.changes.push("description");
    if (p.changes.length) p.action = "update";
  }

  const active = new Map((await activeVersions(db)).map((v) => [v.crew, v]));
  for (const c of b.crews) {
    const p: ImportPlan["crews"][number] = { key: c.crew, action: "unchanged", changes: [] };
    plan.crews.push(p);
    try {
      const ok = await agent.crew(c.crew, c.config);
      Object.assign(p, { config: ok.config, baseHash: ok.default_hash, promptVersion: ok.prompt_version });
      if (c.baseHash && c.baseHash !== ok.default_hash) p.changes.push("written for other code defaults (another agent version): check it before relying on it");
      const cur = active.get(c.crew);
      if (cur && stable(cur.config) === stable(ok.config)) continue;
      if (!cur && Object.keys(ok.config).length === 0) continue; // the code's defaults, which this site already uses
      p.action = "create";
      p.changes.unshift(cur ? `new version after v${cur.version}` : "first version (the site uses the code's defaults now)");
    } catch (e) {
      Object.assign(p, { action: "error", error: unreachable(e) ? "the SEO agent must answer to check a crew's configuration; try again when it is online" : reason(e) });
    }
  }

  const skills = new Map((await listSkills(db)).map((s) => [s.name, s]));
  for (const s of b.skills) {
    const p: ItemPlan = { key: s.name, action: "unchanged", changes: [] };
    plan.skills.push(p);
    const cur = skills.get(s.name);
    if (!cur) {
      Object.assign(p, { action: "create", changes: [`for ${s.agents.join(", ")}`] });
      continue;
    }
    for (const f of ["description", "instructions", "enabled"] as const) if (stable(cur[f]) !== stable(s[f])) p.changes.push(f);
    if (stable([...cur.agents].sort()) !== stable([...s.agents].sort())) p.changes.push("agents");
    if (stable([...cur.tags].sort()) !== stable([...s.tags].sort())) p.changes.push("tags");
    if (p.changes.length) p.action = "update";
  }
  return plan;
}

export type ImportResult = { plan: ImportPlan; applied: { schedules: number; crews: number; skills: number }; failed: { part: string; key: string; error: string }[] };

/** Apply a freshly computed plan: only `create` and `update` items; each one on its own, so one failure stops nothing else. */
export async function applyImport(b: Bundle, plan: ImportPlan, opts: { activate: boolean }, actor: Actor, db?: Db): Promise<ImportResult> {
  const applied = { schedules: 0, crews: 0, skills: 0 };
  const failed: ImportResult["failed"] = [];
  const by = <T extends { key: string }>(list: T[]) => new Map(list.map((p) => [p.key, p]));
  const sp = by(plan.schedules);
  const current = new Map((await listSchedules(db)).map((s) => [s.name, s]));
  for (const raw of b.schedules) {
    const p = sp.get(raw.name);
    if (!p || (p.action !== "create" && p.action !== "update")) continue;
    try {
      const v = scheduleInput.parse(raw);
      if (p.action === "create") await createSchedule(v, actor.label, db);
      else await updateSchedule(current.get(v.name)!.id, { description: v.description, cron: v.cron, timezone: v.timezone, inputs: v.inputs, enabled: v.enabled }, actor.label, db);
      applied.schedules++;
    } catch (e) {
      failed.push({ part: "schedule", key: raw.name, error: reason(e) });
    }
  }
  for (const p of plan.crews) {
    if (p.action !== "create" || !p.config) continue;
    const item = b.crews.find((c) => c.crew === p.key)!;
    try {
      const note = [`Imported${item.version ? ` (v${item.version} in the file)` : ""}`, item.note].filter(Boolean).join(": ");
      await saveVersion({ crew: p.key, config: p.config, note, source: "import", baseHash: p.baseHash ?? null, promptVersion: p.promptVersion ?? null, activate: opts.activate, actor: actor.label }, db);
      applied.crews++;
    } catch (e) {
      failed.push({ part: "crew", key: p.key, error: reason(e) });
    }
  }
  const kp = by(plan.skills);
  const skills = new Map((await listSkills(db)).map((s) => [s.name, s]));
  for (const s of b.skills) {
    const p = kp.get(s.name);
    if (!p || (p.action !== "create" && p.action !== "update")) continue;
    try {
      if (p.action === "create") await createSkill(actor, s, db);
      else await updateSkill(actor, skills.get(s.name)!.id, { description: s.description, instructions: s.instructions, agents: s.agents, tags: s.tags, enabled: s.enabled }, db);
      applied.skills++;
    } catch (e) {
      failed.push({ part: "skill", key: s.name, error: reason(e) });
    }
  }
  return { plan, applied, failed };
}
