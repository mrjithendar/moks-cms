import { connect as tlsConnect } from "node:tls";
import { desc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import { emailSummary } from "./mail";
import { getRedis } from "./redis";
import { cacheBusStatus, type BusStatus } from "./cache-bus";
import { indexNowKey } from "./indexnow-key";
import { resolveGeminiImageConfig } from "./integrations";
import { generationUsage } from "./image-generation";
import { checkStorage } from "./storage";
import { turnstileKeys } from "./turnstile";

/** What each check belongs to, in the order System status shows the groups. */
export const CHECK_GROUPS = ["Core", "Publishing", "SEO & AI", "Integrations", "Operations"] as const;
export type CheckGroup = (typeof CHECK_GROUPS)[number];

/**
 * One check. `href` is the settings page where it is configured (System status opens it in a new tab); `env` names
 * the deployment setting when it is configured there instead (the Kubernetes Secret or ConfigMap), not in the admin.
 */
export type Check = { name: string; status: "ok" | "degraded" | "down" | "not configured"; ms: number | null; detail: string; group: CheckGroup; href?: string; env?: string };
type Probe = Omit<Check, "name" | "ms" | "group" | "href" | "env">;

const TIMEOUT = 5000;

async function timed(name: string, where: { group: CheckGroup; href?: string; env?: string }, fn: () => Promise<Probe>): Promise<Check> {
  const started = performance.now();
  try {
    const r = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${TIMEOUT / 1000}s`)), TIMEOUT))]);
    return { name, ...where, ms: r.status === "not configured" ? null : Math.round(performance.now() - started), ...r };
  } catch (error) {
    return { name, ...where, status: "down", ms: Math.round(performance.now() - started), detail: (error as Error).message.slice(0, 200) };
  }
}

/**
 * Redis is optional. The site has run without it since 2026-11-09 (no REDIS_URL): Better Auth sessions and rate
 * limits live in Postgres and caches are per pod. An unset REDIS_URL is therefore the normal, healthy setup, not a
 * missing setting. Only a Redis that is configured but unreachable is a problem (the site still falls back to Postgres).
 */
export async function redisCheck(env: Record<string, string | undefined> = process.env, connect: typeof getRedis = getRedis): Promise<Probe> {
  if (!env.REDIS_URL?.trim()) return { status: "ok", detail: "Not used (by design): sessions and rate limits are in Postgres, caches are per pod. Cross-pod cache invalidation uses its own pub/sub-only connection (CACHE_BUS_REDIS_URL), not REDIS_URL." };
  const redis = await connect();
  if (!redis) return { status: "degraded", detail: "REDIS_URL is set but Redis is unreachable; falling back to Postgres and per-pod caches" };
  await redis.ping();
  const used = (await redis.info("memory")).match(/used_memory_human:(\S+)/)?.[1];
  return { status: "ok", detail: `PONG · ${used ?? "?"} used` };
}

/**
 * Cross-replica cache invalidation (src/lib/cache-bus.ts). Reads the bus's in-memory connection state only: no Redis
 * command, so this check is instant and cannot hang. Never "down": without the bus the site works and each pod's
 * caches converge within their TTL. Readiness (/api/health) does not look at it at all.
 */
export function cacheBusCheck(s: BusStatus = cacheBusStatus()): Probe {
  const via = s.source === "REDIS_URL" ? " (via REDIS_URL)" : "";
  switch (s.state) {
    case "not configured":
      return { status: "not configured", detail: "cache bus: not configured (CACHE_BUS_REDIS_URL unset): an edit shows on the other pod after the cache TTL" };
    case "connected":
      return { status: "ok", detail: `cache bus: connected${via} · publisher and subscriber on Valkey pub/sub: edits reach every pod within about a second` };
    case "connecting":
      return { status: "degraded", detail: `cache bus: connecting${via}` };
    default:
      return {
        status: "degraded",
        detail: `cache bus: disconnected${via} (publisher ${s.publisher ? "up" : "down"}, subscriber ${s.subscriber ? "up" : "down"}); reconnecting with backoff, caches fall back to their TTL`,
      };
  }
}

async function reachable(url: string): Promise<Probe> {
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT), redirect: "manual" });
  return { status: res.status < 500 ? "ok" : "degraded", detail: `HTTP ${res.status}` };
}

function certificateDays(host: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: TIMEOUT }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      resolve({ status: days > 14 ? "ok" : days > 0 ? "degraded" : "down", detail: `expires ${cert.valid_to} (${days} days)` });
    });
    socket.on("error", reject);
    socket.on("timeout", () => socket.destroy(new Error("TLS timeout")));
  });
}

/** Live status of everything the site depends on (admin only; makes real outbound requests). */
export async function systemChecks(): Promise<{ app: Record<string, string>; checks: Check[] }> {
  const mem = process.memoryUsage();
  const app = {
    Version: process.env.GIT_SHA?.slice(0, 12) ?? "dev",
    "Node.js": process.version,
    Uptime: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
    Memory: `${Math.round(mem.rss / 1024 / 1024)} MB RSS · ${Math.round(mem.heapUsed / 1024 / 1024)} MB heap`,
    Environment: process.env.APP_ENV ?? "development",
  };

  const checks = await Promise.all([
    timed("PostgreSQL", { group: "Core", href: "/admin/database" }, async () => {
      const db = await getDb();
      const [r] = rowsOf<{ version: string; size: string; conns: number }>(
        await db.execute(sql`select split_part(version(), ' ', 2) as version, pg_size_pretty(pg_database_size(current_database())) as size, (select count(*)::int from pg_stat_activity where datname = current_database()) as conns`),
      );
      const [m] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from schema_migrations`));
      return { status: "ok", detail: `v${r?.version} · ${r?.size} · ${r?.conns} connections · ${m?.n} migrations` };
    }),
    timed("Redis (optional)", { group: "Core", env: "REDIS_URL" }, () => redisCheck()),
    timed("Cache bus (Valkey pub/sub)", { group: "Core", env: "CACHE_BUS_REDIS_URL or REDIS_URL" }, async () => cacheBusCheck()),
    timed("Media storage", { group: "Core", href: "/admin/storage" }, checkStorage),
    timed("Scheduled publishing & IndexNow", { group: "Publishing", href: "/admin/posts?status=scheduled" }, async () => {
      const db = await getDb();
      const [r] = rowsOf<{ scheduled: number; overdue: number }>(
        await db.execute(sql`select count(*)::int as scheduled, count(*) filter (where published_at < now() - interval '5 minutes')::int as overdue from post where status = 'scheduled' and deleted_at is null`),
      );
      const { jobSummary } = await import("./jobs");
      const jobs = await jobSummary();
      const overdue = Number(r?.overdue ?? 0);
      return {
        status: overdue > 0 || (jobs.failed ?? 0) > 0 ? "degraded" : "ok",
        detail: `${r?.scheduled ?? 0} scheduled${overdue ? `, ${overdue} overdue (worker not running?)` : ""} · IndexNow ${(await indexNowKey()) ? "on" : "off"}: last 7 days ${jobs.done ?? 0} sent, ${jobs.queued ?? 0} queued, ${jobs.failed ?? 0} failed`,
      };
    }),
    timed("Image generation (Gemini)", { group: "Integrations", href: "/admin/integrations" }, async () => {
      const c = await resolveGeminiImageConfig();
      if (!c) return { status: "not configured", detail: "add a Gemini API key in Admin → Integrations to enable “Generate image”" };
      const usage = await generationUsage();
      const total = Object.values(usage).reduce((a, b) => a + b, 0);
      const failed = (usage.failed ?? 0) + (usage.cancelled ?? 0);
      // No live call: every request to the model costs money. Failures in the last day show here instead.
      return { status: total > 2 && failed / total > 0.5 ? "degraded" : "ok", detail: `${c.model} · ${c.imageSize} · last 24 h: ${total} request(s), ${usage.accepted ?? 0} accepted, ${failed} failed/cancelled` };
    }),
    timed("Email", { group: "Integrations", href: "/admin/email" }, async () => {
      // Status from saved settings only: a live check would send an email.
      const e = await emailSummary();
      if (e.envFallback) return { status: "ok", detail: "SMTP from the deployment (SMTP_URL)" };
      if (e.active === "disabled") return { status: "not configured", detail: "disabled: verification, reset and contact emails are skipped" };
      const p = e.providers[e.active];
      const label = { smtp: "SMTP", mailgun: "Mailgun", ses: "Amazon SES" }[e.active];
      if (p.lastError) return { status: "degraded", detail: `${label} · ${String(p.fields.fromEmail)} · last test failed` };
      return { status: "ok", detail: `${label} · ${String(p.fields.fromEmail)} · ${p.testedAt ? "test email succeeded" : "not tested yet"}` };
    }),
    timed("Cloudflare Turnstile", { group: "Integrations", href: "/admin/integrations?section=turnstile" }, async () => {
      const t = await turnstileKeys();
      if (!t.siteKey || !t.secret) return { status: "down", detail: "keys missing (Admin → Integrations → Turnstile): sign-in, comments and contact are blocked" };
      const r = await reachable("https://challenges.cloudflare.com/turnstile/v0/api.js");
      return { ...r, detail: `${t.production ? "production keys" : "test keys"} · ${r.detail}` };
    }),
    timed("Breached-password check", { group: "Integrations" }, () => reachable("https://api.pwnedpasswords.com/range/21BD1")),
    timed("Trace collector", { group: "Operations", env: "OTEL_EXPORTER_OTLP_ENDPOINT" }, async () => {
      const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      if (!endpoint) return { status: "not configured", detail: "tracing off" };
      const r = await reachable(`${endpoint.replace(/\/$/, "")}/v1/traces`);
      return { status: "ok", detail: `${endpoint} · ${r.detail}` };
    }),
    timed("TLS certificate", { group: "Operations" }, () => certificateDays("jithendar.com")),
    timed("Backups", { group: "Operations", href: "/admin/backups" }, async () => {
      const db = await getDb();
      const [last] = await db.select().from(schema.backupRun).orderBy(desc(schema.backupRun.startedAt)).limit(1);
      if (!last) return { status: "not configured", detail: "no backup has run yet" };
      const ageH = Math.round((Date.now() - last.startedAt.getTime()) / 3_600_000);
      return { status: last.status === "success" ? (ageH < 8 * 24 ? "ok" : "degraded") : last.status === "partial" ? "degraded" : "down", detail: `last ${last.status}, ${ageH}h ago` };
    }),
    ...extraChecks(),
  ]);
  return { app, checks };
}

/** Flows whose latest run in the last 24 hours failed, with the error (the agent is "degraded" only for these). */
export async function failingFlows(): Promise<{ flow: string; at: string; error: string }[]> {
  const db = await getDb();
  return rowsOf<{ flow: string; at: string; error: string | null }>(
    await db.execute(sql`
      select distinct on (flow_name) flow_name as flow, finished_at::text as at, error, status from seo_flow_runs
      where finished_at > now() - interval '24 hours' order by flow_name, finished_at desc`),
  )
    .filter((r) => (r as unknown as { status: string }).status === "failed")
    .map((r) => ({ flow: r.flow, at: r.at.slice(0, 16).replace("T", " "), error: (r.error ?? "no error recorded").slice(0, 160) }));
}

/** The checks added on 2026-11-18 (owner request: "add all the required checks", each with its settings page). */
function extraChecks(): Promise<Check>[] {
  return [
    timed("SEO agent (CrewAI flows)", { group: "SEO & AI", href: "/admin/automation?section=overview" }, async () => {
      const { agentStatus } = await import("./seo-agent/endpoint");
      const { agentToken } = await import("./seo-agent/config");
      const s = await agentStatus();
      if (!s.enabled) return { status: "not configured", detail: `${s.reason} The web worker runs the SEO jobs itself.` };
      if (!agentToken()) return { status: "down", detail: s.reason };
      const { agentReady } = await import("./seo-agent/client");
      const ready = await agentReady().catch((e: Error) => ({ status: `unreachable: ${e.message}` }));
      if (ready.status !== "ready") return { status: "down", detail: `agent ${ready.status}` };
      const failing = await failingFlows().catch(() => []);
      if (failing.length) return { status: "degraded", detail: `ready · latest run failed in the last 24 h: ${failing.map((f) => `${f.flow} (${f.at} UTC: ${f.error})`).join("; ")}` };
      return { status: "ok", detail: "ready · no flow's latest run failed in the last 24 h" };
    }),
    timed("Claude (AI drafting)", { group: "SEO & AI", href: "/admin/automation?section=llm#llm-providers" }, async () => {
      const { claudeConfig, getSeoSettings } = await import("./seo-intel/settings");
      const c = claudeConfig(await getSeoSettings());
      if (!c.apiKey) return { status: "not configured", detail: "ANTHROPIC_API_KEY is not set: drafting, Improve and reviews use rules only" };
      return { status: "ok", detail: "key set" };
    }),
    ...(["gsc", "ga4"] as const).map((p) =>
      timed(p === "gsc" ? "Search Console sync" : "Google Analytics 4 sync", { group: "SEO & AI", href: "/admin/integrations" }, async () => {
        const { integrationsView } = await import("./seo-intel/queries");
        const st = (await integrationsView()).status[p];
        const status = st.state === "ok" ? "ok" : st.state === "disconnected" ? "not configured" : st.state === "stale" || st.state === "never_synced" ? "degraded" : "down";
        return { status, detail: st.message };
      }),
    ),
    timed("LLM budget", { group: "SEO & AI", href: "/admin/automation?section=llm#llm-budget" }, async () => {
      // The one budget lives in the seo-agent. No limit at all is reported as degraded: nothing then stops LLM spending.
      const { loadLlmBudget } = await import("./llm-budget-view");
      const { view, error, tooOld } = await loadLlmBudget("month");
      if (!view) return { status: tooOld ? "degraded" : "not configured", detail: (error ?? "the SEO agent could not be asked").slice(0, 160) };
      const { daily_usd: day, monthly_usd: month } = view.budget;
      if (day === null && month === null) return { status: "degraded", detail: "no daily or monthly limit is set: nothing stops LLM spending" };
      const used = view.limit_usd !== null && view.spent_usd >= view.limit_usd;
      const limits = [day !== null ? `$${day} a day` : null, month !== null ? `$${month} a month` : null].filter(Boolean).join(" · ");
      return { status: used ? "degraded" : "ok", detail: `${limits} · $${view.spent_usd.toFixed(2)} spent this month${used ? " · the monthly limit is reached: LLM calls are refused" : ""}` };
    }),
    timed("ML models", { group: "SEO & AI", href: "/admin/models" }, async () => {
      const db = await getDb();
      const rows = rowsOf<{ kind: string; trained_at: string }>(await db.execute(sql`select kind, trained_at::text from seo_ml_models where active order by kind`));
      if (!rows.length) return { status: "not configured", detail: "no model is active: rules are used everywhere" };
      const oldest = rows.reduce((a, b) => (a.trained_at < b.trained_at ? a : b));
      const days = Math.round((Date.now() - Date.parse(oldest.trained_at)) / 86_400_000);
      return { status: days > 45 ? "degraded" : "ok", detail: `${rows.length} active (${rows.map((r) => r.kind).join(", ")}) · oldest trained ${days} day(s) ago` };
    }),
    timed("Content flows", { group: "Publishing", href: "/admin/crewai/flows#content-switch" }, async () => {
      const { newsDeskState } = await import("./news/schema");
      const { getNewsSettings } = await import("./news/service");
      const desk = newsDeskState(await getNewsSettings().catch(() => null));
      if (!desk.on) return { status: "not configured", detail: desk.by === "deployment_off" ? "switched off by the deployment (NEWS_DESK_ENABLED=false)" : "switched off (AI & SEO → Flows)" };
      const db = await getDb();
      const [r] = rowsOf<{ total: number; failed: number }>(await db.execute(sql`select count(*)::int as total, count(*) filter (where status = 'failed')::int as failed from news_runs where created_at > now() - interval '24 hours'`));
      const total = Number(r?.total ?? 0);
      const failed = Number(r?.failed ?? 0);
      return { status: total > 0 && failed / total > 0.5 ? "degraded" : "ok", detail: `on · last 24 h: ${total} run(s), ${failed} failed` };
    }),
    timed("Editorial calendar", { group: "Publishing", href: "/admin/calendar?phase=scheduled" }, async () => {
      const db = await getDb();
      const [r] = rowsOf<{ dated: number; waiting: number; overdue: number }>(
        await db.execute(sql`
          select count(*)::int as dated,
            count(*) filter (where p.status is distinct from 'scheduled')::int as waiting,
            count(*) filter (where p.status is distinct from 'scheduled' and c.target_date < (now() at time zone 'Asia/Kolkata')::date)::int as overdue
          from seo_editorial_calendar c left join post p on p.id = c.post_id and p.deleted_at is null
          where c.target_date is not null and c.status not in ('published', 'dropped')`),
      );
      const overdue = Number(r?.overdue ?? 0);
      return { status: overdue ? "degraded" : "ok", detail: `${r?.dated ?? 0} dated item(s) · ${r?.waiting ?? 0} not scheduled yet (draft missing or not reviewed)${overdue ? ` · ${overdue} past their date` : ""}` };
    }),
    timed("Background jobs", { group: "Operations", href: "/admin/sync" }, async () => {
      const db = await getDb();
      const [r] = rowsOf<{ queued: number; failed: number; oldest: number | null }>(
        await db.execute(sql`select count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::int as failed, (extract(epoch from now() - min(created_at) filter (where status = 'queued')) / 60)::int as oldest from job`),
      );
      const oldest = Number(r?.oldest ?? 0);
      return { status: oldest > 60 || Number(r?.failed ?? 0) > 0 ? "degraded" : "ok", detail: `${r?.queued ?? 0} queued${oldest ? ` (oldest ${oldest} min)` : ""} · ${r?.failed ?? 0} failed in 24 h` };
    }),
    timed("Social sign-in", { group: "Integrations", href: "/admin/integrations" }, async () => {
      const { activeProviders } = await import("./integrations");
      const p = await activeProviders();
      return p.length ? { status: "ok", detail: p.map((x) => (x === "github" ? "GitHub" : "Google")).join(", ") } : { status: "not configured", detail: "email and password only" };
    }),
    timed("Payments (Razorpay)", { group: "Integrations", href: "/admin/payments" }, async () => {
      const { razorpayKeys } = await import("./razorpay");
      const k = razorpayKeys(process.env);
      if (!k.keyId && !k.keySecret) return { status: "not configured", detail: "paid bookings and invoice payment links are off" };
      if (!k.keyId || !k.keySecret || !k.webhookSecret) return { status: "degraded", detail: "only some keys are set: payments may fail or go unconfirmed" };
      return { status: "ok", detail: `keys set (${k.keyId.startsWith("rzp_live_") ? "live" : "test"} mode) · webhook secret set` };
    }),
  ];
}
