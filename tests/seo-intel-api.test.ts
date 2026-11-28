import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";
import { NOW } from "./helpers";
import { fakeGoogle, FIXTURE_ENV, settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const as = (role: "admin" | "author" | "user"): SessionUser => ({ id: role, name: role, email: `${role}@example.com`, role, emailVerified: true, image: null, sessionCreatedAt: new Date() });

const API_DIR = path.resolve(import.meta.dirname, "../src/app/api/admin/seo");
function routeFiles(dir = API_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
}
const urlOf = (file: string) => `https://jithendar.com/api/admin/seo/${path.relative(API_DIR, path.dirname(file)).replace(/\[[^\]]+\]/g, "00000000-0000-4000-8000-000000000000")}`;
const DUMMY_PARAMS = { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) };

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([as("admin"), as("author"), as("user")].map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  currentUser = null;
});
afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
});

describe("every /api/admin/seo route", () => {
  const files = routeFiles();
  it("exists", () => expect(files.length).toBeGreaterThanOrEqual(10));

  it.each(files.map((f) => [path.relative(API_DIR, f), f]))("%s rejects anonymous (401) and non-admin (403) requests", async (_name, file) => {
    const mod = (await import(file)) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function");
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      const req = () => new Request(urlOf(file), { method, headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
      currentUser = null;
      expect((await mod[method]!(req(), DUMMY_PARAMS)).status, `${method} anonymous`).toBe(401);
      for (const role of ["author", "user"] as const) {
        currentUser = as(role);
        expect((await mod[method]!(req(), DUMMY_PARAMS)).status, `${method} ${role}`).toBe(403);
      }
    }
  });
});

describe("SEO API behaviour", () => {
  const post = (url: string, body: unknown, origin = "https://jithendar.com") =>
    new Request(url, { method: "POST", headers: { origin, host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) });

  it("refuses cross-site mutations and validates bodies", async () => {
    currentUser = as("admin");
    const { POST } = await import("@/app/api/admin/seo/sync/route");
    expect((await POST(post("https://jithendar.com/api/admin/seo/sync", { source: "gsc" }, "https://evil.example"))).status).toBe(403);
    const bad = await POST(post("https://jithendar.com/api/admin/seo/sync", { source: "bing" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues[0]).toMatch(/source/);
  });

  it("queues sync now and backfill, audit-logs them, and rate-limits", async () => {
    currentUser = as("admin");
    const { POST } = await import("@/app/api/admin/seo/sync/route");
    const res = await POST(post("https://jithendar.com/api/admin/seo/sync", { source: "both", mode: "backfill", months: 3 }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued.map((q: { type: string }) => q.type)).toEqual(["gsc_backfill", "ga4_backfill"]);
    const jobs = rowsOf<{ t: string }>(await db.execute(sql`select payload->>'type' as t from job where kind = 'seo'`));
    expect(jobs).toHaveLength(2);
    const [log] = await db.select().from(schema.auditLog);
    expect(log).toMatchObject({ action: "seo.sync.backfill", actorId: "admin" });
    for (let i = 0; i < 4; i++) await POST(post("https://jithendar.com/api/admin/seo/sync", { source: "gsc" }));
    expect((await POST(post("https://jithendar.com/api/admin/seo/sync", { source: "gsc" }))).status).toBe(429);
  });

  it("saves settings with validation, holds no LLM key (D-110), and audits before/after", async () => {
    currentUser = as("admin");
    const { PUT, GET } = await import("@/app/api/admin/seo/settings/route");
    const put = (body: unknown) => PUT(new Request("https://jithendar.com/api/admin/seo/settings", { method: "PUT", headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) }));
    const invalid = await put({ ...settingsInput(), google: { ...settingsInput().google, ga4PropertyId: "G-ABC" } });
    expect(invalid.status).toBe(400);
    // A key sent the old way is not stored: the document has no LLM key any more.
    const ok = await put({ ...settingsInput(), llmApiKey: "sk-secret-value-123" });
    expect(ok.status).toBe(200);
    const text = await (await GET(new Request("https://jithendar.com/api/admin/seo/settings"))).text();
    expect(text).not.toContain("sk-secret-value-123");
    expect(JSON.parse(text)).not.toHaveProperty("llmKeySet");
    expect(JSON.stringify(await db.select().from(schema.setting))).not.toContain("sk-secret-value-123");
    const logs = await db.select().from(schema.auditLog);
    expect(logs.map((l) => l.action)).toContain("seo.settings.update");
    expect(JSON.stringify(logs)).not.toContain("sk-secret-value-123");
  });

  it("shows disconnected without credentials, then real numbers after a (mocked) sync", async () => {
    currentUser = as("admin");
    const { GET } = await import("@/app/api/admin/seo/overview/route");
    const first = await (await GET(new Request("https://jithendar.com/api/admin/seo/overview?range=7"))).json();
    expect(first.status.gsc.state).toBe("disconnected");
    expect(first.kpis.find((k: { key: string }) => k.key === "clicks").value).toBe(0);

    const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
    await saveSeoSettings(settingsInput(), "admin");
    const { runSeoJob } = await import("@/lib/seo-intel/jobs");
    const deps = { fetchImpl: fakeGoogle().fetch, sleep: async () => {}, env: FIXTURE_ENV };
    await runSeoJob({ type: "gsc_backfill", trigger: "backfill", start: "2026-09-27", end: "2026-10-26" }, { ...deps, now: () => NOW });
    await runSeoJob({ type: "ga4_backfill", trigger: "backfill", start: "2026-09-27", end: "2026-10-26" }, { ...deps, now: () => NOW });
    vi.stubEnv("GOOGLE_SEO_SERVICE_ACCOUNT_JSON", FIXTURE_ENV.GOOGLE_SEO_SERVICE_ACCOUNT_JSON);
    const res = await (await GET(new Request("https://jithendar.com/api/admin/seo/overview?range=7"))).json();
    expect(res.status.gsc.state).toBe("ok");
    const clicks = res.kpis.find((k: { key: string }) => k.key === "clicks");
    expect(clicks).toMatchObject({ source: "Search Console", period: "2026-10-20 – 2026-10-26" });
    expect(clicks.value).toBe(5000 * 7 + (20 + 21 + 22 + 23 + 24 + 25 + 26));
    expect(clicks.previous).toBe(5000 * 7 + (13 + 14 + 15 + 16 + 17 + 18 + 19));
    expect(clicks.change).toBeCloseTo((clicks.value - clicks.previous) / clicks.previous);
    expect(res.kpis.find((k: { key: string }) => k.key === "organicSessions").value).toBeGreaterThan(0);

    const sc = await (await (await import("@/app/api/admin/seo/search-console/route")).GET(new Request("https://jithendar.com/api/admin/seo/search-console?range=28"))).json();
    expect(sc.topPages[0].page).toBe("https://jithendar.com/blog/argo-cd-gitops");
    expect(sc.coverageNote).toMatch(/partial/i);
    const kw = await (await (await import("@/app/api/admin/seo/keywords/route")).GET(new Request("https://jithendar.com/api/admin/seo/keywords?range=28&limit=2"))).json();
    expect(kw.rows).toHaveLength(2);
    expect(kw.total).toBeGreaterThan(2);
    const pages = await (await (await import("@/app/api/admin/seo/pages/route")).GET(new Request("https://jithendar.com/api/admin/seo/pages?range=28&sort=sessions"))).json();
    expect(pages.rows.find((r: { page: string }) => r.page.endsWith("/blog/argo-cd-gitops")).sessions).toBeGreaterThan(0);
    const an = await (await (await import("@/app/api/admin/seo/analytics/route")).GET(new Request("https://jithendar.com/api/admin/seo/analytics?range=28"))).json();
    expect(an.channels.map((c: { key: string }) => c.key)).toEqual(["Organic Search", "Direct"]);
  });

  it("marks data stale after the threshold", async () => {
    const { saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");
    await saveSeoSettings(settingsInput(), "admin");
    await db.execute(sql`insert into seo_sync_jobs (job_type, trigger, status, started_at, finished_at, correlation_id) values ('gsc_sync', 'schedule', 'succeeded', '2026-10-20T00:00:00Z', '2026-10-20T00:05:00Z', 'x')`);
    const { sourceStatus } = await import("@/lib/seo-intel/queries");
    const st = await sourceStatus(db, await getSeoSettings(), "gsc", NOW, FIXTURE_ENV);
    expect(st.state).toBe("stale");
  });
});
