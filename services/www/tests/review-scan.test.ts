import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const scan = await import("@/lib/seo-intel/review-scan");
let db: Db;
const ids: Record<string, string> = {};

async function post(slug: string, collection = "blog", status = "published") {
  const [p] = await db
    .insert(schema.post)
    .values({ collection, slug, title: `Article ${slug}`, description: "d", body: "b", category: "kubernetes", tags: [], contentType: "tutorial", status, publishedAt: new Date("2026-01-01T00:00:00Z"), authorId: "admin" })
    .returning();
  ids[slug] = p!.id;
  return p!.id;
}
async function draft(articleId: string, status: string, daysAgo: number) {
  await db.execute(sql`
    insert into seo_drafts (article_id, collection, status, base_version, base_snapshot, trigger, decided_at, updated_at, created_at)
    values (${articleId}, 'blog', ${status}, 1, '{}'::jsonb, 'manual', now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo}))`);
}

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  await post("never");
  await draft(await post("reviewed-long-ago"), "rejected", 200);
  await draft(await post("reviewed-recently"), "published", 10);
  await draft(await post("in-the-queue"), "ready_for_review", 2);
  await post("a-draft-post", "blog", "draft");
  await post("project-never", "projects");
});
afterEach(() => setDbForTests(undefined));

describe("review queue: not reviewed and rescan", () => {
  it("lists published articles never reviewed or not for 90 days, never first, and not ones in the queue", async () => {
    const list = await scan.unreviewedArticles();
    expect(list.map((a) => a.path)).toEqual(["/blog/never", "/projects/project-never", "/blog/reviewed-long-ago"]);
    expect(list[0]).toMatchObject({ lastReviewedAt: null, lastOutcome: null });
    expect(list[2]).toMatchObject({ lastOutcome: "rejected", lastReviewedAt: expect.any(String) });
    expect((await scan.unreviewedArticles({ staleDays: 5 })).map((a) => a.path)).toContain("/blog/reviewed-recently");
    expect((await scan.unreviewedArticles({ q: "LONG" })).map((a) => a.path)).toEqual(["/blog/reviewed-long-ago"]);
  });

  it("rescans the next articles in that order, at most 25, and reports what was skipped", async () => {
    const asked: string[] = [];
    const request = async (id: string) => {
      asked.push(id);
      if (id === ids["project-never"]) return { queued: false, reason: "Only published articles get optimisation drafts." };
      if (id === ids["reviewed-long-ago"]) throw new Error("The SEO agent is not configured (SEO_AGENT_TOKEN).");
      return { queued: true };
    };
    const r = await scan.rescanArticles({ all: true, limit: 2 }, request);
    expect(asked).toEqual([ids.never, ids["project-never"]]);
    expect(r).toEqual({ requested: 2, queued: 1, skipped: [{ articleId: ids["project-never"], reason: "Only published articles get optimisation drafts." }] });
    const chosen = await scan.rescanArticles({ articleIds: [ids["reviewed-long-ago"]!, ids["reviewed-long-ago"]!] }, request);
    expect(chosen).toEqual({ requested: 1, queued: 0, skipped: [{ articleId: ids["reviewed-long-ago"], reason: "The SEO agent is not configured (SEO_AGENT_TOKEN)." }] });
    const many = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect((await scan.rescanArticles({ articleIds: many }, async () => ({ queued: true }))).requested).toBe(scan.RESCAN_MAX);
  });

  it("asks for a general review, so articles without open recommendations are reviewed too", () => {
    expect(scan.RESCAN_TASKS.map((t) => t.category).sort()).toEqual(["freshness", "title_meta"]);
  });
});
