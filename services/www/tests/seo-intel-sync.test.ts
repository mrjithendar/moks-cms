import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { migrateDb, migrationsDir } from "@/db/migrate";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { NOW } from "./helpers";
import { fakeGoogle, FIXTURE_ENV, settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");
const { runSeoJob, acquireLease, releaseLease, seoTick, dueSlots, backfillRange, gscWindow } = await import("@/lib/seo-intel/jobs");
const { normalizeUrl } = await import("@/lib/seo-intel/urls");
const { clearTokenCache, readServiceAccount, signJwt } = await import("@/lib/seo-intel/google/auth");
const { backoffDelay, googleJson } = await import("@/lib/seo-intel/google/http");
const { syncGa4Window } = await import("@/lib/seo-intel/sync");
const { renderMetrics } = await import("@/lib/metrics");

let db: Db;
const noSleep = async () => {};
const deps = (g = fakeGoogle()) => ({ fetchImpl: g.fetch, sleep: noSleep, now: () => NOW, env: FIXTURE_ENV });

async function configure(overrides = {}) {
  await saveSeoSettings(settingsInput(overrides), "admin");
}

const count = async (table: string) => Number(rowsOf<{ n: number }>(await db.execute(sql.raw(`select count(*)::int as n from ${table}`)))[0]!.n);
/** Table contents without synced_at, sorted: what idempotency compares. */
async function snapshot(table: string) {
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql.raw(`select * from ${table}`)));
  return rows.map((r) => JSON.stringify({ ...r, synced_at: undefined })).sort();
}

beforeEach(async () => {
  clearTokenCache();
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
});
afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
});

describe("migration 0011", () => {
  it("applies, rolls back and re-applies on a clean database without touching other tables", async () => {
    const pg = new PGlite();
    const clean = drizzle(pg, { schema }) as unknown as Db;
    await migrateDb(clean);
    // Only the tables 0011 itself creates (later migrations add more seo_* tables of their own).
    const own = new Set([...fs.readFileSync(path.resolve(migrationsDir(), "0011_seo_intelligence.sql"), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS "(seo_[a-z0-9_]+)"/g)].map((m) => m[1]!));
    const seoTables = async () => rowsOf<{ t: string }>(await clean.execute(sql`select table_name as t from information_schema.tables where table_name like 'seo\\_%' order by 1`)).map((r) => r.t).filter((t) => own.has(t));
    const allTables = async () => rowsOf<{ t: string }>(await clean.execute(sql`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`)).map((r) => r.t);
    expect(await seoTables()).toContain("seo_gsc_daily_totals");
    expect((await seoTables()).length).toBe(18);
    // Rollbacks run newest first: 0015 references seo_editorial_calendar (v3 new-article drafts, ask gaps).
    const script = (f: string) => fs.readFileSync(path.resolve(migrationsDir(), `../rollback/${f}`), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const stmt of script("0015_seo_agent.down.sql")) await clean.execute(sql.raw(stmt));
    const before = (await allTables()).filter((t) => !own.has(t));
    for (const stmt of script("0011_seo_intelligence.down.sql")) await clean.execute(sql.raw(stmt));
    expect(await seoTables()).toEqual([]);
    expect(await allTables()).toEqual(before);
    expect(await migrateDb(clean)).toEqual(["0011_seo_intelligence.sql", "0015_seo_agent.sql"]);
    expect((await seoTables()).length).toBe(18);
    await pg.close();
  });
});

describe("URL normalisation", () => {
  const origin = new URL("https://jithendar.com");
  it.each([
    ["http://www.jithendar.com/blog/Argo-CD/", "https://jithendar.com/blog/argo-cd"],
    ["https://jithendar.com/blog/x?utm_source=a#top", "https://jithendar.com/blog/x"],
    ["/news/eks?page=2", "https://jithendar.com/news/eks"],
    ["https://jithendar.com", "https://jithendar.com/"],
    ["https://jithendar.com//blog//a", "https://jithendar.com/blog/a"],
    ["https://grafana.jithendar.com/d/x", "https://grafana.jithendar.com/d/x"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeUrl(raw, origin)?.url).toBe(expected);
  });
  it("rejects non-http and garbage", () => {
    expect(normalizeUrl("javascript:alert(1)", origin)).toBeNull();
    expect(normalizeUrl("(not set)", origin)).toBeNull();
  });
});

describe("service-account auth", () => {
  it("reads raw and base64 keys, signs an RS256 JWT, and never puts the key in errors", () => {
    const sa = readServiceAccount(FIXTURE_ENV)!;
    expect(sa.clientEmail).toMatch(/@fixture-project/);
    expect(readServiceAccount({ GOOGLE_SEO_SERVICE_ACCOUNT_JSON: Buffer.from(FIXTURE_ENV.GOOGLE_SEO_SERVICE_ACCOUNT_JSON).toString("base64") })!.clientEmail).toBe(sa.clientEmail);
    expect(readServiceAccount({})).toBeNull();
    const jwt = signJwt(sa, "scope-x", 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ iss: sa.clientEmail, scope: "scope-x", exp: 1_700_003_600 });
    expect(s!.length).toBeGreaterThan(100);
    try {
      readServiceAccount({ GOOGLE_SEO_SERVICE_ACCOUNT_JSON: '{"type":"user","private_key":"SECRET-PEM"}' });
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET-PEM");
    }
  });

  it("backs off with jitter on 429/5xx and stops on 401/403", async () => {
    expect(backoffDelay(3, () => 0.999)).toBeLessThan(8000);
    expect(backoffDelay(10, () => 0.999)).toBeLessThan(32_000);
    const g = fakeGoogle({ failures: [429, 503] });
    const stats = { apiRequests: 0, retries: 0 };
    const sa = readServiceAccount(FIXTURE_ENV)!;
    const ctx = { sa, scope: "s", provider: "gsc" as const, stats, maxRequests: 10, fetchImpl: g.fetch, sleep: noSleep };
    await googleJson(ctx, "https://searchconsole.googleapis.com/webmasters/v3/sites/x/searchAnalytics/query", { startDate: "2026-10-01", endDate: "2026-10-01", dimensions: ["date"], type: "web", rowLimit: 1 });
    expect(stats).toEqual({ apiRequests: 3, retries: 2 });
    const denied = fakeGoogle({ failures: [403] });
    await expect(googleJson({ ...ctx, fetchImpl: denied.fetch, stats: { apiRequests: 0, retries: 0 } }, "https://x/searchAnalytics/query", {})).rejects.toMatchObject({ code: "auth", status: 403 });
  });
});

describe("Search Console sync", () => {
  it("is skipped (not failed) without credentials or property", async () => {
    const r1 = await runSeoJob({ type: "gsc_sync", trigger: "manual" }, { ...deps(), env: {} });
    expect(r1).toMatchObject({ status: "skipped", errorCode: "not_configured" });
    await configure();
    const r2 = await runSeoJob({ type: "gsc_sync", trigger: "manual" }, { ...deps(), env: {} });
    expect(r2).toMatchObject({ status: "skipped", errorCode: "not_configured" });
  });

  it("syncs the trailing window, keeps totals from the date-only request, and is idempotent", async () => {
    await configure();
    const g = fakeGoogle();
    const r = await runSeoJob({ type: "gsc_sync", trigger: "schedule" }, deps(g));
    expect(r.status).toBe("succeeded");
    // 4-day trailing window ending yesterday in Pacific time (NOW = 2026-10-27 05:00 PT).
    expect(r.window).toEqual({ start: "2026-10-23", end: "2026-10-26" });
    const job = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_sync_jobs where id = ${r.id}`))[0]!;
    expect(job).toMatchObject({ status: "succeeded", trigger: "schedule", api_requests: 3, retries: 0 });
    expect(Number(job.rows_written)).toBeGreaterThan(0);
    expect(job.correlation_id).toBe(r.correlationId);

    // Totals: 4 days of web data, from the date-only request (larger than the sum of query rows).
    const totals = rowsOf<{ clicks: number }>(await db.execute(sql`select sum(clicks)::int as clicks from seo_gsc_daily_totals`))[0]!;
    const fromQueries = rowsOf<{ clicks: number }>(await db.execute(sql`select sum(clicks)::int as clicks from seo_gsc_query_daily`))[0]!;
    expect(Number(totals.clicks)).toBe(5000 * 4 + 23 + 24 + 25 + 26);
    expect(Number(fromQueries.clicks)).toBeLessThan(Number(totals.clicks));

    // URL variants merged: http://www…/ and https://… are one page; query strings are gone.
    const pages = rowsOf<{ page: string }>(await db.execute(sql`select distinct page from seo_gsc_page_daily order by 1`)).map((p) => p.page);
    expect(pages).toEqual(["https://jithendar.com/", "https://jithendar.com/blog/argo-cd-gitops", "https://jithendar.com/blog/terraform-state", "https://jithendar.com/news/eks-upgrade"]);
    const argo = rowsOf<{ clicks: number }>(await db.execute(sql`select clicks::int from seo_gsc_page_daily where page = 'https://jithendar.com/blog/argo-cd-gitops' and date = '2026-10-23' and device = 'mobile'`))[0]!;
    expect(Number(argo.clicks)).toBe(80 + 4);
    // Provisional flag from metadata.firstIncompleteDate.
    const states = rowsOf<{ date: string; data_state: string }>(await db.execute(sql`select distinct date::text, data_state from seo_gsc_daily_totals order by 1`));
    expect(states.at(-1)).toEqual({ date: "2026-10-26", data_state: "provisional" });
    expect(states[0]!.data_state).toBe("final");
    expect(await count("seo_url_map")).toBe(4);

    const before = { t: await snapshot("seo_gsc_daily_totals"), p: await snapshot("seo_gsc_page_daily"), q: await snapshot("seo_gsc_query_daily") };
    await runSeoJob({ type: "gsc_sync", trigger: "manual" }, deps());
    expect({ t: await snapshot("seo_gsc_daily_totals"), p: await snapshot("seo_gsc_page_daily"), q: await snapshot("seo_gsc_query_daily") }).toEqual(before);
  });

  it("prunes rows that Google no longer reports when a window is re-synced", async () => {
    await configure();
    await runSeoJob({ type: "gsc_sync", trigger: "manual" }, deps());
    const n = await count("seo_gsc_page_daily");
    await runSeoJob({ type: "gsc_sync", trigger: "manual" }, { ...deps(fakeGoogle({ dropPage: "https://jithendar.com/blog/terraform-state" })), now: () => new Date(NOW.getTime() + 1000) });
    expect(await count("seo_gsc_page_daily")).toBe(n - 4 * 2);
  });

  it("paginates with startRow/rowLimit and loops over configured search types", async () => {
    await configure({ sync: { ...settingsInput().sync, rowLimit: 100 }, google: { ...settingsInput().google, searchTypes: ["web", "discover"] } });
    const g = fakeGoogle({ extraPages: 20 });
    const r = await runSeoJob({ type: "gsc_sync", trigger: "manual" }, deps(g));
    expect(r.status).toBe("succeeded");
    const pageCalls = g.calls.filter((c) => (c.body.dimensions as string[] | undefined)?.length === 4 && c.body.type === "web");
    expect(pageCalls.map((c) => c.body.startRow)).toEqual([0, 100, 200]);
    expect(g.calls.some((c) => c.body.type === "discover" && (c.body.dimensions as string[]).includes("query"))).toBe(false);
    expect(g.calls.some((c) => c.body.type === "discover" && (c.body.dimensions as string[]).includes("device"))).toBe(false);
    // Discover has no position (stored as NULL, not 0) and no device breakdown.
    const disc = rowsOf<{ position: number | null; device: string; country: string }>(await db.execute(sql`select position, device, country from seo_gsc_page_daily where search_type = 'discover' limit 1`))[0]!;
    expect(disc.position).toBeNull();
    expect(disc.device).toBe("(not set)");
    expect(disc.country).toBe("ind");
  });

  it("records retries and stops cleanly on an auth error", async () => {
    await configure();
    const retried = await runSeoJob({ type: "gsc_sync", trigger: "manual" }, deps(fakeGoogle({ failures: [429, 500] })));
    expect(retried.status).toBe("succeeded");
    const row = rowsOf<{ retries: number }>(await db.execute(sql`select retries from seo_sync_jobs where id = ${retried.id}`))[0]!;
    expect(row.retries).toBe(2);

    const denied = await runSeoJob({ type: "gsc_sync", trigger: "manual" }, deps(fakeGoogle({ failures: [403] })));
    expect(denied).toMatchObject({ status: "failed", errorCode: "auth" });
    const integ = rowsOf<{ status: string; last_error: string }>(await db.execute(sql`select status, last_error from seo_integrations where provider = 'gsc'`))[0]!;
    expect(integ.status).toBe("auth_error");
    expect(integ.last_error).not.toMatch(/fixture-token|PRIVATE KEY/);

  });

  it("backfills a manual range in 7-day windows; schedules never backfill", async () => {
    await configure();
    const g = fakeGoogle();
    const r = await runSeoJob({ type: "gsc_backfill", trigger: "backfill", start: "2026-09-01", end: "2026-09-30" }, deps(g));
    expect(r.status).toBe("succeeded");
    const days = rowsOf<{ n: number }>(await db.execute(sql`select count(distinct date)::int as n from seo_gsc_daily_totals`))[0]!;
    expect(days.n).toBe(30);
    expect(g.calls.filter((c) => (c.body.dimensions as string[] | undefined)?.length === 1).length).toBe(5); // 7+7+7+7+2 days
    const s = await getSeoSettings();
    for (const hour of [0, 6, 12, 23]) {
      const at = new Date(Date.UTC(2026, 10, 2, hour));
      expect(dueSlots(s, at).map((d) => d.type)).not.toContain("gsc_backfill");
    }
    expect(backfillRange(40, NOW)).toEqual({ start: "2025-06-26", end: "2026-10-26" });
    expect(gscWindow(s, { type: "gsc_sync", trigger: "schedule" }, NOW)).toEqual({ start: "2026-10-23", end: "2026-10-26" });
  });
});

describe("GA4 sync", () => {
  it("merges landing-page variants, keeps sessions separate from clicks, records the property time zone, and is idempotent", async () => {
    await configure();
    const r = await runSeoJob({ type: "ga4_sync", trigger: "manual" }, deps());
    expect(r.status).toBe("succeeded");
    const pages = rowsOf<{ landing_page: string }>(await db.execute(sql`select distinct landing_page from seo_ga4_page_daily order by 1`)).map((p) => p.landing_page);
    expect(pages).toContain("https://jithendar.com/news/eks-upgrade");
    expect(pages.some((p) => p.includes("?"))).toBe(false);
    const merged = rowsOf<{ sessions: number; engagement_rate: number }>(
      await db.execute(sql`select sessions::int, engagement_rate from seo_ga4_page_daily where landing_page = 'https://jithendar.com/blog/argo-cd-gitops' and channel_group = 'Organic Search' limit 1`),
    )[0]!;
    expect(merged.sessions).toBe((40 + 2) * 3);
    const tz = rowsOf<{ config: { timeZone: string } }>(await db.execute(sql`select config from seo_integrations where provider = 'ga4'`))[0]!;
    expect(tz.config.timeZone).toBe("Asia/Kolkata");
    const before = await snapshot("seo_ga4_page_daily");
    await runSeoJob({ type: "ga4_sync", trigger: "manual" }, deps());
    expect(await snapshot("seo_ga4_page_daily")).toEqual(before);
  });

  it("paginates and stops early (partial) when the property's token quota is low", async () => {
    await configure();
    const g = fakeGoogle({ ga4TokensRemaining: 100 });
    const sa = readServiceAccount(FIXTURE_ENV)!;
    const ctx = { sa, scope: "s", provider: "ga4" as const, stats: { apiRequests: 0, retries: 0 }, maxRequests: 50, fetchImpl: g.fetch, sleep: noSleep };
    const r = await syncGa4Window(db, ctx, "123", { start: "2026-10-20", end: "2026-10-26" }, NOW, 10);
    expect(r).toMatchObject({ partial: true });
    expect(r.note).toMatch(/tokensPerDay/);
    expect(ctx.stats.apiRequests).toBe(1);
    const full = await syncGa4Window(db, { ...ctx, fetchImpl: fakeGoogle().fetch, stats: { apiRequests: 0, retries: 0 } }, "123", { start: "2026-10-20", end: "2026-10-26" }, NOW, 10);
    expect(full.partial).toBe(false);
    expect(await count("seo_ga4_page_daily")).toBe(7 * 4 * 2);
  });
});

describe("scheduling and locking", () => {
  it("allows one lease per job type; expired leases can be taken over", async () => {
    expect(await acquireLease(db, "gsc_sync", "a", NOW)).toBe(true);
    expect(await acquireLease(db, "gsc_sync", "b", NOW)).toBe(false);
    expect(await acquireLease(db, "ga4_sync", "b", NOW)).toBe(true);
    expect(await acquireLease(db, "gsc_sync", "b", new Date(NOW.getTime() + 11 * 60_000))).toBe(true);
    await releaseLease(db, "gsc_sync", "a"); // not the holder any more: no effect
    expect(await acquireLease(db, "gsc_sync", "c", new Date(NOW.getTime() + 12 * 60_000))).toBe(false);
  });

  it("skips a run while another of the same type holds the lease", async () => {
    await configure();
    await acquireLease(db, "gsc_sync", "other-replica", new Date());
    const r = await runSeoJob({ type: "gsc_sync", trigger: "manual" }, { ...deps(), now: () => new Date() });
    expect(r).toMatchObject({ status: "skipped", errorCode: "locked" });
  });

  it("enqueues each scheduled slot once", async () => {
    await configure();
    const at = new Date("2026-11-02T08:30:00Z"); // Monday 08:30 UTC
    const first = await seoTick(at);
    expect(first).toBeGreaterThan(0);
    expect(await seoTick(at)).toBe(0);
    const kinds = rowsOf<{ t: string }>(await db.execute(sql`select payload->>'type' as t from job where kind = 'seo' order by 1`)).map((r) => r.t);
    expect(kinds).toEqual(expect.arrayContaining(["gsc_sync", "ga4_sync", "technical_scan", "recommendations", "report_weekly", "retention"]));
    expect(kinds).not.toContain("gsc_backfill");
  });

  it("applies the retention policy to the daily tables only", async () => {
    await configure();
    await db.execute(sql`insert into seo_gsc_daily_totals (date, search_type, clicks, impressions, ctr, position) values ('2024-01-01', 'web', 1, 1, 1, 1), ('2026-10-01', 'web', 1, 1, 1, 1)`);
    const r = await runSeoJob({ type: "retention", trigger: "schedule" }, deps());
    expect(r).toMatchObject({ status: "succeeded", rows: 1 });
    expect(await count("seo_gsc_daily_totals")).toBe(1);
  });

  it("exports SEO metrics with low-cardinality labels only", async () => {
    await configure();
    await runSeoJob({ type: "gsc_sync", trigger: "manual" }, deps());
    await configure({ google: { ...settingsInput().google, ga4PropertyId: "123" } });
    for (let i = 0; i < 3; i++) await runSeoJob({ type: "ga4_sync", trigger: "schedule" }, deps(fakeGoogle({ failures: [403] })));
    const text = await renderMetrics();
    expect(text).toMatch(/seo_sync_consecutive_failures\{job_type="ga4_sync"\} 3/);
    expect(text).toMatch(/seo_sync_success_total\{job_type="gsc_sync"\} \d+/);
    expect(text).toMatch(/seo_api_requests_total\{provider="gsc",outcome="ok"\} \d+/);
    expect(text).toMatch(/seo_sync_consecutive_failures\{job_type="gsc_sync"\} 0/);
    expect(text).toMatch(/seo_sync_last_success_timestamp_seconds\{job_type="gsc_sync"\} [1-9]/);
    const seoLines = text.split("\n").filter((l) => l.startsWith("seo_"));
    expect(seoLines.some((l) => /jithendar\.com|sc-domain|argo/.test(l))).toBe(false);
  });
});
