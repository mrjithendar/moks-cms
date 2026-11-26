import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";

/**
 * Crew configuration versions (CrewAI console → Crews, D-98): seo_crew_configs (migration 0037).
 *
 * A version is an overlay on the crew's code defaults (seo-agent/app/crews/config.py): only what differs, already
 * normalised by the agent (POST /crews/{crew}/validate) before it is saved here. Versions are never edited: saving
 * makes version N+1. At most one version per crew is active; the agent reads the active ones before every crew run
 * (callback GET /internal/seo-agent/crew-configs, crewConfigsCallback). "Use the code's defaults" deactivates them all.
 */

export const CREW_ID = /^[a-z][a-z0-9_]{1,39}$/;

export type CrewVersion = {
  id: string;
  crew: string;
  version: number;
  config: Record<string, unknown>;
  note: string;
  source: "editor" | "import" | "test";
  baseHash: string | null;
  promptVersion: string | null;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
};

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const obj = (v: unknown): Record<string, unknown> => {
  const x = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
};

function toVersion(r: Record<string, unknown>): CrewVersion {
  return {
    id: String(r.id),
    crew: String(r.crew),
    version: Number(r.version),
    config: obj(r.config),
    note: String(r.note ?? ""),
    source: (["editor", "import", "test"].includes(String(r.source)) ? String(r.source) : "editor") as CrewVersion["source"],
    baseHash: r.base_hash ? String(r.base_hash) : null,
    promptVersion: r.prompt_version ? String(r.prompt_version) : null,
    active: Boolean(r.active),
    createdAt: iso(r.created_at)!,
    createdBy: r.created_by ? String(r.created_by) : null,
    activatedAt: iso(r.activated_at),
    activatedBy: r.activated_by ? String(r.activated_by) : null,
  };
}

export async function listVersions(crew: string, db?: Db): Promise<CrewVersion[]> {
  if (!CREW_ID.test(crew)) return [];
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(await d.execute(sql`select * from seo_crew_configs where crew = ${crew} order by version desc limit 200`)).map(toVersion);
}

export async function getVersion(crew: string, version: number, db?: Db): Promise<CrewVersion | null> {
  if (!CREW_ID.test(crew) || !Number.isInteger(version)) return null;
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select * from seo_crew_configs where crew = ${crew} and version = ${version}`));
  return r ? toVersion(r) : null;
}

/** The active version of each crew that has one. */
export async function activeVersions(db?: Db): Promise<CrewVersion[]> {
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(await d.execute(sql`select * from seo_crew_configs where active order by crew`)).map(toVersion);
}

/** Per crew: how many versions, and which one is active (the Crews list). */
export async function crewSummaries(db?: Db): Promise<Map<string, { versions: number; active: CrewVersion | null; latest: number }>> {
  const d = db ?? (await getDb());
  const rows = rowsOf<{ crew: string; n: number; latest: number }>(await d.execute(sql`select crew, count(*)::int as n, max(version)::int as latest from seo_crew_configs group by crew`));
  const active = new Map((await activeVersions(d)).map((v) => [v.crew, v]));
  return new Map(rows.map((r) => [r.crew, { versions: Number(r.n), latest: Number(r.latest), active: active.get(r.crew) ?? null }]));
}

export type SaveVersion = { crew: string; config: Record<string, unknown>; note: string; source: CrewVersion["source"]; baseHash: string | null; promptVersion: string | null; activate: boolean; actor: string };

/** Insert version N+1 (and make it the active one when asked), in one transaction. */
export async function saveVersion(v: SaveVersion, db?: Db): Promise<CrewVersion> {
  if (!CREW_ID.test(v.crew)) throw new Error("bad crew id");
  const d = db ?? (await getDb());
  return d.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seo_crew_configs:${v.crew}`}, 0))`);
    const [n] = rowsOf<{ next: number }>(await tx.execute(sql`select coalesce(max(version), 0)::int + 1 as next from seo_crew_configs where crew = ${v.crew}`));
    if (v.activate) await tx.execute(sql`update seo_crew_configs set active = false where crew = ${v.crew} and active`);
    const [r] = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`insert into seo_crew_configs (crew, version, config, note, source, base_hash, prompt_version, active, created_by, activated_at, activated_by)
        values (${v.crew}, ${Number(n?.next ?? 1)}, ${JSON.stringify(v.config)}::jsonb, ${v.note.slice(0, 500)}, ${v.source}, ${v.baseHash}, ${v.promptVersion}, ${v.activate},
          ${v.actor}, ${v.activate ? sql`now()` : null}, ${v.activate ? v.actor : null}) returning *`),
    );
    return toVersion(r!);
  });
}

/** Make `version` the active one (a rollback is activating an older version). null: back to the code's defaults. */
export async function activateVersion(crew: string, version: number | null, actor: string, db?: Db): Promise<CrewVersion | null> {
  if (!CREW_ID.test(crew)) throw new Error("bad crew id");
  const d = db ?? (await getDb());
  return d.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seo_crew_configs:${crew}`}, 0))`);
    if (version != null) {
      const [exists] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from seo_crew_configs where crew = ${crew} and version = ${version}`));
      if (!Number(exists?.n)) return null;
    }
    await tx.execute(sql`update seo_crew_configs set active = false where crew = ${crew} and active`);
    if (version == null) return null;
    const [r] = rowsOf<Record<string, unknown>>(await tx.execute(sql`update seo_crew_configs set active = true, activated_at = now(), activated_by = ${actor} where crew = ${crew} and version = ${version} returning *`));
    return r ? toVersion(r) : null;
  });
}

/** Callback GET /internal/seo-agent/crew-configs: the active versions the crews apply (moks-seo-agent crews/config.py). */
export async function crewConfigsCallback(): Promise<{ crews: { crew: string; version: number; config: Record<string, unknown> }[] }> {
  try {
    return { crews: (await activeVersions()).map((v) => ({ crew: v.crew, version: v.version, config: v.config })) };
  } catch (e) {
    // Migration 0037 not applied yet: no versions, so the crews use the code's defaults.
    if (/seo_crew_configs/.test(String((e as Error)?.message ?? ""))) return { crews: [] };
    throw e;
  }
}
