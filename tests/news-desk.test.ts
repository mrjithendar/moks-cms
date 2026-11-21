import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const svc = await import("@/lib/news/service");
const schemaMod = await import("@/lib/news/schema");
const cron = await import("@/lib/news/cron");
const callbacks = await import("@/lib/news/callbacks");
const orch = await import("@/lib/seo-agent/orchestrate");
const { handleCallback } = await import("@/lib/seo-agent/internal-server");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");

/**
 * News desk, web side (the agent is mocked): schema + rollback, the shared job-config contract, job versioning and
 * rollback, cron, the fetch callback's rules (allowlist, robots.txt, paywall, conditional GET), draft creation through
 * the v4 new-article path, approve → publish with the news metadata → NewsArticle + news sitemap, feedback, corrections,
 * expiry, and the guards: admin-only routes and no publishing code in src/lib/news.
 */
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const CB = "c".repeat(40);
const NCB = "n".repeat(40); // the news agent's callback token: the only one the /news/* routes accept
const cb = (method: string, p: string, body?: unknown) =>
  handleCallback(method, `/internal/seo-agent${p}`, `Bearer ${p.startsWith("/news/") ? NCB : CB}`, body, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB, NEWS_AGENT_CALLBACK_TOKEN: NCB });
let db: Db;
const env = { ...process.env };

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "jithendar-dharmapuri", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  await svc.ensureNewsDefaults(db);
  Object.assign(process.env, { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "a".repeat(40), SEO_AGENT_CALLBACK_TOKEN: CB, SEO_AGENT_URL: "http://seo-agent.test:8080", SITE_URL: "https://jithendar.com", NEWS_DESK_ENABLED: "true" });
  vi.stubGlobal("fetch", (async (u: string | URL) => (/^http:\/\/seo-agent\.test/.test(String(u)) ? Response.json({ run_id: "00000000-0000-4000-8000-0000000000aa", status: "queued", existing: false }, { status: 202 }) : Response.json({}, { status: 404 }))) as typeof fetch);
  currentUser = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...env };
});

const MIG = path.resolve(import.meta.dirname, "../src/db");
const stmts = (f: string) => fs.readFileSync(f, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

describe("schema", () => {
  it("creates 17 news tables; rollback removes them; up again works", async () => {
    const count = async () => Number(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from information_schema.tables where table_name like 'news\\_%'`))[0]!.n);
    expect(await count()).toBe(17);
    for (const s of stmts(path.join(MIG, "rollback/0017_news_desk.down.sql"))) await db.execute(sql.raw(s));
    expect(await count()).toBe(0);
    for (const s of stmts(path.join(MIG, "migrations/0017_news_desk.sql"))) await db.execute(sql.raw(s));
    expect(await count()).toBe(17);
  });

  it("enforces one active draft per story per job and one run per slot", async () => {
    const job = (await svc.createJob(admin, { name: "Daily cloud native" }))!;
    const [c] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_clusters (title) values ('story') returning id`));
    await db.execute(sql`insert into news_articles (job_id, cluster_id, status) values (${job.id}, ${c!.id}, 'ready_for_review')`);
    await expect(db.execute(sql`insert into news_articles (job_id, cluster_id, status) values (${job.id}, ${c!.id}, 'drafting')`)).rejects.toThrow();
    await db.execute(sql`insert into news_articles (job_id, cluster_id, status) values (${job.id}, ${c!.id}, 'failed_quality')`); // inactive: fine
    await db.execute(sql`insert into news_runs (id, job_id, trigger, slot) values (gen_random_uuid(), ${job.id}, 'cron', 'S1')`);
    await expect(db.execute(sql`insert into news_runs (id, job_id, trigger, slot) values (gen_random_uuid(), ${job.id}, 'cron', 'S1')`)).rejects.toThrow();
  });

  it("seeds topics from the CMS categories and the default profiles", async () => {
    const topics = await svc.listTopics();
    expect(topics.length).toBeGreaterThanOrEqual(8);
    expect(topics.every((t) => t.category_slug === t.slug)).toBe(true);
    expect((await svc.listProfiles("writing"))[0]).toMatchObject({ key: "news-default", version: 1, status: "active" });
  });
});

describe("job config contract and versioning", () => {
  it("parses the fixture shared with seo-agent and refuses unknown keys", () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../docs/news/fixtures/job-config.json"), "utf8"));
    expect(schemaMod.jobConfigSchema.parse(fixture).max_articles_per_run).toBe(3);
    expect(schemaMod.jobConfigSchema.safeParse({ ...fixture, max_articels_per_run: 3 }).success).toBe(false);
    expect(schemaMod.jobConfigSchema.safeParse({ ...fixture, weights: { vibes: 1 } }).success).toBe(false);
  });

  it("every save is a version with a diff; rollback saves the old snapshot as a new version; clone is disabled", async () => {
    const j = (await svc.createJob(admin, { name: "Kubernetes news", cron: "0 7 * * 1-5" }))!;
    const base = { name: j.name, description: "", enabled: false, cron: j.cron, timezone: j.timezone, mode: "single_stories", writing_profile_key: "news-default", image_profile_key: "cover-template", review_priority: 50 };
    const r1 = await svc.updateJob(admin, j.id, { ...base, config: { ...j.config, max_articles_per_run: 2 } });
    expect(r1).toMatchObject({ changed: true, version: 2 });
    expect(r1.diff).toEqual([{ path: "config.max_articles_per_run", before: 3, after: 2 }]);
    expect((await svc.updateJob(admin, j.id, { ...base, config: { ...j.config, max_articles_per_run: 2 } })).changed).toBe(false);
    await svc.updateJob(admin, j.id, { ...base, name: "Renamed", config: { ...j.config, max_articles_per_run: 2 } });
    const rb = await svc.rollbackJob(admin, j.id, 1);
    expect(rb.version).toBe(4);
    const now = (await svc.getJob(j.id))!;
    expect(now).toMatchObject({ name: "Kubernetes news", version: 4 });
    expect(now.config.max_articles_per_run).toBe(3);
    const vs = await svc.jobVersions(j.id);
    expect(vs.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(vs[0]!.note).toBe("rollback to v1");
    const clone = (await svc.cloneJob(admin, j.id))!;
    expect(clone).toMatchObject({ enabled: false, version: 1 });
    expect(clone.name).toContain("(copy)");
    const audit = rowsOf<{ action: string }>(await db.execute(sql`select action from audit_log where action like 'news.job.%' order by id`)).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["news.job.create", "news.job.update", "news.job.rollback"]));
  });

  it("refuses a bad schedule and more than 25 jobs", async () => {
    await expect(svc.createJob(admin, { name: "Bad", cron: "61 * * * *" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createJob(admin, { name: "Bad tz", timezone: "Mars/Base" })).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 25; i++) await db.execute(sql`insert into news_jobs (name) values (${`j${i}`})`);
    await expect(svc.createJob(admin, { name: "One too many" })).rejects.toMatchObject({ status: 409 });
  });

  it("cron: next runs in a time zone, validation", () => {
    const next = cron.nextRuns("0 7 * * 1-5", "Asia/Kolkata", new Date("2026-11-10T02:00:00Z"), 2);
    expect(next.map((d) => d.toISOString())).toEqual(["2026-11-11T01:30:00.000Z", "2026-11-12T01:30:00.000Z"]);
    expect(cron.cronError("0 7 * *", "UTC")).toMatch(/5 fields/);
    expect(cron.cronError("*/15 * * * *", "UTC")).toBeNull();
  });
});

describe("fetch callback", () => {
  const fakeFetcher = (routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>, seen: { url: string; headers: Record<string, string> }[] = []) =>
    (async (url: string, headers: Record<string, string>) => {
      seen.push({ url, headers });
      const r = routes[url] ?? { status: 404 };
      return { status: r.status, finalUrl: url, headers: r.headers ?? { "content-type": "application/rss+xml" }, body: r.body ?? "", truncated: false };
    });

  async function source(url: string) {
    return (await svc.saveSource(admin, null, { name: "Feed", type: "rss", url, enabled: true })).id;
  }

  it("fetches a source's own feed with a site User-Agent and conditional GET; 304 is not-modified", async () => {
    const id = await source("https://feeds.example.org/feed.xml");
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f = fakeFetcher({ "https://feeds.example.org/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private/" }, "https://feeds.example.org/feed.xml": { status: 304 } }, seen);
    const r = await callbacks.newsFetch({ url: "https://feeds.example.org/feed.xml", sourceId: id, etag: '"v1"', lastModified: "Tue, 10 Nov 2026 04:00:00 GMT", purpose: "feed" }, { fetcher: f, now: 1 });
    expect(r).toMatchObject({ status: 304, notModified: true });
    const h = seen.find((s) => s.url.endsWith("feed.xml"))!.headers;
    expect(h).toMatchObject({ "If-None-Match": '"v1"', "If-Modified-Since": "Tue, 10 Nov 2026 04:00:00 GMT" });
    expect(h["User-Agent"]).toMatch(/^JithendarNewsDesk\/1\.0 \(\+https:\/\/jithendar\.com/);
  });

  it("refuses robots-disallowed paths, other hosts for a feed, paywalled hosts and http", async () => {
    const id = await source("https://blocked.example.org/news/feed.xml");
    const f = fakeFetcher({ "https://blocked.example.org/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /news/" } });
    expect(await callbacks.newsFetch({ url: "https://blocked.example.org/news/feed.xml", sourceId: id, purpose: "feed" }, { fetcher: f, now: 2 })).toMatchObject({ robots: "disallowed" });
    expect((await callbacks.newsFetch({ url: "https://other.example.net/x", sourceId: id, purpose: "feed" }, { fetcher: f, now: 2 })).error).toMatch(/not on the allowlist/);
    expect((await callbacks.newsFetch({ url: "http://blocked.example.org/x", sourceId: id, purpose: "feed" }, { fetcher: f })).error).toMatch(/https/);
    await svc.saveNewsSettings(admin, { paywalled_hosts: ["paywall.example.com"] });
    expect((await callbacks.newsFetch({ url: "https://www.paywall.example.com/a", purpose: "primary_source" }, { fetcher: f })).error).toMatch(/paywalled/);
    await expect(svc.saveSource(admin, null, { name: "Paywalled", type: "rss", url: "https://paywall.example.com/feed" })).rejects.toMatchObject({ status: 400 });
    // robots.txt 503 / 429 → treat as disallowed for now
    const id2 = await source("https://flaky.example.org/feed.xml");
    expect((await callbacks.newsFetch({ url: "https://flaky.example.org/feed.xml", sourceId: id2, purpose: "feed" }, { fetcher: fakeFetcher({ "https://flaky.example.org/robots.txt": { status: 429 } }), now: 3 })).robots).toBe("disallowed");
  });
});

const NEWS_DOC = {
  title: "Kubernetes 1.35 makes in-place pod resize stable",
  slug_suggestion: "kubernetes-1-35-in-place-pod-resize-stable",
  meta_description: "Kubernetes 1.35 makes in-place pod resize stable: what changed, why it matters for platform teams, and what to check before relying on it.",
  outline: ["Why it matters"],
  body_mdx: "Kubernetes 1.35 is out.\n\n## Why it matters\n\nResizing without restarts.\n\n## What to do\n\nCheck your runtime.",
  sources: [{ url: "https://kubernetes.io/blog/2026/11/10/v1-35/", title: "Kubernetes v1.35", used_for: "Kubernetes" }],
  fact_check_flags: [],
  internal_links: [],
  news: { dek: "Resize running pods.", categories: ["kubernetes"], tags: ["kubernetes", "autoscaling"], sources: [{ title: "Kubernetes v1.35", publisher: "Kubernetes", url: "https://kubernetes.io/blog/2026/11/10/v1-35/", accessed_at: "2026-11-10" }], image: null, job_name: "Daily" },
};

async function newsDraft(doc = NEWS_DOC) {
  const job = (await svc.createJob(admin, { name: "Daily", config: { expiry_days: 7 } }))!;
  const [run] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_runs (id, job_id, trigger, status) values (gen_random_uuid(), ${job.id}, 'manual', 'running') returning id`));
  const [cl] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_clusters (title, topics) values ('Kubernetes 1.35', '[{"slug":"kubernetes","p":0.9}]') returning id`));
  await db.execute(sql`insert into news_candidates (run_id, job_id, cluster_id, features, score, breakdown, model_version, decision, reason) values (${run!.id}, ${job.id}, ${cl!.id}, '{"recency":1}', 0.72, '{"model":"v1-weighted"}', 'v1-weighted', 'selected', 'selected')`);
  const [a] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_articles (job_id, run_id, cluster_id, status, generated_doc, score, expires_after_days) values (${job.id}, ${run!.id}, ${cl!.id}, 'drafting', ${JSON.stringify(doc)}::jsonb, 0.72, 7) returning id`));
  const r = await cb("POST", "/news/drafts", { articleId: a!.id, jobId: job.id, jobName: "Daily", document: doc, flags: [], categories: ["kubernetes"], tags: ["kubernetes"], image: null, runId: run!.id, author: "jithendar-dharmapuri" });
  return { job, articleId: a!.id, clusterId: cl!.id, res: r as { status: number; body: { draftId: string; postId: string; errors: string[] } } };
}

describe("drafts → review → publish", () => {
  it("creates a CMS draft post in news and an agent-owned review draft; nothing is published", async () => {
    const { res, articleId } = await newsDraft();
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    const [post] = await db.select().from(schema.post).where(sql`id = ${res.body.postId}`);
    expect(post).toMatchObject({ collection: "news", contentType: "news", status: "draft", category: "kubernetes", authorId: "admin" });
    expect(post!.sources).toEqual([{ title: "Kubernetes v1.35", url: "https://kubernetes.io/blog/2026/11/10/v1-35/", publisher: "Kubernetes" }]);
    const [d] = rowsOf<{ kind: string; status: string; thread_id: string; id: string }>(await db.execute(sql`select kind, status, thread_id, id from seo_drafts where id = ${res.body.draftId}`));
    expect(d).toMatchObject({ kind: "new_article", status: "ready_for_review" });
    expect(d!.thread_id).toBe(d!.id);
    expect(rowsOf<{ draft_id: string }>(await db.execute(sql`select draft_id from news_articles where id = ${articleId}`))[0]!.draft_id).toBe(res.body.draftId);
  });

  it("refuses a draft whose title duplicates a published article (web validation), creating nothing", async () => {
    const { createPost } = await import("@/lib/posts");
    await createPost(admin, { collection: "blog", slug: "dup", title: NEWS_DOC.title, description: "x".repeat(60), body: "b", category: "kubernetes", tags: [], contentType: "tutorial", status: "published", publishedAt: "2026-11-01T00:00:00+00:00" });
    const before = (await db.select().from(schema.post)).length;
    const { res } = await newsDraft();
    expect(res.body.errors.join(" ")).toMatch(/already uses this title/);
    expect((await db.select().from(schema.post)).length).toBe(before);
  });

  it("the queue shows the News badge data; approve → publish applies the reviewed metadata, NewsArticle + news sitemap", async () => {
    const { res, articleId } = await newsDraft();
    const draftId = res.body.draftId;
    const { reviewQueue } = await import("@/lib/seo-intel/drafts");
    const q = await reviewQueue({});
    const item = (q as unknown as { id: string; news: { job: string; score: number } | null }[]).find((i) => i.id === draftId)!;
    expect(item.news).toMatchObject({ job: "Daily", score: 0.72 });
    // reviewer edits tags in review (tracked), then approves
    await db.execute(sql`update seo_drafts set document = jsonb_set(document, '{news,tags}', '["kubernetes","release"]') where id = ${draftId}`);
    const r = await orch.approve(draftId, admin, null);
    const p = await cb("POST", `/drafts/${draftId}/publish`, { approvalId: r!.approvalId, acceptedChangeIds: [] });
    expect(p).toMatchObject({ status: 200, body: { status: "published" } });
    const [post] = await db.select().from(schema.post).where(sql`id = ${res.body.postId}`);
    expect(post).toMatchObject({ status: "published", collection: "news", contentType: "news", slug: NEWS_DOC.slug_suggestion, tags: ["kubernetes", "release"] });
    const { getPublishedContent, invalidateContent } = await import("@/lib/content");
    delete process.env.CONTENT_DIR;
    invalidateContent();
    const { articleLd } = await import("@/lib/seo/jsonld");
    const { newsSitemapEntries } = await import("@/lib/seo/news-sitemap");
    const published = await getPublishedContent({ now: new Date() });
    const art = published.find((a) => a.id === res.body.postId)!;
    expect(art).toBeTruthy();
    const author = { slug: "jithendar-dharmapuri", path: "/authors/jithendar-dharmapuri", frontmatter: { name: "Admin", sameAs: [] }, body: "", file: "" } as never;
    expect(articleLd(art, author)).toMatchObject({ "@type": "NewsArticle", headline: NEWS_DOC.title });
    expect(newsSitemapEntries(published, new Date()).map((a) => a.id)).toContain(res.body.postId);
    expect(newsSitemapEntries(published, new Date(Date.now() + 3 * 86_400_000)).map((a) => a.id)).not.toContain(res.body.postId); // 48 h window
    const [na] = rowsOf<{ status: string; review_outcome: string; edit_distance: number | null }>(await db.execute(sql`select status, review_outcome, edit_distance from news_articles where id = ${articleId}`));
    expect(na).toMatchObject({ status: "published", review_outcome: "approved" });
    expect(na!.edit_distance).toBe(0);
    expect(rowsOf<{ kind: string }>(await db.execute(sql`select kind from news_feedback where article_id = ${articleId}`)).map((f) => f.kind)).toEqual(["approve"]);
  });

  it("reject with a category feeds the learning loop; duplicate marks the story covered", async () => {
    const { res, articleId, clusterId } = await newsDraft();
    await orch.reject(res.body.draftId, admin, "duplicate").catch(() => undefined);
    await svc.recordReview(admin, res.body.draftId, "rejected", { category: "duplicate", reason: "covered last week" });
    const [na] = rowsOf<{ status: string; reject_category: string }>(await db.execute(sql`select status, reject_category from news_articles where id = ${articleId}`));
    expect(na).toMatchObject({ status: "rejected", reject_category: "duplicate" });
    expect(rowsOf<{ status: string }>(await db.execute(sql`select status from news_clusters where id = ${clusterId}`))[0]!.status).toBe("covered");
    expect(rowsOf<{ kind: string; reason_category: string }>(await db.execute(sql`select kind, reason_category from news_feedback`))[0]).toMatchObject({ kind: "reject", reason_category: "duplicate" });
  });

  it("corrections add a dated note and dateModified; expiry shows a notice with newer coverage", async () => {
    const { res } = await newsDraft();
    const r = await orch.approve(res.body.draftId, admin, null);
    await cb("POST", `/drafts/${res.body.draftId}/publish`, { approvalId: r!.approvalId, acceptedChangeIds: [] });
    const { addCorrection, newsExpiry } = await import("@/lib/news/corrections");
    const c = await addCorrection(admin, res.body.postId, "Corrected the release date of the feature.", new Date());
    const [post] = await db.select().from(schema.post).where(sql`id = ${res.body.postId}`);
    expect(post!.corrections).toEqual([{ date: c.updatedAt, note: "Corrected the release date of the feature." }]);
    expect(post!.updatedAt).toBeTruthy();
    expect(rowsOf<{ reason: string }>(await db.execute(sql`select reason from seo_search_submissions where article_id = ${res.body.postId}`)).length).toBeGreaterThan(0);
    expect(await newsExpiry(res.body.postId, new Date())).toBeNull();
    const later = await newsExpiry(res.body.postId, new Date(Date.now() + 8 * 86_400_000));
    expect(later).toEqual({ newer: null });
  });
});

describe("guards", () => {
  const API = path.resolve(import.meta.dirname, "../src/app/api/admin/news");
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));

  it("every news admin route: 401 signed out, 403 for authors", async () => {
    const all = files(API);
    expect(all.length).toBeGreaterThanOrEqual(19);
    for (const f of all) {
      const mod = (await import(f)) as Record<string, (r: Request, c: unknown) => Promise<Response>>;
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((x) => typeof mod[x] === "function")) {
        const params = Promise.resolve({ id: "00000000-0000-4000-8000-000000000001", kind: "writing" });
        currentUser = null;
        expect((await mod[m]!(new Request("https://jithendar.com/api/admin/news/x", { method: m, headers: { origin: "https://jithendar.com", host: "jithendar.com" } }), { params })).status, `${m} ${f}`).toBe(401);
        currentUser = { id: "author", role: "author", email: "a@example.com", name: "A" } as SessionUser;
        expect((await mod[m]!(new Request("https://jithendar.com/api/admin/news/x", { method: m, headers: { origin: "https://jithendar.com", host: "jithendar.com" } }), { params })).status, `${m} ${f}`).toBe(403);
      }
    }
  });

  it("src/lib/news cannot publish: only publishing.ts (inside publishNewArticle) and corrections.ts touch the CMS update path", () => {
    const dir = path.resolve(import.meta.dirname, "../src/lib/news");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/publishPost|publishDraft|publishWithApproval|approveDraft|recordApproval|\bdecide\(/);
      if (f !== "corrections.ts") expect(src, f).not.toMatch(/\bupdatePost\b/);
    }
    // the news hooks are only called from publishNewArticle, after the approval check
    const pub = fs.readFileSync(path.resolve(import.meta.dirname, "../src/lib/seo-intel/publish.ts"), "utf8");
    expect(pub.indexOf("newsPublishPatch")).toBeGreaterThan(pub.indexOf("async function publishNewArticle"));
  });

  it("the agent's kickoff wrapper refuses while NEWS_DESK_ENABLED is off", async () => {
    process.env.NEWS_DESK_ENABLED = "false";
    const { runJob } = await import("@/lib/news/agent");
    await expect(runJob("00000000-0000-4000-8000-000000000001", "admin")).rejects.toMatchObject({ status: 409 });
  });
});
