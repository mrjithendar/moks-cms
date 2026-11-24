import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { configChecksum, itemChecksums } from "./files";
import { KINDS, type CrewConfig, type Kind } from "./model";
import { exportRuntime, type AgentSide, type ExportReport } from "./runtime";

/**
 * The history of configuration imports and exports (crewai_config_syncs, migration 0042) and what it tells the console:
 * which Git revision the site's configuration came from, whether it changed here since (drift), and how the last
 * import went.
 */

export type SyncSource = "admin" | "repository" | "deploy" | "api" | "rollback";
export type SyncRecord = {
  id: string;
  direction: "import" | "export";
  mode: "dry_run" | "apply";
  source: SyncSource;
  status: "planned" | "applied" | "unchanged" | "failed" | "refused";
  policy: string | null;
  revision: string | null;
  ref: string | null;
  url: string | null;
  bundleChecksum: string | null;
  runtimeChecksum: string | null;
  summary: Record<string, unknown>;
  error: string | null;
  actor: string | null;
  createdAt: string;
  finishedAt: string | null;
  hasSnapshot: boolean;
};

const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : {});

function toRecord(r: Record<string, unknown>): SyncRecord {
  return {
    id: String(r.id),
    direction: r.direction as SyncRecord["direction"],
    mode: r.mode as SyncRecord["mode"],
    source: r.source as SyncSource,
    status: r.status as SyncRecord["status"],
    policy: (r.policy as string | null) ?? null,
    revision: (r.revision as string | null) ?? null,
    ref: (r.ref as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    bundleChecksum: (r.bundle_checksum as string | null) ?? null,
    runtimeChecksum: (r.runtime_checksum as string | null) ?? null,
    summary: obj(r.summary),
    error: (r.error as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    finishedAt: iso(r.finished_at),
    hasSnapshot: Boolean(r.has_snapshot),
  };
}

const COLS = sql.raw("id, direction, mode, source, status, policy, revision, ref, url, bundle_checksum, runtime_checksum, summary, error, actor, created_at, finished_at, snapshot is not null as has_snapshot");

export type NewRecord = Omit<SyncRecord, "id" | "createdAt" | "finishedAt" | "hasSnapshot"> & { plan?: unknown; baseline?: Record<string, string> | null; snapshot?: CrewConfig | null };

export async function recordSync(r: NewRecord, db?: Db): Promise<string> {
  const d = db ?? (await getDb());
  const [row] = rowsOf<{ id: string }>(
    await d.execute(sql`insert into crewai_config_syncs (direction, mode, source, status, policy, revision, ref, url, bundle_checksum, runtime_checksum, summary, plan, error, baseline, snapshot, actor, finished_at)
      values (${r.direction}, ${r.mode}, ${r.source}, ${r.status}, ${r.policy}, ${r.revision}, ${r.ref?.slice(0, 200) ?? null}, ${r.url?.slice(0, 500) ?? null}, ${r.bundleChecksum}, ${r.runtimeChecksum},
        ${JSON.stringify(r.summary)}::jsonb, ${r.plan === undefined ? null : JSON.stringify(r.plan)}::jsonb, ${r.error?.slice(0, 4000) ?? null}, ${r.baseline ? JSON.stringify(r.baseline) : null}::jsonb,
        ${r.snapshot ? JSON.stringify(r.snapshot) : null}::jsonb, ${r.actor}, now()) returning id`),
  );
  return row!.id;
}

/** True once migration 0042 is applied (the web app applies it when it starts). */
export async function hasSyncTable(db?: Db): Promise<boolean> {
  const d = db ?? (await getDb());
  const [r] = rowsOf<{ ok: boolean }>(await d.execute(sql`select to_regclass('public.crewai_config_syncs') is not null as ok`));
  return Boolean(r?.ok);
}

export async function listSyncs(limit = 50, db?: Db): Promise<SyncRecord[]> {
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(await d.execute(sql`select ${COLS} from crewai_config_syncs order by created_at desc limit ${Math.min(200, Math.max(1, limit))}`)).map(toRecord);
}

export async function getSync(id: string, db?: Db): Promise<(SyncRecord & { plan: unknown; snapshot: CrewConfig | null }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select ${COLS}, plan, snapshot from crewai_config_syncs where id = ${id}::uuid`));
  return r ? { ...toRecord(r), plan: r.plan == null ? null : obj(r.plan), snapshot: r.snapshot == null ? null : (obj(r.snapshot) as unknown as CrewConfig) } : null;
}

/** The checksums of the last sync that applied something or exported to the repository: what "changed here" means. */
export async function baseline(db?: Db): Promise<{ record: SyncRecord; items: Record<string, string> } | null> {
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select ${COLS}, baseline from crewai_config_syncs where baseline is not null order by created_at desc limit 1`));
  return r ? { record: toRecord(r), items: obj(r.baseline) as Record<string, string> } : null;
}

export type Drift = { changed: string[]; added: string[]; removed: string[] };

/** What differs between the configuration now and a baseline (by "kind:id"). */
export function driftOf(now: Record<string, string>, base: Record<string, string>): Drift {
  const changed = Object.keys(now).filter((k) => k in base && base[k] !== now[k]);
  const added = Object.keys(now).filter((k) => !(k in base));
  const removed = Object.keys(base).filter((k) => !(k in now));
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

export type SyncStatus = {
  ready: boolean;
  version: string;
  counts: Record<Kind, number>;
  complete: boolean;
  report: Pick<ExportReport, "unsupported" | "skipped" | "redacted" | "warnings" | "agent">;
  lastSync: SyncRecord | null;
  lastImport: SyncRecord | null;
  baseline: { revision: string | null; at: string; source: SyncSource; direction: SyncRecord["direction"] } | null;
  drift: (Drift & { state: "in_sync" | "drifted" | "never_synced" }) | null;
  checkedAt: string;
};

let cached: { at: number; status: SyncStatus } | null = null;
const TTL_MS = 30_000;

/** The configuration as it runs now and how it relates to the last sync. Cached briefly (pages poll it). */
export async function syncStatus(opts: { fresh?: boolean; db?: Db; agent?: AgentSide } = {}): Promise<SyncStatus> {
  if (!opts.fresh && !opts.db && cached && Date.now() - cached.at < TTL_MS) return cached.status;
  const d = opts.db ?? (await getDb());
  const ready = await hasSyncTable(d);
  const runtime = await exportRuntime({ db: d, agent: opts.agent, sync: false });
  const sums = itemChecksums(runtime.config);
  const [syncs, base] = ready ? await Promise.all([listSyncs(20, d), baseline(d)]) : [[], null];
  const lastSync = syncs[0] ?? null;
  const lastImport = syncs.find((s) => s.direction === "import" && s.mode === "apply") ?? null;
  let drift: SyncStatus["drift"] = null;
  if (base) {
    const dr = driftOf(sums, base.items);
    drift = { ...dr, state: dr.changed.length + dr.added.length + dr.removed.length ? "drifted" : "in_sync" };
  } else if (ready) drift = { changed: [], added: Object.keys(sums).sort(), removed: [], state: "never_synced" };
  const status: SyncStatus = {
    ready,
    version: configChecksum(runtime.config),
    counts: Object.fromEntries(KINDS.map((k) => [k.kind, (runtime.config[k.kind] as unknown[]).length])) as Record<Kind, number>,
    complete: runtime.report.complete,
    report: { unsupported: runtime.report.unsupported, skipped: runtime.report.skipped, redacted: runtime.report.redacted, warnings: runtime.report.warnings, agent: runtime.report.agent },
    lastSync,
    lastImport,
    baseline: base ? { revision: base.record.revision, at: base.record.createdAt, source: base.record.source, direction: base.record.direction } : null,
    drift,
    checkedAt: new Date().toISOString(),
  };
  if (!opts.db) cached = { at: Date.now(), status };
  return status;
}

export function forgetStatus() {
  cached = null;
}
