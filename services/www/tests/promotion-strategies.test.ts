import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { promotionPlan, reopenForReshare } = await import("@/lib/seo-intel/promotion/strategies");
const NOW = new Date("2026-11-18T08:00:00Z");
const ORIGIN = "https://jithendar.com";
let db: Db;
const ids: Record<string, string> = {};

async function article(slug: string, daysOld: number) {
  const [p] = await db
    .insert(schema.post)
    .values({ collection: "blog", slug, title: `Article ${slug}`, description: `About ${slug}.`, body: "b", category: "kubernetes", tags: [], contentType: "tutorial", status: "published", publishedAt: new Date(NOW.getTime() - daysOld * 86_400_000), authorId: "admin" })
    .returning();
  ids[slug] = p!.id;
  await db.execute(sql`insert into seo_url_map (url, path, article_id) values (${`${ORIGIN}/blog/${slug}`}, ${`/blog/${slug}`}, ${p!.id})`);
  return p!.id;
}
async function gsc(slug: string, daysAgo: number, clicks: number) {
  const date = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  await db.execute(sql`insert into seo_gsc_page_daily (date, page, search_type, device, country, clicks, impressions, ctr) values (${date}, ${`${ORIGIN}/blog/${slug}`}, 'web', 'DESKTOP', 'ind', ${clicks}, ${clicks * 20}, 0.05)`);
}
async function opportunity(slug: string, channel: string, status: string, postedDaysAgo: number | null, evidence: object = {}) {
  await db.execute(sql`
    insert into seo_promo_opportunities (article_id, channel, link, status, posted_at, posted_url, draft_body, evidence)
    values (${ids[slug]}, ${channel}, 'https://jithendar.com/x', ${status}, ${postedDaysAgo === null ? null : new Date(NOW.getTime() - postedDaysAgo * 86_400_000).toISOString()}, ${postedDaysAgo === null ? null : "https://linkedin.com/p/1"}, 'old post', ${JSON.stringify(evidence)}::jsonb)`);
}

beforeEach(async () => {
  vi.stubEnv("SITE_URL", ORIGIN);
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  await article("evergreen", 200);
  await article("shared-recently", 200);
  await article("decaying", 150);
  await article("new-one", 3);
  // Search Console: the newest synced day is yesterday. Evergreen steady, decaying 40 → 10, shared-recently steady.
  await gsc("evergreen", 1, 30);
  await gsc("evergreen", 40, 30);
  await gsc("shared-recently", 1, 25);
  await gsc("decaying", 1, 10);
  await gsc("decaying", 40, 40);
  await opportunity("evergreen", "linkedin", "posted", 120);
  await opportunity("evergreen", "x", "dismissed", null);
  await opportunity("shared-recently", "linkedin", "posted", 20);
  await opportunity("new-one", "reddit", "drafted", null, { threads: [{ community: "kubernetes", title: "How do I do new-one?", url: "https://reddit.com/r/kubernetes/1", score: 12, comments: 4 }] });
  await opportunity("decaying", "devto", "posted", 30);
  await db.execute(sql`insert into seo_internal_link_suggestions (source_article_id, target_article_id, anchor_text, reason, score) values (${ids.evergreen}, ${ids["new-one"]}, 'new one', 'related', 0.8)`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setDbForTests(undefined);
});

describe("promotion strategies", () => {
  it("finds what each strategy applies to now", async () => {
    const plan = Object.fromEntries((await promotionPlan(NOW)).map((s) => [s.id, s]));
    expect(Object.keys(plan)).toEqual(["launch", "evergreen", "refresh", "syndicate", "community", "internal", "digest"]);
    expect(plan.launch!.items.map((i) => i.path)).toEqual(["/blog/new-one"]);
    expect(plan.launch!.items[0]!.why).toMatch(/1 draft\(s\) to review/);
    // Still earning clicks and not shared for 90 days: evergreen, not the one shared 20 days ago.
    expect(plan.evergreen!.items.map((i) => i.path)).toEqual(["/blog/evergreen"]);
    expect(plan.refresh!.items.map((i) => i.path)).toEqual(["/blog/decaying"]);
    expect(plan.refresh!.items[0]!.why).toBe("40 → 10 search clicks (28 days)");
    expect(plan.syndicate!.items.map((i) => i.path)).not.toContain("/blog/decaying"); // already on dev.to
    expect(plan.syndicate!.items.map((i) => i.path)).not.toContain("/blog/new-one"); // too new
    expect(plan.syndicate!.items[0]!.url).toMatch(/^https:\/\/jithendar\.com\/blog\//);
    expect(plan.community!.items).toEqual([expect.objectContaining({ path: "/blog/new-one", url: "https://reddit.com/r/kubernetes/1" })]);
    expect(plan.internal!.items).toEqual([expect.objectContaining({ path: "/blog/new-one", why: "1 suggested link(s) from related articles" })]);
    expect(plan.digest!.digest).toMatch(/^Subject: New on the site: Article new-one/);
    expect(plan.digest!.digest).toContain("utm_source=newsletter");
    expect(plan.digest!.digest).toContain("From the archive, still useful:\n- Article evergreen");
  });

  it("reshare reopens only channels posted over 90 days ago, keeping the record; dismissed stay dismissed", async () => {
    expect(await reopenForReshare(ids.evergreen!, NOW)).toBe(1);
    const rows = rowsOf<{ channel: string; status: string; posted_url: string | null; draft_body: string | null; draft_notes: string | null }>(
      await db.execute(sql`select channel, status, posted_url, draft_body, draft_notes from seo_promo_opportunities where article_id = ${ids.evergreen} order by channel`),
    );
    expect(rows).toEqual([
      { channel: "linkedin", status: "open", posted_url: "https://linkedin.com/p/1", draft_body: null, draft_notes: expect.stringMatching(/^Reshare: last shared \d{4}-\d{2}-\d{2}\. Use a new angle/) },
      expect.objectContaining({ channel: "x", status: "dismissed" }),
    ]);
    expect(await reopenForReshare(ids["shared-recently"]!, NOW)).toBe(0); // shared 20 days ago
  });
});
