import { indexNowHandler } from "./indexnow";
import { runDueJobs } from "./jobs";
import { log } from "./log";
import { publishDuePosts } from "./posts";

/**
 * Background worker in every replica (started from instrumentation.ts), as two loops that tick every 30 s:
 * - publishing: scheduled posts whose time has come go live. On its own loop, so a long job (a crawl, a report, a
 *   model call) can never hold a scheduled post back;
 * - jobs: the job queue (IndexNow, SEO jobs), the practice sweeps, scheduled SEO drafts and the daily clean-up.
 * Restart-safe (state lives in Postgres) and safe with several replicas (conditional updates, SKIP LOCKED). Missed
 * ticks during downtime are caught up on the next tick, so a post scheduled while the site was down goes live as
 * soon as it is back.
 */
export async function publishTick(now = new Date()) {
  const published = await publishDuePosts(now);
  if (published.length) log.info("scheduled posts published", { count: published.length, ids: published });
}

export async function workerTick(now = new Date()) {
  const { seoJobHandler, draftJobHandler, verifyJobHandler, submissionJobHandler } = await import("./seo-intel/handlers");
  // Reports (D-102): building a report and sending its emails run here, never in a request.
  const { reportJobHandler } = await import("./reports/service");
  const { reportEmailHandler } = await import("./reports/email");
  const jobs = await runDueJobs({ indexnow: indexNowHandler, seo: seoJobHandler, seo_draft: draftJobHandler, seo_verify: verifyJobHandler, seo_submit: submissionJobHandler, report: reportJobHandler, report_email: reportEmailHandler }, now);
  if (jobs.done || jobs.retried || jobs.failed) log.info("jobs processed", jobs);
  await practiceTick(now);
  await seoDraftTick(now);
  await seoScheduleTick(now);
  await retentionTick(now);
}

const retentionState = globalThis as unknown as { __retentionDay?: string };

/** Once a day per replica: finished jobs, expired rate-limit counters and (when configured) old audit entries. */
async function retentionTick(now: Date) {
  const day = now.toISOString().slice(0, 10);
  if (retentionState.__retentionDay === day) return;
  retentionState.__retentionDay = day;
  try {
    const { pruneOperationalTables } = await import("./retention");
    const removed = await pruneOperationalTables(now);
    if (removed.jobs || removed.rateLimits || removed.auditLog) log.info("old rows removed", { operation: "retention", ...removed });
    const { purgeExpiredReports } = await import("./reports/service");
    const reports = await purgeExpiredReports(now);
    if (reports) log.info("expired reports deleted", { operation: "retention", reports });
  } catch (error) {
    log.warn("retention tick failed", { operation: "retention", err: error });
  }
}

/** SEO drafts an admin approved for later: published on the tick their time comes (like scheduled posts). */
async function seoDraftTick(now: Date) {
  try {
    const { publishDueDrafts } = await import("./seo-intel/publish");
    const n = await publishDueDrafts(now);
    if (n) log.info("scheduled seo drafts published", { count: n });
  } catch (error) {
    log.warn("seo draft tick failed", { operation: "seo_draft_tick", err: error });
  }
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

/** A loop that runs `work` now and every `everyMs`, never twice at once (a tick that is still running is skipped). */
function loop(name: string, everyMs: number, work: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await work();
    } catch (error) {
      log.warn(`${name} tick failed`, { operation: name, err: error });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
  void tick();
  return timer;
}

export function startWorker() {
  const g = globalThis as unknown as { __workerTimer?: NodeJS.Timeout; __publishTimer?: NodeJS.Timeout };
  if (g.__workerTimer) return;
  g.__publishTimer = loop("publish", 30_000, () => publishTick());
  g.__workerTimer = loop("worker", 30_000, () => workerTick());
}
