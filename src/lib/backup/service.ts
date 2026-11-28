import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import type { BackupProgress } from "@/db/schema";
import { audit } from "../audit";
import { backupPasswords, isLegacyBackup, readBackupConfig, restoreLegacyBackup } from "../backups";
import { log } from "../log";
import type { Actor } from "../posts";
import { PostError } from "../posts";
import { withSpan } from "../trace";
import { BackupCancelled, BackupError, createBackup, type CreateResult } from "./create";
import {
  BACKUP_ROOT,
  TYPE_COMPONENTS,
  TYPE_LABEL,
  isBackupName,
  parseArchiveName,
  selectForRetention,
  sidecarName,
  type BackupType,
  type Component,
  type Manifest,
} from "./format";
import { restoreBackup, type RestoreComponents } from "./restore";
import { backupStore } from "./store";
import { verifyArchive } from "./verify";

/**
 * Site backups as operations (D-108): every backup, verification and restore is a row of backup_run and a job of the
 * Postgres job queue (lib/jobs.ts, kind "backup"), run by the backup worker loop of whichever replica claims it, never
 * in a request. One operation at a time across all replicas: the jobs share one dedupe key, so a second request while
 * one is queued or running is refused (and a scheduled one waits for the next tick). A job survives the pod that took it
 * (its lock runs out and another replica takes it over); a backup that was cut off starts again, a restore that was cut
 * off is marked failed and never restarted on its own (its transaction rolled back).
 *
 * Who asks: an admin (Admin → Backups), the built-in schedule (Settings → System → Backups), the CrewAI flow
 * backup_flow (callbacks.ts, D-108; scheduled with AI & SEO → Schedules), and a restore (its safety backup).
 */

export const BACKUP_JOB = "backup";
const DEDUPE = "backup-operation";
const SCHEDULE_LOCK_ID = 7_250_032;
const MAX_ATTEMPTS: Record<"backup" | "verify" | "restore", number> = { backup: 3, verify: 2, restore: 1 };

export type BackupRun = typeof schema.backupRun.$inferSelect;
export type Requester = { actor?: Actor; label: string; ref?: string };

export class BackupBusy extends PostError {
  constructor(readonly active: BackupRun | null) {
    super(active ? `Another backup operation is ${active.status === "pending" ? "waiting to start" : "running"} (${describeRun(active)}). Try again when it has finished.` : "Another backup operation is in progress. Try again when it has finished.", 409);
  }
}

export function describeRun(r: Pick<BackupRun, "operation" | "backupType" | "filename" | "trigger">): string {
  if (r.operation === "restore") return `restore of ${r.filename}`;
  if (r.operation === "verify") return `verification of ${r.filename}`;
  return `${TYPE_LABEL[(r.backupType ?? "full") as BackupType | "legacy"].toLowerCase()} backup${r.trigger === "scheduled" ? " (scheduled)" : r.trigger === "flow" ? " (CrewAI flow)" : ""}`;
}

/** The operation waiting or running now, if any (stale rows of a vanished pod are not "active" once their job is gone). */
export async function activeOperation(): Promise<BackupRun | null> {
  const db = await getDb();
  const [r] = await db
    .select()
    .from(schema.backupRun)
    .where(and(inArray(schema.backupRun.status, ["pending", "running"]), sql`exists (select 1 from job where job.kind = ${BACKUP_JOB} and job.status in ('queued', 'running') and job.payload->>'runId' = ${schema.backupRun.id}::text)`))
    .orderBy(desc(schema.backupRun.startedAt))
    .limit(1);
  return r ?? null;
}

/** A restore is running (other work pauses: lib/scheduler.ts). Its heartbeat keeps progress.at fresh; a dead one stops counting after 5 minutes. */
export async function restoreInProgress(): Promise<boolean> {
  const db = await getDb();
  const rows = rowsOf(
    await db.execute(sql`select 1 from backup_run where operation = 'restore' and status = 'running' and coalesce((progress->>'at')::timestamptz, started_at) > now() - interval '5 minutes' limit 1`),
  );
  return rows.length > 0;
}

/** Create the operation's row and its job in one transaction, or refuse when another operation holds the queue. */
async function enqueue(values: Omit<typeof schema.backupRun.$inferInsert, "status">): Promise<BackupRun> {
  const db = await getDb();
  const run = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SCHEDULE_LOCK_ID})`);
    const busy = rowsOf(await tx.execute(sql`select 1 from job where dedupe_key = ${DEDUPE} and status in ('queued', 'running') limit 1`));
    if (busy.length) return null;
    const [row] = await tx.insert(schema.backupRun).values({ ...values, status: "pending", startedAt: new Date() }).returning();
    const op = values.operation ?? "backup";
    await tx.execute(sql`insert into job (kind, dedupe_key, payload, run_at, max_attempts) values (${BACKUP_JOB}, ${DEDUPE}, ${JSON.stringify({ runId: row!.id })}::jsonb, now(), ${MAX_ATTEMPTS[op]})`);
    return row!;
  });
  if (!run) throw new BackupBusy(await activeOperation());
  return run;
}

async function destinationOn() {
  const c = await readBackupConfig();
  if (!c.r2?.enabled) throw new PostError("Turn on the backup destination first (Settings → System → Backups).", 409);
  return c;
}

function admin(actor?: Actor) {
  if (actor && actor.role !== "admin") throw new PostError("Only admins can manage backups.", 403);
}

// --- Requests ------------------------------------------------------------------------------------------------

export async function requestBackup(type: "full" | "database", trigger: "manual" | "scheduled" | "flow", by: Requester): Promise<BackupRun> {
  admin(by.actor);
  await destinationOn();
  const run = await enqueue({ operation: "backup", backupType: type, trigger, triggeredBy: by.label, requestedByRef: by.ref ?? null });
  if (by.actor) await audit(by.actor, "backup.request", run.id, { type, trigger });
  log.info("backup requested", { operation: "backup", runId: run.id, type, trigger });
  return run;
}

function checkName(name: string) {
  if (!isBackupName(name)) throw new PostError("Unknown backup.", 404);
}

export async function requestVerify(actor: Actor, name: string): Promise<BackupRun> {
  admin(actor);
  checkName(name);
  if (isLegacyBackup(name)) throw new PostError("Backups of the old format (content only) have no checksums to verify.", 400);
  await destinationOn();
  const run = await enqueue({ operation: "verify", backupType: parseArchiveName(name)!.type as BackupType, trigger: "manual", filename: name, triggeredBy: actor.label });
  await audit(actor, "backup.verify", name, { runId: run.id });
  return run;
}

export const RESTORE_WORD = "RESTORE";

export async function requestRestore(actor: Actor, name: string, opts: { components: RestoreComponents; allowUnsigned: boolean; confirmation: string }): Promise<BackupRun> {
  admin(actor);
  checkName(name);
  if (opts.confirmation.trim() !== RESTORE_WORD) throw new PostError(`Type ${RESTORE_WORD} to confirm the restore.`, 400);
  const legacy = isLegacyBackup(name);
  const components: RestoreComponents = legacy ? { database: true, uploads: false } : opts.components;
  if (!components.database && !components.uploads) throw new PostError("Choose what to restore: the database, the files, or both.", 400);
  await destinationOn();
  const type = parseArchiveName(name)!.type;
  const run = await enqueue({
    operation: "restore",
    backupType: type as BackupRun["backupType"],
    trigger: "manual",
    filename: name,
    triggeredBy: actor.label,
    detail: { request: { components, allowUnsigned: opts.allowUnsigned }, actor },
  });
  await audit(actor, "backup.restore.request", name, { runId: run.id, components, allowUnsigned: opts.allowUnsigned }, { severity: "critical" });
  return run;
}

/** Cancel a waiting operation at once, or ask a running one to stop at its next step (a restore: only before it changes anything). */
export async function cancelOperation(actor: Actor, runId: string): Promise<"cancelled" | "requested"> {
  admin(actor);
  const db = await getDb();
  const [run] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, runId));
  if (!run || !["pending", "running"].includes(run.status)) throw new PostError("That operation is not waiting or running.", 404);
  const removed = rowsOf(await db.execute(sql`delete from job where kind = ${BACKUP_JOB} and status = 'queued' and payload->>'runId' = ${runId} returning id`));
  if (removed.length && run.status === "pending") {
    await db.update(schema.backupRun).set({ status: "cancelled", error: `Cancelled by ${actor.label} before it started.`, finishedAt: new Date() }).where(eq(schema.backupRun.id, runId));
    await audit(actor, "backup.cancel", runId, { operation: run.operation });
    return "cancelled";
  }
  await db.update(schema.backupRun).set({ cancelRequested: true }).where(eq(schema.backupRun.id, runId));
  await audit(actor, "backup.cancel", runId, { operation: run.operation, running: true });
  return "requested";
}

/** Delete a stored backup (and its sidecar), unless an operation is using it. */
export async function deleteBackup(actor: Actor, name: string): Promise<void> {
  admin(actor);
  checkName(name);
  const db = await getDb();
  const using = await db.select({ id: schema.backupRun.id }).from(schema.backupRun).where(and(eq(schema.backupRun.filename, name), inArray(schema.backupRun.status, ["pending", "running"])));
  if (using.length) throw new PostError("This backup is being verified or restored: it can be deleted when that has finished.", 409);
  const c = await readBackupConfig();
  if (!c.r2) throw new PostError("Backups are not configured.", 404);
  const store = await backupStore(c.r2.bucket);
  if (!(await store.head(`${BACKUP_ROOT}/${name}`))) throw new PostError("That backup is not in the bucket.", 404);
  await store.remove(`${BACKUP_ROOT}/${name}`);
  await store.remove(`${BACKUP_ROOT}/${sidecarName(name)}`).catch(() => undefined);
  await audit(actor, "backup.delete", name, {}, { severity: "warning" });
}

// --- Listing -------------------------------------------------------------------------------------------------

export type Sidecar = { manifest: Manifest; archive: { name: string; bucket: string; key: string; size: number; sha256: string }; verifiedAt: string };

export type BackupItem = {
  name: string;
  type: BackupType | "legacy";
  label: string;
  createdAt: string;
  size: number;
  components: Component[];
  legacy: boolean;
  /** The backup run that made it (null when the database no longer has it, e.g. after a restore elsewhere). */
  made: Pick<BackupRun, "id" | "trigger" | "triggeredBy" | "sha256" | "status"> | null;
  /** The newest verification of it, and whether it passed. */
  verified: { at: string; ok: boolean } | null;
  inUse: boolean;
};

export async function listBackups(): Promise<{ items: BackupItem[]; totalBytes: number; configured: boolean }> {
  const c = await readBackupConfig();
  if (!c.r2) return { items: [], totalBytes: 0, configured: false };
  const store = await backupStore(c.r2.bucket);
  const objects = (await store.list(`${BACKUP_ROOT}/`))
    .map((o) => ({ ...o, name: o.key.slice(BACKUP_ROOT.length + 1) }))
    .filter((o) => !o.name.includes("/") && isBackupName(o.name));
  const names = objects.map((o) => o.name);
  const db = await getDb();
  const runs = names.length ? await db.select().from(schema.backupRun).where(inArray(schema.backupRun.filename, names)).orderBy(desc(schema.backupRun.startedAt)) : [];
  const items = objects.map((o): BackupItem => {
    const p = parseArchiveName(o.name)!;
    const mine = runs.filter((r) => r.filename === o.name);
    const made = mine.find((r) => r.operation === "backup") ?? null;
    // A fresh backup is verified as it is made; a Verify run afterwards is newer.
    const check = mine.find((r) => (r.operation === "verify" && (r.status === "completed" || r.status === "failed")) || (r.operation === "backup" && r.status === "completed"));
    return {
      name: o.name,
      type: p.type,
      label: TYPE_LABEL[p.type],
      createdAt: p.createdAt.toISOString(),
      size: o.size,
      components: p.type === "legacy" ? ["database"] : TYPE_COMPONENTS[p.type],
      legacy: p.legacy,
      made: made && { id: made.id, trigger: made.trigger, triggeredBy: made.triggeredBy, sha256: made.sha256, status: made.status },
      verified: check ? { at: (check.finishedAt ?? check.startedAt).toISOString(), ok: check.status === "completed" } : null,
      inUse: mine.some((r) => r.status === "pending" || r.status === "running"),
    };
  });
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  return { items, totalBytes: objects.reduce((n, o) => n + o.size, 0), configured: true };
}

/** A backup's sidecar (manifest + archive checksum), or null (format 1, or a backup made before its sidecar was written). */
export async function readSidecar(name: string): Promise<Sidecar | null> {
  checkName(name);
  if (isLegacyBackup(name)) return null;
  const c = await readBackupConfig();
  if (!c.r2) return null;
  const r = await (await backupStore(c.r2.bucket)).read(`${BACKUP_ROOT}/${sidecarName(name)}`);
  if (!r) return null;
  const text = await new Response(r.body).text();
  try {
    return JSON.parse(text) as Sidecar;
  } catch {
    return null;
  }
}

/** The newest backup (not a verification or a restore), as a one-element list (the admin dashboard). */
export async function lastBackups(limit = 1): Promise<BackupRun[]> {
  const db = await getDb();
  return db.select().from(schema.backupRun).where(eq(schema.backupRun.operation, "backup")).orderBy(desc(schema.backupRun.startedAt)).limit(limit);
}

export async function recentOperations(limit = 25): Promise<BackupRun[]> {
  const db = await getDb();
  return db.select().from(schema.backupRun).orderBy(desc(schema.backupRun.startedAt)).limit(limit);
}

export async function operation(id: string): Promise<BackupRun | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const db = await getDb();
  const [r] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, id));
  return r ?? null;
}

/** The CrewAI schedules that run backup_flow (AI & SEO → Schedules), if the agent's tables exist. */
export async function flowSchedules(): Promise<{ name: string; cron: string; timezone: string; enabled: boolean }[]> {
  const db = await getDb();
  try {
    return rowsOf<{ name: string; cron: string; timezone: string; enabled: boolean }>(
      await db.execute(sql`select name, cron, timezone, enabled from seo_flow_schedules where flow_name = 'backup_flow' order by name`),
    );
  } catch {
    return [];
  }
}

export async function backupOverview() {
  const c = await readBackupConfig();
  const db = await getDb();
  const [lastOk] = await db.select().from(schema.backupRun).where(and(eq(schema.backupRun.operation, "backup"), eq(schema.backupRun.status, "completed"))).orderBy(desc(schema.backupRun.startedAt)).limit(1);
  const [lastAny] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.operation, "backup")).orderBy(desc(schema.backupRun.startedAt)).limit(1);
  const flows = await flowSchedules();
  const flowOwns = flows.some((f) => f.enabled);
  return { config: c, lastSuccessful: lastOk ?? null, latest: lastAny ?? null, flowSchedules: flows, builtInScheduleActive: c.schedule !== "off" && !flowOwns, active: await activeOperation() };
}

// --- Retention -------------------------------------------------------------------------------------------------

/** Remove what retention says (lib/backup/format.ts selectForRetention); never a backup an operation is using. */
export async function applyRetention(now = new Date()): Promise<{ removed: string[]; keptBytes: number; kept: number }> {
  const c = await readBackupConfig();
  if (!c.r2) return { removed: [], keptBytes: 0, kept: 0 };
  const store = await backupStore(c.r2.bucket);
  const { items } = await listBackups();
  const protect = new Set(items.filter((i) => i.inUse).map((i) => i.name));
  const remove = selectForRetention(
    items.map((i) => ({ name: i.name, type: i.type, createdAt: new Date(i.createdAt) })),
    { keep: c.retention, maxAgeDays: c.maxAgeDays, now, protect },
  );
  for (const name of remove) {
    await store.remove(`${BACKUP_ROOT}/${name}`);
    await store.remove(`${BACKUP_ROOT}/${sidecarName(name)}`).catch(() => undefined);
  }
  if (remove.length) log.info("old backups removed", { operation: "backup_retention", removed: remove.length, names: remove });
  const left = items.filter((i) => !remove.includes(i.name));
  return { removed: remove, keptBytes: left.reduce((n, i) => n + i.size, 0), kept: left.length };
}

// --- The job -------------------------------------------------------------------------------------------------

type Ctx = { run: BackupRun; progress: (p: Omit<BackupProgress, "seq" | "at">) => void; cancelled: () => boolean };

/** Progress for the admin page, at most every 1.5 s, never awaited (inside the export's transaction a write must not wait). */
function progressWriter(runId: string) {
  let seq = 0;
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  let latest: BackupProgress = {};
  const write = () => {
    timer = null;
    last = Date.now();
    const p = { ...latest, at: new Date().toISOString() };
    void getDb()
      .then((db) => db.execute(sql`update backup_run set progress = ${JSON.stringify(p)}::jsonb where id = ${runId} and coalesce((progress->>'seq')::int, -1) < ${p.seq ?? 0}`))
      .catch(() => undefined);
  };
  // A heartbeat, so a running restore keeps counting as running (restoreInProgress).
  const beat = setInterval(() => {
    latest = { ...latest, seq: ++seq };
    write();
  }, 30_000);
  beat.unref?.();
  return {
    update(p: Omit<BackupProgress, "seq" | "at">) {
      latest = { ...p, seq: ++seq };
      if (Date.now() - last >= 1500) write();
      else timer ??= setTimeout(write, 1500);
    },
    stop() {
      clearInterval(beat);
      if (timer) clearTimeout(timer);
    },
  };
}

/** Whether an admin asked to cancel, polled every 5 s (never inside the export's transaction). */
function cancelWatcher(runId: string) {
  let requested = false;
  const t = setInterval(() => {
    void getDb()
      .then((db) => db.select({ c: schema.backupRun.cancelRequested }).from(schema.backupRun).where(eq(schema.backupRun.id, runId)))
      .then(([r]) => {
        if (r?.c) requested = true;
      })
      .catch(() => undefined);
  }, 5000);
  t.unref?.();
  return { requested: () => requested, stop: () => clearInterval(t) };
}

const TRANSIENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ECONNREFUSED|InternalError|ServiceUnavailable|SlowDown|RequestTimeout|connection terminated|Connection terminated/i;
function transient(e: unknown): boolean {
  if (e instanceof BackupError || e instanceof BackupCancelled || e instanceof PostError) return false;
  const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
  return status >= 500 || status === 429 || TRANSIENT.test(String((e as Error)?.message ?? e));
}

const safeMessage = (e: unknown) => (e instanceof BackupError || e instanceof BackupCancelled || e instanceof PostError ? e.message : `Unexpected error: ${String((e as Error)?.message ?? e).slice(0, 300)}`);

async function finish(runId: string, values: Partial<typeof schema.backupRun.$inferInsert>) {
  const db = await getDb();
  await db
    .update(schema.backupRun)
    .set({ ...values, finishedAt: new Date(), progress: sql`jsonb_set(progress, '{seq}', '999999999')` as unknown as BackupProgress })
    .where(eq(schema.backupRun.id, runId));
}

/** Job handler for kind "backup" (lib/scheduler.ts, its own loop): one operation, by its backup_run row. */
export async function backupJobHandler(payload: Record<string, unknown>): Promise<void> {
  const runId = String(payload.runId ?? "");
  const db = await getDb();
  const [run] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, runId));
  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return;
  if (run.cancelRequested) {
    await finish(runId, { status: "cancelled", error: "Cancelled before it started." });
    return;
  }
  const op = run.operation;
  // A restore cut off part-way (its pod went away) is never started again on its own: its transaction rolled back.
  if (run.status === "running" && op === "restore") {
    await finish(runId, { status: "failed", error: "Interrupted: the pod running the restore stopped. The database transaction rolled back, so nothing in the database changed; files already put back stay. Start the restore again if needed." });
    return;
  }
  const attempt = run.attempts + 1;
  await db
    .update(schema.backupRun)
    .set({ status: "running", attempts: attempt, startedAt: new Date(), error: run.status === "running" ? "The previous attempt was interrupted (its pod stopped); starting again." : run.error })
    .where(eq(schema.backupRun.id, runId));
  const writer = progressWriter(runId);
  const cancel = cancelWatcher(runId);
  const ctx: Ctx = { run: { ...run, attempts: attempt }, progress: (p) => writer.update(p), cancelled: cancel.requested };
  try {
    await withSpan(`backup ${op}`, { "backup.operation": op, "backup.type": run.backupType ?? "", "backup.trigger": run.trigger }, async () => {
      if (op === "backup") await runCreate(ctx);
      else if (op === "verify") await runVerify(ctx);
      else await runRestore(ctx);
    });
  } catch (error) {
    if (error instanceof BackupCancelled) {
      await finish(runId, { status: "cancelled", error: error.message });
      log.info("backup operation cancelled", { operation: `backup_${op}`, runId });
      return;
    }
    if (transient(error) && attempt < MAX_ATTEMPTS[op]) {
      await db.update(schema.backupRun).set({ status: "pending", error: `Attempt ${attempt} failed (${safeMessage(error)}); it will be tried again.` }).where(eq(schema.backupRun.id, runId));
      log.warn("backup operation will retry", { operation: `backup_${op}`, runId, attempt, err: error });
      throw error; // the job queue retries with its backoff
    }
    await finish(runId, { status: "failed", error: safeMessage(error) });
    if (!(error instanceof BackupError || error instanceof PostError)) log.error("backup operation failed", { operation: `backup_${op}`, runId, err: error });
    else log.warn("backup operation failed", { operation: `backup_${op}`, runId, reason: error.message });
  } finally {
    writer.stop();
    cancel.stop();
  }
}

function summary(r: CreateResult) {
  const m = r.manifest;
  return {
    location: `${r.bucket}/${r.key}`,
    bucket: r.bucket,
    key: r.key,
    components: m.components,
    encrypted: m.encryption.encrypted,
    database: m.database && { tables: m.database.tables, rows: m.database.rows, bytes: m.database.bytes, secretsRedacted: m.database.secretsRedacted, excluded: m.database.excludedTables.map((t) => t.name), snapshotAt: m.database.snapshotAt },
    uploads: m.uploads && { files: m.uploads.files, bytes: m.uploads.bytes, referencedMissing: m.uploads.referencedMissing },
    files: m.files,
    schemaVersion: m.application.schemaVersion,
    verification: { ok: r.verification.ok, checkedAt: r.verification.checkedAt, files: r.verification.files, signature: r.verification.signature },
    warnings: r.warnings,
  };
}

async function runCreate({ run, progress, cancelled }: Ctx, type?: BackupType) {
  const started = Date.now();
  const r = await createBackup({
    type: type ?? ((run.backupType ?? "full") as BackupType),
    trigger: run.trigger as "manual" | "scheduled" | "flow" | "pre-restore",
    backupId: run.id,
    createdBy: run.triggeredBy ?? "scheduler",
    progress,
    cancelled,
  });
  const retention = await applyRetention().catch((e: unknown) => {
    log.warn("backup retention failed", { operation: "backup_retention", err: e });
    return { removed: [] as string[], keptBytes: 0, kept: 0, error: (e as Error).message };
  });
  await finish(run.id, {
    status: "completed",
    filename: r.name,
    sizeBytes: r.size,
    sha256: r.sha256,
    error: null,
    results: [{ destination: r.bucket, ok: true, detail: retention.removed.length ? `uploaded and verified; removed ${retention.removed.length} old backup(s)` : "uploaded and verified" }],
    detail: { ...summary(r), durationMs: Date.now() - started, retention, storage: { backups: retention.kept, bytes: retention.keptBytes } },
  });
  log.info("backup finished", { operation: "backup_create", runId: run.id, type: run.backupType, trigger: run.trigger, name: r.name, sizeBytes: r.size, tables: r.manifest.database?.tables, files: r.manifest.uploads?.files });
  return r;
}

async function runVerify({ run, progress, cancelled }: Ctx) {
  const c = await readBackupConfig();
  if (!c.r2) throw new BackupError("Backups are not configured.");
  const name = run.filename!;
  const sidecar = await readSidecar(name);
  progress({ phase: "verifying", message: "Checking the archive" });
  const report = await verifyArchive(await backupStore(c.r2.bucket), name, {
    passwords: backupPasswords(c),
    expectedSha256: sidecar?.archive.sha256 ?? null,
    cancelled,
    onProgress: (done, total) => progress({ phase: "verifying", message: `Checking file ${done} of ${total}`, done, total }),
  });
  if (cancelled()) throw new BackupCancelled("Cancelled by an admin.");
  const detail = { report: { ...report, manifest: undefined, password: undefined }, sidecar: Boolean(sidecar) };
  await finish(run.id, report.ok ? { status: "completed", detail, sizeBytes: report.archiveSize, sha256: report.archiveSha256, error: null } : { status: "failed", detail, sizeBytes: report.archiveSize, error: `Verification failed: ${report.problems.slice(0, 3).join("; ")}` });
}

async function runRestore(ctx: Ctx) {
  const { run, progress, cancelled } = ctx;
  const req = (run.detail as { request?: { components: RestoreComponents; allowUnsigned: boolean }; actor?: Actor }) ?? {};
  const actor = req.actor ?? { id: "system", role: "admin" as const, label: run.triggeredBy ?? "admin" };
  const name = run.filename!;
  const started = Date.now();
  // The safety net: a database backup of the site as it is now, made and verified before anything changes.
  const safety = async () => {
    const db = await getDb();
    const [s] = await db.insert(schema.backupRun).values({ operation: "backup", backupType: "prerestore", trigger: "pre-restore", status: "running", triggeredBy: `restore of ${name}`, requestedByRef: run.id, attempts: 1 }).returning();
    try {
      const r = await createBackup({ type: "prerestore", trigger: "pre-restore", backupId: s!.id, createdBy: `restore of ${name} by ${actor.label}`, progress: (p) => progress({ ...p, phase: "safety", message: `Safety backup: ${p.message}` }), cancelled });
      await finish(s!.id, { status: "completed", filename: r.name, sizeBytes: r.size, sha256: r.sha256, detail: summary(r) });
      return r.name;
    } catch (e) {
      await finish(s!.id, { status: e instanceof BackupCancelled ? "cancelled" : "failed", error: safeMessage(e) });
      throw e;
    }
  };
  if (isLegacyBackup(name)) {
    progress({ phase: "database", message: "Restoring the content of an old-format backup" });
    const r = await restoreLegacyBackup(actor, name, safety);
    await finish(run.id, { status: "completed", error: null, detail: { ...run.detail, result: { legacy: true, ...r }, durationMs: Date.now() - started } });
    await afterRestore();
    return;
  }
  const sidecar = await readSidecar(name);
  const r = await restoreBackup({ name, components: req.request?.components ?? { database: true, uploads: true }, allowUnsigned: Boolean(req.request?.allowUnsigned), expectedSha256: sidecar?.archive.sha256 ?? null, safety, progress, cancelled });
  await finish(run.id, {
    status: "completed",
    error: null,
    detail: { ...run.detail, result: { safetyBackup: r.safetyBackup, signed: r.signed, compatibility: r.compatibility, database: r.database, uploads: r.uploads, verification: { ok: r.verification.ok, files: r.verification.files, signature: r.verification.signature } }, durationMs: Date.now() - started },
  });
  await afterRestore();
  await audit(actor, "backup.restore", name, { safetyBackup: r.safetyBackup, signed: r.signed, tables: r.database ? Object.keys(r.database.tables).length : 0, usersAdded: r.database?.usersAdded ?? 0, rolesRestored: r.database?.rolesRestored ?? 0, rolesNotRestored: r.database?.rolesNotRestored ?? 0, filesRestored: r.uploads?.restored ?? 0 }, { severity: "critical" });
  log.warn("site restored from a backup", { operation: "backup_restore", runId: run.id, name, safetyBackup: r.safetyBackup, tables: r.database ? Object.keys(r.database.tables).length : 0, filesRestored: r.uploads?.restored ?? 0 });
}

/** Every replica drops what it cached from the old database (content, categories, settings, integrations, practice, pages). */
async function afterRestore() {
  const { invalidateContent } = await import("../content");
  const { KINDS, broadcastInvalidate, broadcastPagePurge } = await import("../cache-bus");
  invalidateContent();
  for (const k of KINDS) broadcastInvalidate(k);
  broadcastPagePurge(null);
}

// --- Schedule ---------------------------------------------------------------------------------------------------

/**
 * The built-in schedule (Settings → System → Backups): once a day or week, at or after the chosen hour (UTC). It stands
 * down while a CrewAI schedule runs backup_flow (AI & SEO → Schedules, e.g. website-full-backup), so there is one
 * scheduler for backups, never two. A run is claimed under an advisory lock, so replicas ticking together start one.
 */
export async function backupScheduleTick(now = new Date()): Promise<string | null> {
  const c = await readBackupConfig();
  if (c.schedule === "off" || !c.r2?.enabled) return null;
  if (now.getUTCHours() < c.hourUtc) return null;
  if ((await flowSchedules()).some((f) => f.enabled)) return null;
  const interval = c.schedule === "daily" ? 20 * 3_600_000 : 6.5 * 86_400_000;
  const db = await getDb();
  const runId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SCHEDULE_LOCK_ID})`);
    const [last] = rowsOf<{ at: string }>(await tx.execute(sql`select started_at::text as at from backup_run where operation = 'backup' and trigger in ('scheduled', 'flow') order by started_at desc limit 1`));
    if (last && now.getTime() - new Date(last.at).getTime() < interval) return null;
    if (rowsOf(await tx.execute(sql`select 1 from job where dedupe_key = ${DEDUPE} and status in ('queued', 'running') limit 1`)).length) return null;
    const [row] = await tx.insert(schema.backupRun).values({ operation: "backup", backupType: c.scheduleType, trigger: "scheduled", status: "pending", triggeredBy: "schedule", startedAt: now }).returning({ id: schema.backupRun.id });
    await tx.execute(sql`insert into job (kind, dedupe_key, payload, run_at, max_attempts) values (${BACKUP_JOB}, ${DEDUPE}, ${JSON.stringify({ runId: row!.id })}::jsonb, ${now.toISOString()}, ${MAX_ATTEMPTS.backup})`);
    return row!.id;
  });
  if (runId) log.info("scheduled backup queued", { operation: "backup_schedule", runId, type: c.scheduleType });
  return runId;
}

/** One tick of the backup loop (lib/scheduler.ts): the schedule, then at most one backup job. */
export async function backupWorkerTick(now = new Date()) {
  try {
    await backupScheduleTick(now);
  } catch (error) {
    log.warn("backup schedule tick failed", { operation: "backup_schedule", err: error });
  }
  const { runDueJobs } = await import("../jobs");
  await runDueJobs({ [BACKUP_JOB]: backupJobHandler }, now, 1, { kinds: [BACKUP_JOB] });
}
