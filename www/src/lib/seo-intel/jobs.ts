import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { enqueue } from "../jobs";
import { log } from "../log";
import { recordSeoSync } from "../metrics";
import { CredentialsError, readServiceAccount, SCOPES, type ServiceAccount } from "./google/auth";
import { GSC_TIME_ZONE } from "./google/gsc";
import { GoogleApiError, type ApiContext, type RunStats } from "./google/http";
import { getSeoSettings, type SeoSettings } from "./settings";
import { addDays, addMonths, dateIn, isDay, windows } from "./sqlutil";
import { syncGa4Window, syncGscWindow } from "./sync";

/**
 * SEO background work. Runs inside the existing worker (src/lib/scheduler.ts) and job queue (src/lib/jobs.ts):
 * no CronJobs, no Redis (docs/seo/DECISIONS.md D-02).
 *
 * - `seoTick()` (every worker tick) enqueues scheduled runs whose slot has come, once per slot.
 * - Each run takes a per-type lease (one run per type across replicas), writes a `seo_sync_jobs` row with
 *   window, status, rows, API requests, retries, error and correlation id, and records Prometheus metrics.
 * - Backfills are manual only and resumable: each job handles a time-boxed slice and enqueues the rest.
 */
export const JOB_TYPES = ["gsc_sync", "ga4_sync", "gsc_backfill", "ga4_backfill", "technical_scan", "recommendations", "report_weekly", "report_monthly", "retention", "outcomes"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export type Trigger = "schedule" | "manual" | "backfill";
export const JOB_KIND = "seo";

export type JobPayload = { type: JobType; trigger: Trigger; slot?: string; start?: string; end?: string; actor?: string; correlationId?: string };
export type RunOutcome = { status: "succeeded" | "partial" | "failed" | "skipped"; rows: number; error?: string; errorCode?: string; detail?: Record<string, unknown>; window?: { start: string; end: string } };

/** Test seams: fake Google, no real sleeping, fixed clock. */
export type RunDeps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date; env?: Record<string, string | undefined> };

const LEASE_MS = 10 * 60_000;
/** A backfill job stops taking new windows after this long and re-enqueues the remainder. */
const SLICE_MS = 4 * 60_000;

// --- Leases --------------------------------------------------------------------------------------------------

export async function acquireLease(db: Db, jobType: string, holder: string, now = new Date(), ms = LEASE_MS): Promise<boolean> {
  const until = new Date(now.getTime() + ms).toISOString();
  const rows = rowsOf<{ holder: string }>(
    await db.execute(sql`
      insert into seo_job_locks (job_type, holder, locked_until) values (${jobType}, ${holder}, ${until})
      on conflict (job_type) do update set holder = excluded.holder, locked_until = excluded.locked_until
      where seo_job_locks.locked_until < ${now.toISOString()} or seo_job_locks.holder = excluded.holder
      returning holder`),
  );
  return rows[0]?.holder === holder;
}

export async function releaseLease(db: Db, jobType: string, holder: string) {
  await db.execute(sql`delete from seo_job_locks where job_type = ${jobType} and holder = ${holder}`);
}

// --- Runs ----------------------------------------------------------------------------------------------------

export class SkipRun extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type RunContext = {
  db: Db;
  settings: SeoSettings;
  stats: RunStats;
  correlationId: string;
  payload: JobPayload;
  now: Date;
  deps: RunDeps;
  /** Renew the lease during long runs. */
  heartbeat: () => Promise<void>;
};

type Handler = (ctx: RunContext) => Promise<RunOutcome>;
const handlers = new Map<JobType, Handler>();

/** Analysis jobs (technical scan, recommendations, reports, outcomes) register themselves here. */
export function registerSeoHandler(type: JobType, handler: Handler) {
  handlers.set(type, handler);
}

export function serviceAccount(env: Record<string, string | undefined> = process.env): ServiceAccount {
  const sa = readServiceAccount(env);
  if (!sa) throw new SkipRun("Google credentials are not configured (GOOGLE_SEO_SERVICE_ACCOUNT_JSON).", "not_configured");
  return sa;
}

export function apiContext(ctx: RunContext, provider: ApiContext["provider"], scope: string): ApiContext {
  return { sa: serviceAccount(ctx.deps.env), scope, provider, stats: ctx.stats, maxRequests: ctx.settings.sync.maxRequestsPerRun, fetchImpl: ctx.deps.fetchImpl, sleep: ctx.deps.sleep };
}

async function setIntegration(db: Db, provider: string, propertyId: string, status: string, error: string | null, config?: Record<string, unknown>) {
  await db.execute(sql`
    insert into seo_integrations (provider, property_id, status, last_error, last_verified_at, config, updated_at)
    values (${provider}, ${propertyId}, ${status}, ${error}, ${status === "connected" ? new Date().toISOString() : null}, ${JSON.stringify(config ?? {})}::jsonb, now())
    on conflict (provider) do update set property_id = excluded.property_id, status = excluded.status, last_error = excluded.last_error,
      last_verified_at = coalesce(excluded.last_verified_at, seo_integrations.last_verified_at),
      config = seo_integrations.config || excluded.config, updated_at = now()`);
}

export { setIntegration };

/** Run one SEO job now (in this process). Never throws: the outcome is recorded in seo_sync_jobs. */
export async function runSeoJob(payload: JobPayload, deps: RunDeps = {}): Promise<RunOutcome & { id: string; correlationId: string }> {
  const db = await getDb();
  const now = deps.now?.() ?? new Date();
  const correlationId = payload.correlationId ?? randomUUID();
  const holder = randomUUID();
  const started = performance.now();
  const [row] = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into seo_sync_jobs (job_type, trigger, window_start, window_end, status, correlation_id, actor, detail)
      values (${payload.type}, ${payload.trigger}, ${payload.start ?? null}, ${payload.end ?? null}, 'running', ${correlationId}, ${payload.actor ?? null}, ${JSON.stringify(payload.slot ? { slot: payload.slot } : {})}::jsonb)
      returning id`),
  );
  const id = row!.id;
  const stats: RunStats = { apiRequests: 0, retries: 0 };
  let outcome: RunOutcome;
  const leased = await acquireLease(db, payload.type, holder, now);
  if (!leased) {
    outcome = { status: "skipped", rows: 0, error: "Another run of this job type is in progress.", errorCode: "locked" };
  } else {
    try {
      const settings = await getSeoSettings();
      const handler = payload.type === "gsc_sync" || payload.type === "gsc_backfill" ? runGsc : payload.type === "ga4_sync" || payload.type === "ga4_backfill" ? runGa4 : payload.type === "retention" ? runRetention : handlers.get(payload.type);
      if (!handler) throw new SkipRun(`No handler for ${payload.type}.`, "no_handler");
      outcome = await handler({ db, settings, stats, correlationId, payload, now, deps, heartbeat: async () => void (await acquireLease(db, payload.type, holder, new Date())) });
    } catch (error) {
      if (error instanceof SkipRun || error instanceof CredentialsError) {
        outcome = { status: "skipped", rows: 0, error: error.message, errorCode: (error as { code: string }).code };
      } else if (error instanceof GoogleApiError) {
        outcome = { status: "failed", rows: 0, error: error.message, errorCode: error.code };
      } else {
        outcome = { status: "failed", rows: 0, error: "Unexpected error; see the logs for this correlation id.", errorCode: "internal" };
        log.error("seo job failed", { operation: `seo_${payload.type}`, correlationId, err: error });
      }
    } finally {
      await releaseLease(db, payload.type, holder);
    }
  }
  const seconds = (performance.now() - started) / 1000;
  await db.execute(sql`
    update seo_sync_jobs set status = ${outcome.status}, finished_at = now(), rows_written = ${outcome.rows}, api_requests = ${stats.apiRequests},
      retries = ${stats.retries}, error = ${outcome.error?.slice(0, 1000) ?? null}, error_code = ${outcome.errorCode ?? null},
      window_start = coalesce(${outcome.window?.start ?? null}::date, window_start), window_end = coalesce(${outcome.window?.end ?? null}::date, window_end),
      detail = detail || ${JSON.stringify(outcome.detail ?? {})}::jsonb
    where id = ${id}`);
  recordSeoSync(payload.type, outcome.status === "failed" ? "failure" : outcome.status === "skipped" ? "skipped" : "success", seconds, outcome.errorCode);
  log[outcome.status === "failed" ? "warn" : "info"]("seo job finished", {
    operation: `seo_${payload.type}`,
    outcome: outcome.status,
    durationMs: Math.round(seconds * 1000),
    correlationId,
    rows: outcome.rows,
    apiRequests: stats.apiRequests,
    retries: stats.retries,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  });
  return { ...outcome, id, correlationId };
}

// --- GSC / GA4 handlers ----------------------------------------------------------------------------------------

/** Daily: the trailing window ending at the most recent day Search Console may have. Backfill: payload start/end. */
export function gscWindow(settings: SeoSettings, payload: JobPayload, now: Date): { start: string; end: string } {
  if (payload.start && payload.end) return { start: payload.start, end: payload.end };
  const end = addDays(dateIn(GSC_TIME_ZONE, now), -1);
  return { start: addDays(end, -(settings.sync.trailingDays - 1)), end };
}

async function runGsc(ctx: RunContext): Promise<RunOutcome> {
  const { settings, payload, db } = ctx;
  const property = settings.google.gscProperty;
  if (!property) throw new SkipRun("No Search Console property is configured.", "not_configured");
  const api = apiContext(ctx, "gsc", SCOPES.searchConsole);
  const range = gscWindow(settings, payload, ctx.now);
  const backfill = payload.type === "gsc_backfill";
  const slices = windows(range.start, range.end, backfill ? 7 : settings.sync.trailingDays);
  let rows = 0;
  const deadline = Date.now() + SLICE_MS;
  try {
    for (const [i, w] of slices.entries()) {
      if (backfill && i > 0 && Date.now() > deadline) {
        await enqueueSeoJob({ ...payload, start: w.start, end: range.end, correlationId: ctx.correlationId });
        await setIntegration(db, "gsc", property, "connected", null);
        return { status: "partial", rows, window: { start: range.start, end: addDays(w.start, -1) }, detail: { continuedFrom: w.start } };
      }
      rows += (await syncGscWindow(db, api, property, settings.google.searchTypes, w, settings.sync.rowLimit, ctx.now)).rows;
      await ctx.heartbeat();
    }
  } catch (e) {
    if (e instanceof GoogleApiError) await setIntegration(db, "gsc", property, e.code === "auth" ? "auth_error" : "error", e.message);
    throw e;
  }
  await setIntegration(db, "gsc", property, "connected", null);
  return { status: "succeeded", rows, window: range };
}

export function ga4Window(settings: SeoSettings, payload: JobPayload, now: Date, timeZone: string): { start: string; end: string } {
  if (payload.start && payload.end) return { start: payload.start, end: payload.end };
  const end = addDays(dateIn(timeZone, now), -1);
  return { start: addDays(end, -(settings.sync.trailingDays - 1)), end };
}

async function runGa4(ctx: RunContext): Promise<RunOutcome> {
  const { settings, payload, db } = ctx;
  const propertyId = settings.google.ga4PropertyId;
  if (!propertyId) throw new SkipRun("No GA4 property is configured.", "not_configured");
  const api = apiContext(ctx, "ga4", SCOPES.analytics);
  const [integration] = rowsOf<{ config: { timeZone?: string } }>(await db.execute(sql`select config from seo_integrations where provider = 'ga4'`));
  const timeZone = integration?.config?.timeZone || "UTC";
  const range = ga4Window(settings, payload, ctx.now, timeZone);
  const backfill = payload.type === "ga4_backfill";
  const slices = windows(range.start, range.end, backfill ? 14 : settings.sync.trailingDays);
  let rows = 0;
  let zone: string | null = null;
  let thresholded = false;
  const deadline = Date.now() + SLICE_MS;
  try {
    for (const [i, w] of slices.entries()) {
      if (backfill && i > 0 && Date.now() > deadline) {
        await enqueueSeoJob({ ...payload, start: w.start, end: range.end, correlationId: ctx.correlationId });
        return { status: "partial", rows, window: { start: range.start, end: addDays(w.start, -1) }, detail: { continuedFrom: w.start } };
      }
      const r = await syncGa4Window(db, api, propertyId, w, ctx.now);
      rows += r.rows;
      zone ??= r.timeZone;
      thresholded ||= r.thresholded;
      await ctx.heartbeat();
      if (r.partial) {
        await setIntegration(db, "ga4", propertyId, "connected", null, zone ? { timeZone: zone } : {});
        return { status: "partial", rows, window: { start: range.start, end: w.end }, error: r.note, errorCode: "quota", detail: { thresholded } };
      }
    }
  } catch (e) {
    if (e instanceof GoogleApiError) await setIntegration(db, "ga4", propertyId, e.code === "auth" ? "auth_error" : "error", e.message);
    throw e;
  }
  await setIntegration(db, "ga4", propertyId, "connected", null, zone ? { timeZone: zone } : {});
  return { status: "succeeded", rows, window: range, detail: { timeZone: zone, thresholded } };
}

/** Delete daily rows older than the retention period (default 16 months, like Search Console itself). */
async function runRetention(ctx: RunContext): Promise<RunOutcome> {
  const cutoff = addMonths(ctx.now.toISOString().slice(0, 10), -ctx.settings.sync.retentionMonths);
  let rows = 0;
  for (const table of ["seo_gsc_daily_totals", "seo_gsc_page_daily", "seo_gsc_query_daily", "seo_ga4_page_daily"]) {
    const deleted = rowsOf<{ n: number }>(await ctx.db.execute(sql`with d as (delete from ${sql.raw(`"${table}"`)} where date < ${cutoff} returning 1) select count(*)::int as n from d`));
    rows += Number(deleted[0]?.n ?? 0);
  }
  // Job history: keep a year.
  await ctx.db.execute(sql`delete from seo_sync_jobs where started_at < now() - interval '365 days'`);
  return { status: "succeeded", rows, detail: { cutoff } };
}

// --- Queue + schedules -----------------------------------------------------------------------------------------

export async function enqueueSeoJob(payload: JobPayload, dedupeKey?: string): Promise<boolean> {
  return enqueue(JOB_KIND, payload as unknown as Record<string, unknown>, { dedupeKey: dedupeKey ?? `seo:${payload.type}:${payload.slot ?? payload.start ?? "now"}`, maxAttempts: 1 });
}

/** Job-queue handler (registered in src/lib/scheduler.ts). */
export async function seoJobHandler(payload: Record<string, unknown>): Promise<void> {
  const type = payload.type as JobType;
  if (!JOB_TYPES.includes(type)) return;
  const p: JobPayload = {
    type,
    trigger: (["schedule", "manual", "backfill"] as const).find((t) => t === payload.trigger) ?? "manual",
    slot: typeof payload.slot === "string" ? payload.slot : undefined,
    start: isDay(payload.start) ? payload.start : undefined,
    end: isDay(payload.end) ? payload.end : undefined,
    actor: typeof payload.actor === "string" ? payload.actor : undefined,
    correlationId: typeof payload.correlationId === "string" ? payload.correlationId : undefined,
  };
  await runSeoJob(p);
}

/** The schedule slot (if any) that is due at `now`: a string unique per occurrence, e.g. "2026-11-09" or "2026-W45". */
export function dueSlots(s: SeoSettings, now: Date): { type: JobType; slot: string }[] {
  const day = now.toISOString().slice(0, 10);
  const h = now.getUTCHours();
  const dow = now.getUTCDay();
  const out: { type: JobType; slot: string }[] = [];
  const sc = s.schedules;
  const configured = s.google;
  if (sc.gscDaily.enabled && configured.gscProperty && h >= sc.gscDaily.hourUtc) out.push({ type: "gsc_sync", slot: day });
  if (sc.ga4Daily.enabled && configured.ga4PropertyId && h >= sc.ga4Daily.hourUtc) out.push({ type: "ga4_sync", slot: day });
  if (sc.technicalWeekly.enabled && dow === sc.technicalWeekly.weekday && h >= sc.technicalWeekly.hourUtc) out.push({ type: "technical_scan", slot: day });
  if (sc.recommendationsWeekly.enabled && dow === sc.recommendationsWeekly.weekday && h >= sc.recommendationsWeekly.hourUtc) out.push({ type: "recommendations", slot: day });
  if (sc.reportsWeekly.enabled && dow === sc.reportsWeekly.weekday && h >= sc.reportsWeekly.hourUtc) out.push({ type: "report_weekly", slot: day });
  if (sc.reportsMonthly.enabled && now.getUTCDate() === sc.reportsMonthly.dayOfMonth && h >= sc.reportsMonthly.hourUtc) out.push({ type: "report_monthly", slot: day.slice(0, 7) });
  if (h >= 2) out.push({ type: "retention", slot: day });
  if (h >= 9) out.push({ type: "outcomes", slot: day });
  return out;
}

/** Called from the worker tick: enqueue each due slot once (a slot that already has a run is never re-enqueued). */
export async function seoTick(now = new Date()): Promise<number> {
  const db = await getDb();
  const settings = await getSeoSettings();
  let queued = 0;
  for (const { type, slot } of dueSlots(settings, now)) {
    const seen = rowsOf<{ n: number }>(
      await db.execute(sql`select count(*)::int as n from seo_sync_jobs where job_type = ${type} and trigger = 'schedule' and detail->>'slot' = ${slot}`),
    );
    if (Number(seen[0]?.n ?? 0) > 0) continue;
    if (await enqueueSeoJob({ type, trigger: "schedule", slot })) queued++;
  }
  return queued;
}

/** Manual backfill: up to 16 months back, never in the future; split into resumable jobs. */
export function backfillRange(months: number, now = new Date(), timeZone = GSC_TIME_ZONE): { start: string; end: string } {
  const m = Math.min(16, Math.max(1, Math.round(months)));
  const end = addDays(dateIn(timeZone, now), -1);
  return { start: addMonths(end, -m), end };
}
