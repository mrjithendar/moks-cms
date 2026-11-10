import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
import { FIXTURE_ENV, settingsInput } from "./seo-fixtures";
import { seedArticle } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sub = await import("@/lib/seo-intel/submission");
const { saveSeoSettings, submissionEnabled } = await import("@/lib/seo-intel/settings");
const { resetIndexNowKeyCache, indexNowKey } = await import("@/lib/indexnow-key");
const { clearTokenCache } = await import("@/lib/seo-intel/google/auth");

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const ON = { ...FIXTURE_ENV, SEO_SUBMISSION_ENABLED: "true" };
let db: Db;
let articleId: string;

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  await saveSeoSettings({ ...settingsInput(), google: { ...settingsInput().google, gscProperty: "sc-domain:jithendar.com" } }, "admin");
  articleId = (await seedArticle(db)).id;
  vi.stubEnv("SITE_URL", "https://jithendar.com");
  vi.stubEnv("INDEXNOW_KEY", "0123456789abcdef0123456789abcdef");
  vi.stubEnv("SEO_SUBMISSION_ENABLED", "true");
  resetIndexNowKeyCache();
  clearTokenCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetIndexNowKeyCache();
});

const rows = async () => rowsOf<{ engine: string; kind: string; status: string; url: string; error: string | null; response_code: number | null; next_attempt_at: string | null }>(await db.execute(sql`select engine, kind, status, url, error, response_code, next_attempt_at::text from seo_search_submissions order by requested_at, kind`));
const jobs = async () => rowsOf<{ kind: string; payload: Record<string, unknown>; run_at: string }>(await db.execute(sql`select kind, payload, run_at::text from job order by created_at`));
const target = (path = "/blog/ingress-tls") => ({ draftId: null, articleId, path, reason: "publish" as const });

describe("migration 0013", () => {
  it("applies, rolls back and re-applies", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrateDb, migrationsDir } = await import("@/db/migrate");
    const pg = new PGlite();
    const clean = drizzle(pg, { schema }) as unknown as Db;
    await migrateDb(clean);
    const has = async () => rowsOf(await clean.execute(sql`select 1 from information_schema.tables where table_name = 'seo_search_submissions'`)).length;
    expect(await has()).toBe(1);
    for (const stmt of fs.readFileSync(path.resolve(migrationsDir(), "../rollback/0013_seo_submissions.down.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await clean.execute(sql.raw(stmt));
    expect(await has()).toBe(0);
    expect(await migrateDb(clean)).toEqual(["0013_seo_submissions.sql"]);
    await pg.close();
  });
});

describe("kill switch", () => {
  it("is off by default outside production, on in production, and explicit values win", () => {
    expect(submissionEnabled({})).toBe(false);
    expect(submissionEnabled({ APP_ENV: "staging" })).toBe(false);
    expect(submissionEnabled({ APP_ENV: "production" })).toBe(true);
    expect(submissionEnabled({ APP_ENV: "production", SEO_SUBMISSION_ENABLED: "false" })).toBe(false);
    expect(submissionEnabled({ SEO_SUBMISSION_ENABLED: "true" })).toBe(true);
  });
  it("when off, nothing is queued but the timeline records why", async () => {
    await sub.submitAfterPublish(db, target(), { env: {} });
    expect(await rows()).toEqual([expect.objectContaining({ status: "skipped", error: expect.stringMatching(/SEO_SUBMISSION_ENABLED/) })]);
    expect(await jobs()).toEqual([]);
  });
});

describe("IndexNow", () => {
  it("builds a protocol-conformant, deduplicated payload", () => {
    const p = sub.indexNowPayload(["https://jithendar.com/a", "https://jithendar.com/a", "https://jithendar.com/b"], "k".repeat(32), "jithendar.com");
    expect(p).toEqual({ host: "jithendar.com", key: "k".repeat(32), keyLocation: `https://jithendar.com/${"k".repeat(32)}.txt`, urlList: ["https://jithendar.com/a", "https://jithendar.com/b"] });
  });

  it("batches several URLs into one debounced POST and deduplicates queued URLs", async () => {
    const now = new Date("2026-11-10T10:00:00Z");
    await sub.queueIndexNowUrl(db, target("/blog/a"), { now });
    await sub.queueIndexNowUrl(db, target("/blog/b"), { now });
    await sub.queueIndexNowUrl(db, target("/blog/a"), { now });
    const j = await jobs();
    expect(j).toHaveLength(1); // one batch job, deduplicated by key
    expect(j[0]).toMatchObject({ kind: "seo_submit", payload: { kind: "indexnow" } });
    expect(new Date(j[0]!.run_at).getTime()).toBe(now.getTime() + 60_000);
    expect((await rows()).map((r) => r.status)).toEqual(["queued", "queued", "deduplicated"]);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const r = await sub.sendIndexNowBatch(db, { fetchImpl });
    expect(r).toEqual({ sent: 2, status: 202 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.indexnow.org/indexnow");
    expect(calls[0]!.body.urlList).toEqual(["https://jithendar.com/blog/a", "https://jithendar.com/blog/b"]);
    expect((await rows()).filter((x) => x.status === "accepted").map((x) => x.response_code)).toEqual([202, 202]);
    expect(await sub.sendIndexNowBatch(db, { fetchImpl })).toEqual({ sent: 0, status: null }); // nothing left
  });

  it("retries 429/5xx (rows go back to the queue, the job backs off) and gives up on 4xx", async () => {
    await sub.queueIndexNowUrl(db, target());
    await expect(sub.sendIndexNowBatch(db, { fetchImpl: (async () => new Response(null, { status: 429 })) as unknown as typeof fetch })).rejects.toThrow(/429/);
    expect((await rows())[0]).toMatchObject({ status: "queued", response_code: 429 });
    await sub.sendIndexNowBatch(db, { fetchImpl: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch });
    expect((await rows())[0]).toMatchObject({ status: "error", response_code: 403 });
  });

  it("generates the key automatically on first use (served at /{key}.txt), audit-logged", async () => {
    vi.stubEnv("INDEXNOW_KEY", "");
    resetIndexNowKeyCache();
    expect(await indexNowKey()).toBeNull();
    const key = await sub.ensureIndexNowKey(admin);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    resetIndexNowKeyCache();
    expect(await indexNowKey()).toBe(key);
    expect(rowsOf(await db.execute(sql`select 1 from audit_log where action = 'seo.submission.indexnow_key_generated'`))).toHaveLength(1);
    // turned off on purpose → respected, never re-enabled
    const { setIndexNow } = await import("@/lib/integrations");
    await setIndexNow(admin, false);
    resetIndexNowKeyCache();
    expect(await sub.ensureIndexNowKey(admin)).toBeNull();
  });
});

describe("Google: sitemap resubmission and URL Inspection (never the Indexing API)", () => {
  function fakeGoogle(status = 204) {
    const calls: { url: string; method: string; scope?: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        const assertion = new URLSearchParams(String(init.body)).get("assertion")!;
        const scope = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()).scope as string;
        calls.push({ url, method: "POST", scope });
        return Response.json({ access_token: `tok-${scope.endsWith("readonly") ? "ro" : "rw"}`, expires_in: 3600 });
      }
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/sitemaps/")) return new Response(status === 204 ? null : JSON.stringify({ error: { message: "User does not have sufficient permission" } }), { status });
      if (url.includes("urlInspection")) return Response.json({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-11-12T03:04:05Z", googleCanonical: "https://jithendar.com/blog/ingress-tls" } } });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("queues sitemap resubmission (+ news sitemap for news) and an inspection 60 h later", async () => {
    const now = new Date("2026-11-10T10:00:00Z");
    await sub.submitAfterPublish(db, target("/news/patch-now"), { now, env: ON, actor: admin });
    const r = await rows();
    expect(r.filter((x) => x.kind === "sitemap").map((x) => x.url)).toEqual(["https://jithendar.com/sitemap.xml", "https://jithendar.com/news-sitemap.xml"]);
    const insp = r.find((x) => x.kind === "inspection")!;
    expect(insp.status).toBe("scheduled");
    expect(new Date(insp.next_attempt_at!).getTime()).toBe(now.getTime() + 60 * 3_600_000);
    expect((await jobs()).map((j) => j.payload.kind).sort()).toEqual(["indexnow", "inspect", "sitemap"]);
  });

  it("resubmits via sitemaps.submit with the write scope, once per hour per sitemap", async () => {
    vi.stubEnv("GOOGLE_SEO_SERVICE_ACCOUNT_JSON", FIXTURE_ENV.GOOGLE_SEO_SERVICE_ACCOUNT_JSON);
    await sub.submitAfterPublish(db, target(), { env: ON, actor: admin });
    const g = fakeGoogle();
    expect(await sub.sendSitemapResubmits(db, { fetchImpl: g.fetchImpl, env: ON, sleep: async () => {} })).toBe(1);
    const put = g.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Ajithendar.com/sitemaps/https%3A%2F%2Fjithendar.com%2Fsitemap.xml");
    expect(g.calls.find((c) => c.scope)!.scope).toBe("https://www.googleapis.com/auth/webmasters");
    expect(g.calls.some((c) => /indexing\.googleapis\.com/.test(c.url))).toBe(false);
    await sub.submitAfterPublish(db, target(), { env: ON, actor: admin });
    expect(await sub.sendSitemapResubmits(db, { fetchImpl: g.fetchImpl, env: ON })).toBe(0);
    expect((await rows()).filter((x) => x.kind === "sitemap").map((x) => x.status)).toEqual(["accepted", "deduplicated"]);
  });

  it("explains a permission error (needs Full/Owner) and missing credentials", async () => {
    await sub.submitAfterPublish(db, target(), { env: ON, actor: admin });
    await sub.sendSitemapResubmits(db, { env: {} });
    expect((await rows()).find((x) => x.kind === "sitemap")).toMatchObject({ status: "skipped", error: expect.stringMatching(/Needs credentials/) });
    await sub.submitAfterPublish(db, target(), { env: ON, actor: admin });
    await sub.sendSitemapResubmits(db, { fetchImpl: fakeGoogle(403).fetchImpl, env: ON, sleep: async () => {} });
    expect((await rows()).filter((x) => x.kind === "sitemap").at(-1)).toMatchObject({ status: "error", error: expect.stringMatching(/Full or Owner/) });
  });

  it("stores the URL Inspection result as Google's last-known state and builds the timeline", async () => {
    await sub.submitAfterPublish(db, target(), { env: ON, actor: admin });
    await sub.sendIndexNowBatch(db, { fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch });
    const [id] = rowsOf<{ id: string }>(await db.execute(sql`select id from seo_search_submissions where kind = 'inspection'`));
    const insp = await sub.runInspection(db, id!.id, { fetchImpl: fakeGoogle().fetchImpl, env: ON, sleep: async () => {} });
    expect(insp).toMatchObject({ verdict: "PASS", coverageState: "Submitted and indexed" });
    const tl = sub.timelineSummary(await sub.listSubmissions(db, { articleId }));
    expect(tl).toMatchObject({ crawledAt: "2026-11-12T03:04:05Z", indexState: "Submitted and indexed", pendingInspection: false });
    expect(tl.submittedAt).not.toBeNull();
  });
});

describe("sitemap <lastmod> moves only on substantive changes", () => {
  it("title/meta-only publish keeps lastmod; a body change moves it", async () => {
    vi.stubEnv("CONTENT_DIR", "");
    delete process.env.CONTENT_DIR;
    const { buildSitemap } = await import("@/lib/seo/sitemap");
    const { invalidateContent } = await import("@/lib/content");
    const lastmod = async () => {
      invalidateContent();
      return (await buildSitemap()).find((e) => e.url.endsWith("/blog/ingress-tls"))?.lastModified;
    };
    const before = await lastmod();
    expect(before).toBeDefined();
    // what publish.ts writes for a metadata-only draft (no updatedAt) vs a substantive one (updatedAt = now)
    await db.update(schema.post).set({ seoTitle: "A new search title for this page" });
    expect(await lastmod()).toBe(before);
    await db.update(schema.post).set({ updatedAt: new Date("2026-11-10T10:00:00Z") });
    expect(await lastmod()).not.toBe(before);
  });
});
