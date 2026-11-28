import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { siteOrigin } from "../seo-intel/urls";
import { CallbackError } from "../seo-agent/callbacks";
import { PostError } from "../posts";
import { formatBytes } from "./format";
import { BackupBusy, describeRun, operation, requestBackup, type BackupRun } from "./service";

/**
 * The SEO agent's backup flow (seo-agent app/flows/backup.py, D-108) through the callback API
 * (lib/seo-agent/internal-server.ts). The flow only orchestrates: this server makes, verifies and stores the backup
 * with the same code an admin's Back up now uses (a background job, one operation at a time), and says how far it is.
 *
 * - POST /backups/start        queue a full (or database) backup: {started: true, backup} or {started: false, reason:
 *                              "busy", active} when another backup operation holds the queue; 409 backup_not_configured
 *                              when no backup destination is on;
 * - GET  /backups/runs/{id}    the backup's state: status, phase, progress, and once finished the archive (name, size,
 *                              SHA-256, location), what it holds, its verification, retention and storage use, or the error;
 * - POST /backups/notify       email the backup report to the SEO report recipients when email is set up.
 * Nothing here returns database contents or a credential.
 */

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CallbackError(`Invalid request: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 5).join("; ")}`, 400, "invalid");
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Detail = {
  location?: string;
  components?: string[];
  encrypted?: boolean;
  database?: { tables: number; rows: number; bytes: number; secretsRedacted: number; excluded: string[]; snapshotAt: string } | null;
  uploads?: { files: number; bytes: number; referencedMissing: number } | null;
  verification?: { ok: boolean; checkedAt: string; files: number; signature: string };
  retention?: { removed: string[]; kept: number; keptBytes: number; error?: string };
  storage?: { backups: number; bytes: number };
  warnings?: string[];
  durationMs?: number;
};

/** One backup as the flow sees it (and reports it). */
export function backupView(r: BackupRun) {
  const d = (r.detail ?? {}) as Detail;
  const p = r.progress ?? {};
  return {
    id: r.id,
    status: r.status,
    type: r.backupType,
    label: describeRun(r),
    phase: p.phase ?? null,
    message: p.message ?? null,
    done: p.done ?? null,
    total: p.total ?? null,
    heartbeatAt: p.at ?? null,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: d.durationMs ?? (r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null),
    attempts: r.attempts,
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    location: d.location ?? null,
    components: d.components ?? [],
    encrypted: d.encrypted ?? null,
    database: d.database ? { ok: true, tables: d.database.tables, rows: d.database.rows, bytes: d.database.bytes, secretsRedacted: d.database.secretsRedacted, excludedTables: d.database.excluded.length } : null,
    uploads: d.uploads ? { ok: d.uploads.referencedMissing === 0, files: d.uploads.files, bytes: d.uploads.bytes, referencedMissing: d.uploads.referencedMissing } : null,
    verification: d.verification ?? null,
    retention: d.retention ? { removed: d.retention.removed.length, kept: d.retention.kept, error: d.retention.error ?? null } : null,
    storage: d.storage ?? null,
    warnings: d.warnings ?? [],
    error: r.error,
    /** What asked for it (a CrewAI run id for the flow): a flow retrying its start recognises its own backup. */
    ref: r.requestedByRef,
    adminUrl: r.filename ? `${siteOrigin().origin}/admin/backups/${encodeURIComponent(r.filename)}` : `${siteOrigin().origin}/admin/backups`,
  };
}

export async function backupStartCallback(body: unknown) {
  const b = parse(z.object({ type: z.enum(["full", "database"]).default("full"), flowRunId: z.string().regex(UUID).optional() }), body);
  try {
    const run = await requestBackup(b.type, "flow", { label: "CrewAI flow backup_flow", ref: b.flowRunId });
    return { started: true as const, backup: backupView(run) };
  } catch (error) {
    if (error instanceof BackupBusy) return { started: false as const, reason: "busy" as const, active: error.active ? backupView(error.active) : null };
    if (error instanceof PostError && error.status === 409) throw new CallbackError(error.message, 409, "backup_not_configured");
    throw error;
  }
}

export async function backupRunCallback(id: string) {
  const r = await operation(id);
  if (!r || r.operation !== "backup") throw new CallbackError("No such backup.", 404, "not_found");
  return backupView(r);
}

/** The schedule that started a flow run (seo_flow_schedules.last_run_id), for the report's job name. */
async function scheduleOf(flowRunId: string | undefined): Promise<string | null> {
  if (!flowRunId) return null;
  const db = await getDb();
  const [r] = rowsOf<{ name: string }>(await db.execute(sql`select name from seo_flow_schedules where last_run_id::text = ${flowRunId} limit 1`).catch(() => []));
  return r?.name ?? null;
}

/** The backup report as text: what ran, when, how it went, where the archive is. Never contents or credentials. */
export function backupReport(v: ReturnType<typeof backupView>, job: string): { subject: string; text: string } {
  const ok = v.status === "completed";
  const secs = v.durationMs ? Math.round(v.durationMs / 1000) : null;
  const subject = `Backup ${ok ? "completed" : v.status}: ${job}${v.filename ? ` (${v.filename})` : ""}`;
  const lines = [
    `Job: ${job}`,
    `Started: ${v.startedAt}${v.finishedAt ? `; finished ${v.finishedAt}` : ""}${secs !== null ? ` (${secs} s)` : ""}`,
    `Status: ${v.status}${v.attempts > 1 ? ` after ${v.attempts} attempts` : ""}`,
    `Archive: ${v.filename ?? "none"}${v.sizeBytes ? `, ${formatBytes(v.sizeBytes)}` : ""}`,
    `Database: ${v.database ? `backed up (${v.database.tables} tables, ${v.database.rows.toLocaleString("en")} rows)` : ok ? "not part of this backup" : "not backed up"}`,
    `Files: ${v.uploads ? `backed up (${v.uploads.files.toLocaleString("en")} files, ${formatBytes(v.uploads.bytes)})${v.uploads.referencedMissing ? `; ${v.uploads.referencedMissing} file(s) the database points at were missing from the bucket` : ""}` : v.type === "database" ? "not part of a database-only backup" : "not backed up"}`,
    `Validation: ${v.verification ? (v.verification.ok ? `passed (${v.verification.files} files checked, signature ${v.verification.signature})` : "failed") : "not done"}`,
    `Stored at: ${v.location ?? "nowhere (no archive was kept)"}`,
    ...(v.storage ? [`Backups kept: ${v.storage.backups}, ${formatBytes(v.storage.bytes)}${v.retention?.removed ? `; retention removed ${v.retention.removed}` : ""}`] : []),
    ...(v.warnings.length ? [`Warnings: ${v.warnings.join("; ")}`] : []),
    ...(v.error ? [`Error: ${v.error}`] : []),
    "",
    `Details: ${v.adminUrl}`,
  ];
  return { subject, text: lines.join("\n") };
}

export async function backupNotifyCallback(body: unknown, send?: (subject: string, text: string) => Promise<boolean>) {
  const b = parse(z.object({ backupId: z.string().regex(UUID), flowRunId: z.string().regex(UUID).optional() }), body);
  const r = await operation(b.backupId);
  if (!r || r.operation !== "backup") throw new CallbackError("No such backup.", 404, "not_found");
  const job = (await scheduleOf(b.flowRunId)) ?? "backup_flow (started by hand)";
  const report = backupReport(backupView(r), job);
  const deliver = send ?? (await import("../seo-intel/notify")).sendSeoAlert;
  const sent = await deliver(report.subject, report.text).catch(() => false);
  return { sent, subject: report.subject, ...(sent ? {} : { reason: "email is not set up, or there are no report recipients (AI & SEO settings)" }) };
}
