import { sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "./log";
import { withSpan } from "./trace";

/**
 * A small Postgres-backed job queue (no extra service): jobs survive restarts, run once across
 * replicas (FOR UPDATE SKIP LOCKED), retry with exponential backoff and are de-duplicated while
 * pending (unique dedupe_key among queued/running jobs).
 *
 * How a job is held: a worker claims ONE job at a time, which marks it `running`, counts the attempt and gives it a
 * lock (locked_until) that the worker renews while the handler runs. If the worker dies, the lock runs out and the
 * job goes back to `queued`. Whatever the first worker writes afterwards is ignored: every write names the attempt
 * it belongs to (`attempts`), so a claim that was taken over can no longer mark the job done, failed or queued.
 */
export class PermanentJobError extends Error {}

export type JobRow = { id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number };
export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/** A claim lasts this long unless renewed; the worker renews it this often while a handler runs. */
export const JOB_LOCK_MS = 5 * 60_000;
export const JOB_RENEW_MS = 60_000;

export async function enqueue(kind: string, payload: Record<string, unknown>, opts: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {}): Promise<boolean> {
  const db = await getDb();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into job (kind, dedupe_key, payload, run_at, max_attempts)
      values (${kind}, ${opts.dedupeKey ?? null}, ${JSON.stringify(payload)}::jsonb, ${(opts.runAt ?? new Date()).toISOString()}, ${opts.maxAttempts ?? 5})
      on conflict do nothing
      returning id`),
  );
  return rows.length > 0;
}

/** 1 min, 2 min, 4 min … capped at 1 hour. */
export const backoffMs = (attempt: number) => Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Which kinds a worker takes: only `kinds` when given, never `excludeKinds` (site backups run on their own loop). */
export type KindFilter = { kinds?: string[]; excludeKinds?: string[] };

function kindCondition(f: KindFilter): SQL {
  if (f.kinds?.length) return sql` and kind in (select jsonb_array_elements_text(${JSON.stringify(f.kinds)}::jsonb))`;
  if (f.excludeKinds?.length) return sql` and kind not in (select jsonb_array_elements_text(${JSON.stringify(f.excludeKinds)}::jsonb))`;
  return sql``;
}

/** The next due job, now `running` for this worker, or null when nothing is due. */
async function claimNext(db: Db, now: Date, lockMs: number, filter: KindFilter = {}): Promise<JobRow | null> {
  const [job] = rowsOf<JobRow>(
    await db.execute(sql`
      update job set status = 'running', attempts = attempts + 1, locked_until = ${new Date(now.getTime() + lockMs).toISOString()}
      where id = (select id from job where status = 'queued' and run_at <= ${now.toISOString()}${kindCondition(filter)} order by run_at limit 1 for update skip locked)
      returning id, kind, payload, attempts, max_attempts`),
  );
  return job ?? null;
}

export async function runDueJobs(handlers: Record<string, JobHandler>, now = new Date(), limit = 10, opts: { lockMs?: number; renewMs?: number } & KindFilter = {}) {
  const db = await getDb();
  const lockMs = opts.lockMs ?? JOB_LOCK_MS;
  const renewMs = opts.renewMs ?? JOB_RENEW_MS;
  // A worker that died mid-job leaves it "running"; hand it back after its lock expires.
  await db.execute(sql`update job set status = 'queued' where status = 'running' and locked_until < ${now.toISOString()}`);
  const result = { done: 0, retried: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const job = await claimNext(db, now, lockMs, opts);
    if (!job) break;
    // Only this attempt of this job: a write after another worker took the job over changes nothing.
    const mine = sql`id = ${job.id} and status = 'running' and attempts = ${job.attempts}`;
    const wrote = async (update: SQL) => rowsOf(await db.execute(sql`${update} where ${mine} returning id`)).length > 0;
    const renew = setInterval(() => {
      void db
        .execute(sql`update job set locked_until = greatest(locked_until, ${new Date(Date.now() + lockMs).toISOString()}::timestamptz) where ${mine}`)
        .catch((err: unknown) => log.warn("job lock renewal failed", { jobId: job.id, kind: job.kind, operation: job.kind, err }));
    }, renewMs);
    renew.unref?.();
    const handler = handlers[job.kind];
    let kept: boolean;
    try {
      if (!handler) throw new PermanentJobError(`no handler for ${job.kind}`);
      // One trace per job run (background work has no request span to belong to).
      await withSpan(`job ${job.kind}`, { "job.kind": job.kind, "job.attempt": job.attempts }, () =>
        handler(typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload),
      );
      kept = await wrote(sql`update job set status = 'done', finished_at = ${new Date().toISOString()}, last_error = null`);
      if (kept) result.done++;
    } catch (error) {
      const message = messageOf(error);
      if (error instanceof PermanentJobError || job.attempts >= job.max_attempts) {
        kept = await wrote(sql`update job set status = 'failed', finished_at = ${new Date().toISOString()}, last_error = ${message}`);
        if (kept) {
          log.error("job failed", { jobId: job.id, kind: job.kind, attempts: job.attempts, operation: job.kind, err: error });
          result.failed++;
        }
      } else {
        const retryAt = new Date(now.getTime() + backoffMs(job.attempts)).toISOString();
        kept = await wrote(sql`update job set status = 'queued', run_at = ${retryAt}, last_error = ${message}`);
        if (kept) {
          log.warn("job will retry", { jobId: job.id, kind: job.kind, attempts: job.attempts, operation: job.kind, err: error });
          result.retried++;
        }
      }
    } finally {
      clearInterval(renew);
    }
    if (!kept) log.warn("job finished after another worker took it over; its result was not recorded", { event: "job_claim_lost", jobId: job.id, kind: job.kind, attempts: job.attempts, operation: job.kind });
  }
  return result;
}

/** For Admin → System status. */
export async function jobSummary() {
  const db = await getDb();
  const rows = rowsOf<{ status: string; n: number }>(await db.execute(sql`select status, count(*)::int as n from job where created_at > now() - interval '7 days' group by status`));
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
}
