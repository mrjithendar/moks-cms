import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";

/**
 * Daily clean-up of tables that otherwise only grow (lib/scheduler.ts runs it once a day per replica):
 *
 * - job: finished jobs (done or failed) older than 30 days. Queued and running jobs are never touched.
 * - rate_limit: counters whose window ended more than two days ago (the longest window is one day). Better Auth and
 *   lib/rate-limit.ts both store the window start in `last_request` (milliseconds), and neither deletes a row.
 * - audit_log: nothing by default. AUDIT_LOG_RETENTION_DAYS (30 or more) removes older entries; leave it unset to
 *   keep the full history.
 */
export const JOB_RETENTION_DAYS = 30;
export const RATE_LIMIT_RETENTION_MS = 2 * 86_400_000;
export const MIN_AUDIT_RETENTION_DAYS = 30;

type Env = Record<string, string | undefined>;

/** Days to keep audit entries, or null to keep them all. Values below 30 are ignored rather than obeyed. */
export function auditRetentionDays(env: Env = process.env): number | null {
  const n = Number(env.AUDIT_LOG_RETENTION_DAYS);
  return Number.isInteger(n) && n >= MIN_AUDIT_RETENTION_DAYS ? n : null;
}

export async function pruneOperationalTables(now = new Date(), env: Env = process.env): Promise<{ jobs: number; rateLimits: number; auditLog: number }> {
  const db = await getDb();
  const removed = async (statement: SQL) => Number(rowsOf<{ n: number }>(await db.execute(sql`with d as (${statement} returning 1) select count(*)::int as n from d`))[0]?.n ?? 0);
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const jobs = await removed(sql`delete from job where status in ('done', 'failed') and finished_at < ${before(JOB_RETENTION_DAYS)}`);
  const rateLimits = await removed(sql`delete from rate_limit where last_request < ${now.getTime() - RATE_LIMIT_RETENTION_MS}`);
  const keep = auditRetentionDays(env);
  const auditLog = keep === null ? 0 : await removed(sql`delete from audit_log where created_at < ${before(keep)}`);
  return { jobs, rateLimits, auditLog };
}
