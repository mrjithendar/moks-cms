import os from "node:os";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { log } from "./log";

/**
 * There is one worker pod. If it is down (crash loop, a node problem, a network policy that does not know it yet),
 * nothing would publish scheduled posts, run jobs or take backups, and nothing would say so.
 *
 * So the worker reports that it is alive, and every web replica watches for that report. A web replica that has not
 * seen one for STANDBY_AFTER_MS starts the background work itself, exactly as every replica did before the worker
 * existed, and keeps doing it until the pod is replaced (the next release or content publish). Running the work in
 * two places is safe: jobs are claimed, scheduled posts are published by conditional update, backups are claimed
 * once per interval.
 *
 * The report is one row in `setting`, stamped and compared with the database's clock, so pods need not agree on
 * the time.
 */
const KEY = "worker.heartbeat";
export const HEARTBEAT_MS = 30_000;
export const STANDBY_AFTER_MS = 3 * 60_000;
const STANDBY_CHECK_MS = 60_000;

export async function beat(host: string = os.hostname()): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: { host }, updatedAt: sql`now()` })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: { host }, updatedAt: sql`now()` } });
}

/** How long ago the worker last reported, in milliseconds; null when it never has. */
export async function workerSilentMs(): Promise<number | null> {
  const db = await getDb();
  const [row] = await db
    .select({ ms: sql<number>`extract(epoch from (now() - ${schema.setting.updatedAt})) * 1000` })
    .from(schema.setting)
    .where(eq(schema.setting.key, KEY));
  return row ? Number(row.ms) : null;
}

/** Worker (and single-process) side: report now and every HEARTBEAT_MS. */
export function startHeartbeat(): void {
  const g = globalThis as unknown as { __heartbeatTimer?: NodeJS.Timeout };
  if (g.__heartbeatTimer) return;
  const report = () => void beat().catch((err) => log.warn("worker heartbeat failed", { event: "worker_heartbeat_failed", err }));
  g.__heartbeatTimer = setInterval(report, HEARTBEAT_MS);
  g.__heartbeatTimer.unref?.();
  report();
}

/** One look at the heartbeat. Starts the background work and returns true when the worker has been silent too long. */
export async function standbyCheck(start: () => Promise<void> | void, afterMs: number = STANDBY_AFTER_MS): Promise<boolean> {
  const silentMs = await workerSilentMs();
  if (silentMs !== null && silentMs <= afterMs) return false;
  log.warn("background worker is silent: this web replica runs the background work until it is replaced", {
    event: "worker_standby_started",
    silentMs: silentMs === null ? null : Math.round(silentMs),
  });
  await start();
  return true;
}

/**
 * Web side: look at the heartbeat every minute until this replica has taken over. The first look is a minute after
 * start, which gives a worker that restarts in the same release time to come back.
 */
export function startStandby(start: () => Promise<void> | void): void {
  const g = globalThis as unknown as { __standbyTimer?: NodeJS.Timeout };
  if (g.__standbyTimer) return;
  let busy = false;
  const look = async () => {
    if (busy) return;
    busy = true;
    try {
      if (await standbyCheck(start)) clearInterval(g.__standbyTimer);
    } catch (err) {
      log.warn("worker standby check failed", { event: "worker_standby_check_failed", err });
    } finally {
      busy = false;
    }
  };
  g.__standbyTimer = setInterval(() => void look(), STANDBY_CHECK_MS);
  g.__standbyTimer.unref?.();
}
