import { monitorEventLoopDelay } from "node:perf_hooks";
import { isProxyPass } from "./request-log";

/**
 * Prometheus metrics for the site, without extra dependencies.
 *
 * - HTTP request rate, errors and latency per route come from the server spans Next.js already creates
 *   (one `BaseServer.handleRequest` span per request, with method, status code and the route *pattern*,
 *   e.g. `/blog/[slug]`, so label values stay bounded). See `metricsSpanProcessor`.
 * - Process health (memory, CPU, event-loop delay) and a few counters (emails, comments).
 * - Site gauges read from the database at scrape time (cached 30 s).
 *
 * Served on a separate port (METRICS_PORT, default 9464; 0 = off) that is reachable only inside the
 * cluster (NetworkPolicy), never through the public ingress.
 * No `server-only` import: instrumentation.ts loads this outside the React server layer. The registry lives on
 * globalThis, so the instrumentation bundle and the app bundles share one set of counters.
 */

type Labels = Record<string, string>;
const DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const fmt = (labels: Labels) => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};

class Counter {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    const v = this.values.get(k) ?? { labels, value: 0 };
    v.value += by;
    this.values.set(k, v);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${fmt(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Histogram {
  private values = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}
  observe(labels: Labels, value: number) {
    const k = key(labels);
    const v = this.values.get(k) ?? { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((b, i) => {
      if (value <= b) v.buckets[i]! += 1;
    });
    v.sum += value;
    v.count += 1;
    this.values.set(k, v);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.values.values()) {
      this.bounds.forEach((b, i) => lines.push(`${this.name}_bucket${fmt({ ...labels, le: String(b) })} ${buckets[i]}`));
      lines.push(`${this.name}_bucket${fmt({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${fmt(labels)} ${sum}`);
      lines.push(`${this.name}_count${fmt(labels)} ${count}`);
    }
    return lines.join("\n");
  }
}

const gauge = (name: string, help: string, samples: { labels?: Labels; value: number }[]) =>
  [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples.map((s) => `${name}${fmt(s.labels ?? {})} ${s.value}`)].join("\n");

// One registry per process (survives hot reloads in development).
type Registry = {
  requests: Counter;
  duration: Histogram;
  mail: Counter;
  comments: Counter;
  loop: ReturnType<typeof monitorEventLoopDelay>;
};
const g = globalThis as unknown as { __metrics?: Registry };
function registry(): Registry {
  if (!g.__metrics) {
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    g.__metrics = {
      requests: new Counter("http_server_requests_total", "HTTP requests handled by Next.js, by method, route pattern and status code."),
      duration: new Histogram("http_server_request_duration_seconds", "Time to handle an HTTP request, by method and route pattern.", DURATION_BUCKETS),
      mail: new Counter("jithendar_mail_sent_total", "Transactional emails by provider and outcome."),
      comments: new Counter("jithendar_comments_submitted_total", "Comments and replies submitted, by resulting status."),
      loop,
    };
  }
  return g.__metrics;
}

/** Status code → class label ("2xx"…"5xx") keeps one series per class instead of per code. */
const statusClass = (code: unknown) => (typeof code === "number" && code >= 100 && code < 600 ? `${Math.floor(code / 100)}xx` : "unknown");

/** Route patterns only; anything else (e.g. static files without a route) is grouped. */
function routeLabel(route: unknown): string {
  if (route === "proxy") return route; // answered by src/proxy.ts (redirects, 410, maintenance 503)
  if (typeof route !== "string" || !route.startsWith("/") || route.length > 120) return "other";
  return route;
}

export function recordRequest(method: string, route: unknown, status: unknown, seconds: number) {
  const r = registry();
  const m = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method) ? method : "OTHER";
  const labels = { method: m, route: routeLabel(route) };
  r.requests.inc({ ...labels, status: statusClass(status) });
  r.duration.observe(labels, seconds);
}

export function recordMail(provider: string, outcome: "sent" | "failed" | "skipped") {
  registry().mail.inc({ provider, outcome });
}

export function recordComment(status: "approved" | "pending") {
  registry().comments.inc({ status });
}

// --- SEO intelligence platform (docs/seo) ---------------------------------------------------------------
// Labels are low-cardinality only: job type, provider, outcome, category. Never URLs, queries or property ids.

type SeoRegistry = {
  syncSuccess: Counter;
  syncFailure: Counter;
  syncDuration: Histogram;
  apiRequests: Counter;
  apiErrors: Counter;
  recommendations: Counter;
  llmRequests: Counter;
  llmErrors: Counter;
  contentAudits: Counter;
};
const gs = globalThis as unknown as { __seoMetrics?: SeoRegistry };
function seoRegistry(): SeoRegistry {
  gs.__seoMetrics ??= {
    syncSuccess: new Counter("seo_sync_success_total", "SEO sync/analysis runs that succeeded, by job type."),
    syncFailure: new Counter("seo_sync_failure_total", "SEO sync/analysis runs that failed, by job type and error code."),
    syncDuration: new Histogram("seo_sync_duration_seconds", "Duration of SEO sync/analysis runs, by job type.", [1, 5, 15, 30, 60, 120, 300, 600, 1200]),
    apiRequests: new Counter("seo_api_requests_total", "Requests to Google APIs, by provider and outcome."),
    apiErrors: new Counter("seo_api_errors_total", "Failed requests to Google APIs, by provider and outcome."),
    recommendations: new Counter("seo_recommendations_generated_total", "SEO recommendations created or refreshed, by category."),
    llmRequests: new Counter("seo_llm_requests_total", "LLM enrichment requests, by provider and outcome."),
    llmErrors: new Counter("seo_llm_errors_total", "Failed LLM enrichment requests, by provider and error code."),
    contentAudits: new Counter("seo_content_audits_total", "Article content audits run."),
  };
  return gs.__seoMetrics;
}

const SAFE_LABEL = /^[a-z0-9_]{1,40}$/;
const safe = (v: string) => (SAFE_LABEL.test(v) ? v : "other");

export function recordSeoSync(jobType: string, outcome: "success" | "failure" | "skipped", seconds: number, errorCode?: string) {
  const r = seoRegistry();
  if (outcome === "success") r.syncSuccess.inc({ job_type: safe(jobType) });
  if (outcome === "failure") r.syncFailure.inc({ job_type: safe(jobType), error_code: safe(errorCode ?? "unknown") });
  if (outcome !== "skipped") r.syncDuration.observe({ job_type: safe(jobType) }, seconds);
}

export function recordSeoApiRequest(provider: string, outcome: string) {
  const r = seoRegistry();
  r.apiRequests.inc({ provider: safe(provider), outcome: safe(outcome) });
  if (outcome !== "ok") r.apiErrors.inc({ provider: safe(provider), outcome: safe(outcome) });
}

export function recordSeoRecommendations(category: string, n = 1) {
  if (n > 0) seoRegistry().recommendations.inc({ category: safe(category) }, n);
}

export function recordSeoLlm(provider: string, outcome: "ok" | "invalid" | "error" | "cached", errorCode?: string) {
  const r = seoRegistry();
  r.llmRequests.inc({ provider: safe(provider), outcome });
  if (outcome === "invalid" || outcome === "error") r.llmErrors.inc({ provider: safe(provider), error_code: safe(errorCode ?? outcome) });
}

export function recordSeoContentAudit() {
  seoRegistry().contentAudits.inc();
}

function renderSeo(): string[] {
  const r = seoRegistry();
  return [r.syncSuccess, r.syncFailure, r.syncDuration, r.apiRequests, r.apiErrors, r.recommendations, r.llmRequests, r.llmErrors, r.contentAudits].map((m) => m.render());
}

/** The minimal SpanProcessor shape (avoids depending on @opentelemetry/sdk-trace-base directly). */
type EndedSpan = { attributes: Record<string, unknown>; duration: [number, number] };
export const metricsSpanProcessor = {
  onStart() {},
  onEnd(span: EndedSpan) {
    if (span.attributes["next.span_type"] !== "BaseServer.handleRequest" || isProxyPass(span.attributes)) return;
    const [s, ns] = span.duration;
    recordRequest(String(span.attributes["http.method"] ?? "OTHER"), span.attributes["next.route"] ?? span.attributes["http.route"], span.attributes["http.status_code"], s + ns / 1e9);
  },
  async shutdown() {},
  async forceFlush() {},
};

// --- Database gauges (cached) ---------------------------------------------------------------------

let dbCache: { at: number; text: string } | null = null;
async function databaseGauges(): Promise<string> {
  if (dbCache && Date.now() - dbCache.at < 30_000) return dbCache.text;
  try {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/db");
    const { rowsOf } = await import("@/db/rows");
    const db = await getDb();
    const one = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await db.execute(q))[0]?.n ?? 0);
    const [published, users, pending, reported] = await Promise.all([
      one(sql`select count(*)::int as n from post where status = 'published' and deleted_at is null`),
      one(sql`select count(*)::int as n from "user"`),
      one(sql`select count(*)::int as n from comment where status = 'pending' and deleted_at is null`),
      one(sql`select count(distinct comment_id)::int as n from comment_report where resolved_at is null`),
    ]);
    const jobs = rowsOf<{ status: string; n: number }>(await db.execute(sql`select status, count(*)::int as n from job group by status`));
    const text = [
      gauge("jithendar_posts_published", "Published posts.", [{ value: published }]),
      gauge("jithendar_users", "Registered accounts.", [{ value: users }]),
      gauge("jithendar_comments_pending", "Comments waiting for moderation.", [{ value: pending }]),
      gauge("jithendar_comments_reported", "Comments with open reports.", [{ value: reported }]),
      gauge("jithendar_jobs", "Background jobs by status.", jobs.map((j) => ({ labels: { status: j.status }, value: Number(j.n) }))),
      gauge("jithendar_database_up", "1 when the database answered the last metrics query.", [{ value: 1 }]),
    ].join("\n");
    const full = `${text}\n${await seoGauges(db, sql, rowsOf)}`;
    dbCache = { at: Date.now(), text: full };
    return full;
  } catch {
    return gauge("jithendar_database_up", "1 when the database answered the last metrics query.", [{ value: 0 }]);
  }
}

/**
 * SEO sync health from the database (survives restarts and is the same on every replica, unlike the counters):
 * consecutive failed runs since the last success and the last success time, per data job type. Separate try, so a
 * database without the SEO tables does not mark the whole database as down.
 */
async function seoGauges(db: Awaited<ReturnType<typeof import("@/db").getDb>>, sql: typeof import("drizzle-orm").sql, rowsOf: typeof import("@/db/rows").rowsOf): Promise<string> {
  try {
    const rows = rowsOf<{ job_type: string; failures: number; last_success: number | null }>(
      await db.execute(sql`
        select t.job_type,
          (select count(*)::int from seo_sync_jobs j where j.job_type = t.job_type and j.status = 'failed'
             and j.started_at > coalesce((select max(started_at) from seo_sync_jobs s where s.job_type = t.job_type and s.status in ('succeeded', 'partial')), 'epoch'::timestamptz)) as failures,
          (select extract(epoch from max(finished_at))::float8 from seo_sync_jobs s where s.job_type = t.job_type and s.status in ('succeeded', 'partial')) as last_success
        from (values ('gsc_sync'), ('ga4_sync'), ('technical_scan'), ('recommendations')) as t(job_type)`),
    );
    return [
      gauge("seo_sync_consecutive_failures", "Failed SEO runs since the last successful one, by job type (from the database).", rows.map((r) => ({ labels: { job_type: r.job_type }, value: Number(r.failures) }))),
      gauge("seo_sync_last_success_timestamp_seconds", "Unix time of the last successful SEO run, by job type (0 = never).", rows.map((r) => ({ labels: { job_type: r.job_type }, value: Number(r.last_success ?? 0) }))),
    ].join("\n");
  } catch {
    return "";
  }
}

// --- Cache bus (src/lib/cache-bus.ts) -----------------------------------------------------------------
// Fixed labels only: kind (5 cache kinds) and role (publisher | subscriber). cache_bus_connected exists only once the
// bus is configured (CACHE_BUS_REDIS_URL) and has created a connection, so the CacheBusDisconnected alert
// (max(...{role="subscriber"}) == 0) cannot fire on a deployment that runs without it.

type CacheBusRegistry = { published: Counter; received: Counter; errors: Counter; connected: Map<string, number> };
const gc = globalThis as unknown as { __cacheBusMetrics?: CacheBusRegistry };
function cacheBusRegistry(): CacheBusRegistry {
  gc.__cacheBusMetrics ??= {
    published: new Counter("cache_bus_published_total", "Cache invalidations published to the other replicas, by cache kind."),
    received: new Counter("cache_bus_received_total", "Cache invalidations received from another replica and applied, by cache kind."),
    errors: new Counter("cache_bus_errors_total", "Cache bus connection or publish errors, by role (publisher | subscriber)."),
    connected: new Map(),
  };
  return gc.__cacheBusMetrics;
}

export function recordCacheBusPublished(kind: string) {
  cacheBusRegistry().published.inc({ kind });
}

export function recordCacheBusReceived(kind: string) {
  cacheBusRegistry().received.inc({ kind });
}

export function recordCacheBusError(role: "publisher" | "subscriber") {
  cacheBusRegistry().errors.inc({ role });
}

export function setCacheBusConnected(role: "publisher" | "subscriber", up: boolean) {
  cacheBusRegistry().connected.set(role, up ? 1 : 0);
}

export function renderCacheBus(): string[] {
  const r = cacheBusRegistry();
  const parts = [r.published.render(), r.received.render(), r.errors.render()];
  if (r.connected.size) {
    parts.push(gauge("cache_bus_connected", "1 while the cache bus connection to Valkey is up, by role.", [...r.connected].map(([role, value]) => ({ labels: { role }, value }))));
  }
  return parts;
}

// --- Exposition --------------------------------------------------------------------------------------

export async function renderMetrics(): Promise<string> {
  const r = registry();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const parts = [
    gauge("jithendar_build_info", "Running version (commit).", [{ labels: { version: process.env.GIT_SHA ?? "dev", node: process.version }, value: 1 }]),
    gauge("process_start_time_seconds", "Process start time (Unix seconds).", [{ value: Math.round(Date.now() / 1000 - process.uptime()) }]),
    `# HELP process_cpu_seconds_total CPU time used by the process.\n# TYPE process_cpu_seconds_total counter\nprocess_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`,
    gauge("process_resident_memory_bytes", "Resident memory.", [{ value: mem.rss }]),
    gauge("nodejs_heap_used_bytes", "V8 heap in use.", [{ value: mem.heapUsed }]),
    gauge("nodejs_heap_total_bytes", "V8 heap allocated.", [{ value: mem.heapTotal }]),
    gauge("nodejs_eventloop_delay_p99_seconds", "Event-loop delay, 99th percentile since the last scrape.", [{ value: r.loop.percentile(99) / 1e9 }]),
    gauge("nodejs_eventloop_delay_max_seconds", "Event-loop delay, maximum since the last scrape.", [{ value: r.loop.max / 1e9 }]),
    r.requests.render(),
    r.duration.render(),
    r.mail.render(),
    r.comments.render(),
    ...renderSeo(),
    ...renderCacheBus(),
    await databaseGauges(),
  ];
  r.loop.reset();
  return parts.join("\n") + "\n";
}

/** Start the in-cluster metrics listener once per process. */
export async function startMetricsServer(): Promise<number | null> {
  const port = Number(process.env.METRICS_PORT ?? 9464);
  if (!Number.isInteger(port) || port <= 0) return null;
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url?.split("?")[0] !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    renderMetrics().then(
      (body) => res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" }).end(body),
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  server.unref();
  return port;
}
