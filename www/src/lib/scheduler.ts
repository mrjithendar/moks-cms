import { indexNowHandler } from "./indexnow";
import { runDueJobs } from "./jobs";
import { log } from "./log";
import { publishDuePosts } from "./posts";

/**
 * Background worker in every replica (started from instrumentation.ts): every 30 s it publishes
 * scheduled posts whose time has come and runs due jobs (IndexNow). Restart-safe (state lives in
 * Postgres) and safe with several replicas (conditional updates, SKIP LOCKED). Missed ticks during
 * downtime are caught up on the next tick, so a post scheduled while the site was down goes live
 * as soon as it is back.
 */
export async function workerTick(now = new Date()) {
  const published = await publishDuePosts(now);
  if (published.length) log.info("scheduled posts published", { count: published.length, ids: published });
  const { seoJobHandler, draftJobHandler } = await import("./seo-intel/handlers");
  const jobs = await runDueJobs({ indexnow: indexNowHandler, seo: seoJobHandler, seo_draft: draftJobHandler }, now);
  if (jobs.done || jobs.retried || jobs.failed) log.info("jobs processed", jobs);
  await practiceTick(now);
  await seoScheduleTick(now);
}

const seoState = globalThis as unknown as { __seoTickAt?: number };

/** SEO intelligence schedules (docs/seo): enqueue due runs; at most every 5 minutes per replica. */
async function seoScheduleTick(now: Date) {
  if (seoState.__seoTickAt && now.getTime() - seoState.__seoTickAt < 5 * 60_000) return;
  seoState.__seoTickAt = now.getTime();
  try {
    const { seoTick } = await import("./seo-intel/jobs");
    const queued = await seoTick(now);
    if (queued) log.info("seo jobs scheduled", { count: queued });
  } catch (error) {
    // Never let SEO scheduling break publishing or other jobs.
    log.warn("seo schedule tick failed", { operation: "seo_tick", err: error });
  }
}

const practiceState = globalThis as unknown as { __practiceRetentionDay?: string };

/** Python practice: collect finished runs nobody polled for, end timed sessions past their deadline, daily retention. */
async function practiceTick(now: Date) {
  const { sweepPendingSubmissions } = await import("./practice/submissions");
  const { expireSessions } = await import("./practice/sessions");
  const swept = await sweepPendingSubmissions(now);
  const expired = await expireSessions(now);
  if (swept || expired) log.info("practice sweep", { submissions: swept, sessionsExpired: expired });
  const day = now.toISOString().slice(0, 10);
  if (practiceState.__practiceRetentionDay !== day) {
    practiceState.__practiceRetentionDay = day;
    const { applyRetention } = await import("./practice/profile");
    await applyRetention(now);
  }
}

export function startWorker() {
  const g = globalThis as unknown as { __workerTimer?: NodeJS.Timeout };
  if (g.__workerTimer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await workerTick();
    } catch (error) {
      log.warn("worker tick failed", { err: error });
    } finally {
      running = false;
    }
  };
  g.__workerTimer = setInterval(() => void tick(), 30_000);
  g.__workerTimer.unref?.();
  void tick();
}
