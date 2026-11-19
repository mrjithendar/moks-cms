import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { cronError, nextFire } from "../news/cron";
import { SCHEDULABLE_FLOWS } from "./flows";

/**
 * Flow schedules (CrewAI console → Schedules, D-98): when each SEO agent flow runs, stored in seo_flow_schedules
 * (migration 0037) instead of one Kubernetes CronJob per flow. The seo-agent's dispatcher (moks-seo-agent
 * app/schedules.py) is called every minute by one CronJob and starts each schedule that is due; it writes only the
 * last_* columns. This file is everything else: list, create, edit, pause, delete, reset, and the export/import rows.
 *
 * - Times are a 5-field cron in an IANA time zone, checked with the same rules as the dispatcher (lib/news/cron.ts).
 * - Changing the cron, time zone or switch moves `armed_at` to now: the dispatcher never fires a time at or before it,
 *   so a new or edited schedule does not run at once for a time that has already passed.
 * - The inputs are checked by the agent against the flow's input model when it can be reached (the API route does
 *   that); the dispatcher checks them again at every start and records a refusal on the row.
 * - Built-in schedules (the fifteen CronJobs they replace) can be edited, paused and reset, not deleted.
 */

export const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type Schedule = {
  id: string;
  name: string;
  flow: string;
  description: string;
  cron: string;
  timezone: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
  builtin: boolean;
  defaults: { cron: string; timezone: string; inputs: Record<string, unknown> } | null;
  armedAt: string;
  last: { slot: string | null; firedAt: string | null; status: string | null; runId: string | null; error: string | null };
  nextAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const obj = (v: unknown): Record<string, unknown> => {
  const x = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
};

function next(cron: string, tz: string, enabled: boolean, now: Date): string | null {
  if (!enabled) return null;
  try {
    return nextFire(cron, tz, now)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

function toSchedule(r: Record<string, unknown>, now = new Date()): Schedule {
  const enabled = Boolean(r.enabled);
  return {
    id: String(r.id),
    name: String(r.name),
    flow: String(r.flow_name),
    description: String(r.description ?? ""),
    cron: String(r.cron),
    timezone: String(r.timezone),
    inputs: obj(r.inputs),
    enabled,
    builtin: Boolean(r.builtin),
    defaults: r.builtin && r.default_cron ? { cron: String(r.default_cron), timezone: String(r.default_timezone ?? "Etc/UTC"), inputs: obj(r.default_inputs) } : null,
    armedAt: iso(r.armed_at)!,
    last: { slot: r.last_slot ? String(r.last_slot) : null, firedAt: iso(r.last_fired_at), status: r.last_status ? String(r.last_status) : null, runId: r.last_run_id ? String(r.last_run_id) : null, error: r.last_error ? String(r.last_error) : null },
    nextAt: next(String(r.cron), String(r.timezone), enabled, now),
    updatedAt: iso(r.updated_at)!,
    updatedBy: r.updated_by ? String(r.updated_by) : null,
  };
}

/** Migration 0037 applied? The pages say so instead of failing. */
export async function hasSchedules(db?: Db): Promise<boolean> {
  const d = db ?? (await getDb());
  const [r] = rowsOf<{ n: number }>(await d.execute(sql`select count(*)::int as n from information_schema.tables where table_name in ('seo_flow_schedules', 'seo_crew_configs') and table_schema = any(current_schemas(false))`));
  return Number(r?.n ?? 0) === 2;
}

export async function listSchedules(db?: Db, now = new Date()): Promise<Schedule[]> {
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(await d.execute(sql`select * from seo_flow_schedules order by flow_name, name`)).map((r) => toSchedule(r, now));
}

export async function getSchedule(id: string, db?: Db): Promise<Schedule | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select * from seo_flow_schedules where id = ${id}::uuid`));
  return r ? toSchedule(r) : null;
}

export async function scheduleByName(name: string, db?: Db): Promise<Schedule | null> {
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select * from seo_flow_schedules where name = ${name}`));
  return r ? toSchedule(r) : null;
}

// --- writes ------------------------------------------------------------------------------------------------------------

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

const inputsSchema = z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 10_000, "at most 10,000 characters of JSON");

export const scheduleInput = z
  .object({
    name: z.string().trim().min(1).max(64).regex(NAME, "lower-case letters, digits and single hyphens"),
    flow: z.string().refine((f) => SCHEDULABLE_FLOWS.includes(f), "a schedule cannot start this flow"),
    description: z.string().trim().max(300).default(""),
    cron: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(64).default("Etc/UTC"),
    inputs: inputsSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    const err = cronError(v.cron, v.timezone);
    if (err) ctx.addIssue({ code: "custom", path: ["cron"], message: err });
  });
export type ScheduleInput = z.output<typeof scheduleInput>;

export const schedulePatch = z
  .object({
    description: z.string().trim().max(300).optional(),
    cron: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    inputs: inputsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type SchedulePatch = z.output<typeof schedulePatch>;

/** A unique violation, also when Drizzle wraps the driver's error (as lib/posts.ts uniqueViolation). */
function unique(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

export async function createSchedule(v: ScheduleInput, actor: string, db?: Db): Promise<Schedule> {
  const d = db ?? (await getDb());
  try {
    const [r] = rowsOf<Record<string, unknown>>(
      await d.execute(sql`insert into seo_flow_schedules (name, flow_name, description, cron, timezone, inputs, enabled, updated_by)
        values (${v.name}, ${v.flow}, ${v.description}, ${v.cron}, ${v.timezone}, ${JSON.stringify(v.inputs)}::jsonb, ${v.enabled}, ${actor}) returning *`),
    );
    return toSchedule(r!);
  } catch (e) {
    if (unique(e)) throw new ScheduleError(`A schedule named ${v.name} already exists.`, 409);
    throw e;
  }
}

/** Edit a schedule. A change of cron, time zone or switch re-arms it (armed_at = now): no past time fires. */
export async function updateSchedule(id: string, p: SchedulePatch, actor: string, db?: Db): Promise<Schedule> {
  const d = db ?? (await getDb());
  const cur = await getSchedule(id, d);
  if (!cur) throw new ScheduleError("Schedule not found.", 404);
  const cron = p.cron ?? cur.cron;
  const timezone = p.timezone ?? cur.timezone;
  const err = cronError(cron, timezone);
  if (err) throw new ScheduleError("The schedule is not valid.", 400, [`cron: ${err}`]);
  const enabled = p.enabled ?? cur.enabled;
  const rearm = cron !== cur.cron || timezone !== cur.timezone || enabled !== cur.enabled;
  const [r] = rowsOf<Record<string, unknown>>(
    await d.execute(sql`update seo_flow_schedules set description = ${p.description ?? cur.description}, cron = ${cron}, timezone = ${timezone},
      inputs = ${JSON.stringify(p.inputs ?? cur.inputs)}::jsonb, enabled = ${enabled}, armed_at = case when ${rearm} then now() else armed_at end,
      updated_at = now(), updated_by = ${actor} where id = ${id}::uuid returning *`),
  );
  return toSchedule(r!);
}

/** A built-in schedule back to the time, zone and inputs it shipped with (still paused if it was). */
export async function resetSchedule(id: string, actor: string, db?: Db): Promise<Schedule> {
  const cur = await getSchedule(id, db);
  if (!cur) throw new ScheduleError("Schedule not found.", 404);
  if (!cur.defaults) throw new ScheduleError("Only a built-in schedule has defaults to reset to.", 409);
  return updateSchedule(id, { cron: cur.defaults.cron, timezone: cur.defaults.timezone, inputs: cur.defaults.inputs }, actor, db);
}

export async function deleteSchedule(id: string, db?: Db): Promise<Schedule> {
  const d = db ?? (await getDb());
  const cur = await getSchedule(id, d);
  if (!cur) throw new ScheduleError("Schedule not found.", 404);
  if (cur.builtin) throw new ScheduleError("A built-in schedule cannot be deleted: pause it instead.", 409);
  await d.execute(sql`delete from seo_flow_schedules where id = ${id}::uuid`);
  return cur;
}

// --- a readable cron ---------------------------------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: string) => n.padStart(2, "0");

/** Plain words for the common shapes ("Mondays at 07:00", "every 15 minutes"); the cron itself otherwise. */
export function describeCron(expr: string): string {
  const e = expr.trim();
  const p = e.split(/\s+/);
  if (p.length !== 5) return e;
  const [mi, h, dom, mon, dow] = p as [string, string, string, string, string];
  const step = /^\*\/(\d+)$/.exec(mi);
  if (step && h === "*" && dom === "*" && mon === "*" && dow === "*") return step[1] === "1" ? "every minute" : `every ${step[1]} minutes`;
  if (mi === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "every minute";
  if (!/^\d+$/.test(mi)) return e;
  if (h === "*" && dom === "*" && mon === "*" && dow === "*") return `every hour at :${pad(mi)}`;
  if (!/^\d+$/.test(h)) return e;
  const at = `${pad(h)}:${pad(mi)}`;
  if (dom === "*" && mon === "*" && dow === "*") return `daily at ${at}`;
  if (dom === "*" && mon === "*" && /^[0-7]$/.test(dow)) return `${WEEKDAYS[Number(dow) % 7]}s at ${at}`;
  if (dom === "*" && mon === "*" && dow === "1-5") return `weekdays at ${at}`;
  if (/^\d+$/.test(dom) && mon === "*" && dow === "*") {
    const n = Number(dom);
    const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
    return `monthly on the ${n}${suffix} at ${at}`;
  }
  return e;
}

/** For export: the fields that define a schedule (no ids, run state or timestamps). */
export function exportable(s: Schedule) {
  return { name: s.name, flow: s.flow, description: s.description, cron: s.cron, timezone: s.timezone, inputs: s.inputs, enabled: s.enabled };
}
