import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { renderToStaticMarkup } from "react-dom/server";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => "/admin/content/profiles" }));

const svc = await import("@/lib/news/service");
const { filterFrom } = await import("@/lib/news/analytics-filter");

/**
 * AI & SEO → Content analytics (crew-jobs plan PR 4): what every crew job drafted, news and articles alike, narrowed
 * by the filters in the address. Every number on the page uses the same filter.
 */
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
let db: Db;

async function article(jobId: string, outcome: "approved" | "rejected" | null, clusterId: string | null = null) {
  const [run] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_runs (id, job_id, trigger, status, cost_usd) values (gen_random_uuid(), ${jobId}, 'manual', 'succeeded', 0.5) returning id`));
  await db.execute(sql`insert into news_articles (job_id, run_id, cluster_id, status, review_outcome, reviewed_at) values (${jobId}, ${run!.id}, ${clusterId}, 'ready_for_review', ${outcome}, ${outcome ? sql`now()` : null})`);
}

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  await svc.ensureNewsDefaults(db);
});

describe("content analytics filters", () => {
  it("narrow every number to the job, what it writes and the topic asked for", async () => {
    const news = (await svc.createJob(admin, { name: "News desk" }))!;
    const blog = (await svc.createJob(admin, { name: "Blog writer" }))!;
    // What a job writes is its config's output (crew-jobs PR 3); rows from before have none and count as news.
    await db.execute(sql`update news_jobs set config = config || '{"output": "article"}'::jsonb where id = ${blog.id}`);
    const [k8s] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_clusters (title, topics) values ('Kubernetes 1.35', '[{"slug":"kubernetes","p":0.9}]') returning id`));
    await article(news.id, "approved", k8s!.id);
    await article(news.id, "rejected");
    await article(blog.id, "approved");

    const all = await svc.analytics({ days: 90 });
    expect(all.byJob).toEqual([{ name: "Blog writer", approved: 1, rejected: 0 }, { name: "News desk", approved: 1, rejected: 1 }]);
    expect(all.approved).toBe(2);
    expect(all.spend).toBeCloseTo(1.5);

    const articles = await svc.analytics({ days: 90, output: "article" });
    expect(articles.byJob).toEqual([{ name: "Blog writer", approved: 1, rejected: 0 }]);
    expect(articles.approved).toBe(1);
    expect(articles.spend).toBeCloseTo(0.5); // only the article job's runs

    const one = await svc.analytics({ days: 90, jobId: news.id });
    expect(one.byJob).toEqual([{ name: "News desk", approved: 1, rejected: 1 }]);
    expect((await svc.analytics({ days: 90, topic: "kubernetes" })).byJob).toEqual([{ name: "News desk", approved: 1, rejected: 0 }]);
    expect((await svc.analytics({ days: 90, category: "no-such-category" })).byJob).toEqual([]);
    expect((await svc.analytics({ days: 90, sourceId: "00000000-0000-4000-8000-000000000000" })).approved).toBe(0);
    // A number still works for the callers from before the filters.
    expect((await svc.analytics(30)).approved).toBe(2);
  });

  it("read from the address, ignoring anything that is not a known shape", () => {
    expect(filterFrom({})).toEqual({ days: 90, jobId: null, output: null, category: null, topic: null, sourceId: null });
    const id = "0b6e6a0e-6f3c-4c55-9f0e-3c1d2a9f8b11";
    expect(filterFrom({ days: "30", job: id, output: "article", category: "kubernetes", topic: "cloud-native", source: id })).toEqual({ days: 30, jobId: id, output: "article", category: "kubernetes", topic: "cloud-native", sourceId: id });
    expect(filterFrom({ days: "12", job: "1; drop table", output: "podcast", category: "Bad Slug!", topic: "'x'", source: "nope" })).toEqual({ days: 90, jobId: null, output: null, category: null, topic: null, sourceId: null });
  });
});

describe("content profiles & playground (crew-jobs plan PR 5)", () => {
  it("says which content flows write with each profile, and what they write", async () => {
    const { default: ProfilesPage } = await import("@/app/admin/(growth)/content/profiles/page");
    await svc.createJob(admin, { name: "Daily news" });
    await svc.createJob(admin, { name: "Weekly article", config: { output: "article" } });
    const html = renderToStaticMarkup(await ProfilesPage());
    expect(html).toContain("Which content flows write with each profile");
    expect(html).toContain("news-default</code><span class=\"text-fg-muted\"> · Daily news (news stories), Weekly article (blog articles)");
    expect(html).toContain("Weekly article (writes blog articles)</option>");
  });
});
