import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/posts";
import { AgentError, validateCustomSpec, type AgentDeps } from "@/lib/seo-agent/client";
import { SeoApiError } from "@/lib/seo-intel/http";

/**
 * Custom crews and custom flows made in the admin (crew-jobs plan PR 6; admin-settings plan P4), migration 0039.
 * The seo-agent owns what a spec may contain and checks it before every save (POST /custom/validate) and before every
 * run, so nothing saved here can widen what an agent may do: tools from its allowlist only, no publishing step. This
 * file stores the specs, serves the enabled ones to the agent (GET /internal/seo-agent/custom-crews|flows) and turns a
 * custom flow's draft step into a draft in the review queue (POST /internal/seo-agent/custom/drafts).
 */
export type CustomKind = "crew" | "flow";
export type CustomRow = { key: string; label: string; spec: Record<string, unknown>; version: number; enabled: boolean; updated_at: string; updated_by: string | null };

const TABLE = { crew: sql.raw('"seo_custom_crews"'), flow: sql.raw('"seo_custom_flows"') } as const;
const KEY = /^[a-z][a-z0-9_]{1,39}$/;

export class CustomError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

const asObject = (v: unknown): Record<string, unknown> => (typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>));
const row = (r: Record<string, unknown>): CustomRow => ({ key: String(r.key), label: String(r.label), spec: asObject(r.spec), version: Number(r.version), enabled: Boolean(r.enabled), updated_at: String(r.updated_at), updated_by: (r.updated_by as string | null) ?? null });

/** Every saved custom crew or flow (not deleted), enabled or not. */
export async function listCustom(kind: CustomKind, db?: Db): Promise<CustomRow[]> {
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(await d.execute(sql`select key, label, spec, version, enabled, updated_at::text, updated_by from ${TABLE[kind]} where deleted_at is null order by label, key`)).map(row);
}

export async function getCustom(kind: CustomKind, key: string, db?: Db): Promise<CustomRow | null> {
  if (!KEY.test(key)) return null;
  return (await listCustom(kind, db)).find((r) => r.key === key) ?? null;
}

/** What the agent runs: the enabled specs ({key, version, spec}). */
export async function servedCustom(kind: CustomKind) {
  return { items: (await listCustom(kind)).filter((r) => r.enabled).map((r) => ({ key: r.key, version: r.version, spec: r.spec })) };
}

/**
 * Save a custom crew or flow: the agent checks it first (a flow against the custom crews that exist and are on), then
 * it is stored as the next version. A new key that another (even deleted) spec has is refused: run history names it.
 */
export async function saveCustom(kind: CustomKind, actor: Actor, raw: unknown, deps: AgentDeps = {}): Promise<CustomRow> {
  const spec = asObject(raw);
  const key = String(spec.key ?? "");
  if (!KEY.test(key)) throw new CustomError("The key is 2–40 lower-case letters, digits or _ and starts with a letter.", 400);
  const db = await getDb();
  const crews = kind === "flow" ? (await listCustom("crew", db)).filter((c) => c.enabled).map((c) => c.key) : undefined;
  let checked: Record<string, unknown>;
  try {
    checked = (await validateCustomSpec(kind, spec, crews, deps)).spec;
  } catch (e) {
    if (e instanceof AgentError && e.status === 422) throw new CustomError("The SEO agent refused this spec.", 422, e.issues);
    if (e instanceof AgentError) throw new CustomError(`${e.message} A custom ${kind} is checked by the SEO agent before it is saved.`, 503);
    throw e;
  }
  const label = String(checked.label ?? key).slice(0, 120);
  const [existing] = rowsOf<{ version: number; deleted: boolean }>(await db.execute(sql`select version, deleted_at is not null as deleted from ${TABLE[kind]} where key = ${key}`));
  if (existing?.deleted) throw new CustomError(`A deleted custom ${kind} used the key ${key}; pick another (its run history keeps the name).`, 409);
  await db.execute(sql`
    insert into ${TABLE[kind]} (key, label, spec, version, updated_by) values (${key}, ${label}, ${JSON.stringify(checked)}::jsonb, 1, ${actor.label})
    on conflict (key) do update set label = excluded.label, spec = excluded.spec, version = ${TABLE[kind]}.version + 1, updated_at = now(), updated_by = excluded.updated_by`);
  await audit(actor, `crewai.custom_${kind}.save`, key, { version: (existing?.version ?? 0) + 1 });
  return (await getCustom(kind, key, db))!;
}

/** Switch a custom crew or flow on or off. A crew still used by an enabled flow cannot be switched off. */
export async function setCustomEnabled(kind: CustomKind, actor: Actor, key: string, enabled: boolean): Promise<CustomRow> {
  const db = await getDb();
  const cur = await getCustom(kind, key, db);
  if (!cur) throw new CustomError(`No custom ${kind} ${key}.`, 404);
  if (kind === "crew" && !enabled) {
    const users = usedBy(key, await listCustom("flow", db)).filter((f) => f.enabled);
    if (users.length) throw new CustomError(`Used by ${users.map((f) => f.label).join(", ")}: switch those flows off first.`, 409);
  }
  await db.execute(sql`update ${TABLE[kind]} set enabled = ${enabled}, updated_at = now(), updated_by = ${actor.label} where key = ${key}`);
  await audit(actor, `crewai.custom_${kind}.${enabled ? "enable" : "disable"}`, key, {});
  return (await getCustom(kind, key, db))!;
}

/** The flows whose crew steps name this custom crew. */
export function usedBy(crewKey: string, flows: CustomRow[]): CustomRow[] {
  return flows.filter((f) => ((f.spec.steps as { kind?: string; crew?: string }[] | undefined) ?? []).some((s) => s.kind === "crew" && s.crew === crewKey));
}

/**
 * Delete (keeps the row for run history). A crew used by any flow is refused; a flow's schedules are removed, so
 * nothing starts it again.
 */
export async function deleteCustom(kind: CustomKind, actor: Actor, key: string): Promise<{ schedulesRemoved: number }> {
  const db = await getDb();
  const cur = await getCustom(kind, key, db);
  if (!cur) throw new CustomError(`No custom ${kind} ${key}.`, 404);
  if (kind === "crew") {
    const users = usedBy(key, await listCustom("flow", db));
    if (users.length) throw new CustomError(`Used by ${users.map((f) => f.label).join(", ")}: change or delete those flows first.`, 409);
  }
  let removed = 0;
  if (kind === "flow") {
    removed = rowsOf<{ id: string }>(await db.execute(sql`delete from seo_flow_schedules where flow_name = 'custom_flow' and not builtin and inputs->>'flow' = ${key} returning id`)).length;
  }
  await db.execute(sql`update ${TABLE[kind]} set deleted_at = now(), enabled = false, updated_at = now(), updated_by = ${actor.label} where key = ${key}`);
  await audit(actor, `crewai.custom_${kind}.delete`, key, { schedulesRemoved: removed });
  return { schedulesRemoved: removed };
}

/** The kind in the address: crews or flows. */
export function kindOf(p: { kind: string }): CustomKind {
  if (p.kind === "crews") return "crew";
  if (p.kind === "flows") return "flow";
  throw new SeoApiError("Unknown kind.", 404, "not_found");
}

export function customApiError(e: unknown): never {
  if (e instanceof CustomError) throw new SeoApiError(e.message, e.status, e.status === 422 ? "invalid" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "unavailable", e.issues);
  throw e;
}
