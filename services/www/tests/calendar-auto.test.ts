import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const auto = await import("@/lib/seo-intel/calendar-auto");
const cal = await import("@/lib/seo-intel/calendar");
const { loadArticles } = await import("@/lib/seo-intel/data");
type AnalysisData = import("@/lib/seo-intel/data").AnalysisData;

const NOW = new Date("2026-11-18T08:00:00Z");
const DAY = "2026-11-10";
let db: Db;

const data = async () => ({ articles: await loadArticles(db) }) as unknown as AnalysisData;
const items = async () => (await cal.listCalendar()).all;
const bySource = async (source: string) => (await items()).filter((i) => i.source === source);

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  const [post] = await db
    .insert(schema.post)
    .values({ collection: "blog", slug: "kubernetes-ingress-tls", title: "Kubernetes ingress and TLS with cert-manager", description: "d", body: "b", category: "kubernetes", tags: ["kubernetes"], contentType: "tutorial", status: "published", publishedAt: new Date("2026-05-01T00:00:00Z"), authorId: "admin" })
    .returning();
  await db.execute(sql`insert into seo_url_map (url, path, article_id) values ('https://jithendar.com/blog/kubernetes-ingress-tls', '/blog/kubernetes-ingress-tls', ${post!.id})`);
});
afterEach(() => setDbForTests(undefined));

async function askGap(normalized: string, asked: number, cluster: number | null) {
  await db.execute(sql`insert into seo_ask_gaps (normalized, sample_question, asked, cluster_id, cluster_label) values (${normalized}, ${`${normalized}?`}, ${asked}, ${cluster}, ${cluster === null ? null : normalized})`);
}
async function idea(fp: string, title: string, score: number) {
  await db.execute(sql`insert into seo_content_ideas (fingerprint, title, angle, score) values (${fp}, ${title}, 'An angle readers asked for.', ${score})`);
}
async function cluster(label: string, queries: string[], impressions: number) {
  for (const q of queries) {
    await db.execute(sql`insert into seo_ml_query_clusters (query, cluster_id, cluster_label, model_version) values (${q}, ${label.length}, ${label}, 'v1')`);
    await db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr) values (${DAY}, 'https://jithendar.com/', ${q}, 'web', 'DESKTOP', 'ind', 3, ${Math.round(impressions / queries.length)}, 0.01)`);
  }
}

describe("automatic editorial calendar ideas", () => {
  it("adds reader questions asked enough times, once, and never brings back a deleted one", async () => {
    await askGap("how to rotate argo cd secrets", 2, 7);
    await askGap("argo cd secret rotation", 1, 7);
    await askGap("what is a pod disruption budget", 1, null); // asked once: below the threshold
    const added = await auto.addAutomaticIdeas(db, await data(), NOW);
    expect(added.ask).toBe(1);
    const [item] = await bySource("ai");
    expect(item).toMatchObject({ title: "how to rotate argo cd secrets", phase: "unscheduled", draft: "none" });
    expect(item!.brief).toMatchObject({ source: "ask" });
    expect((await auto.addAutomaticIdeas(db, await data(), NOW)).ask).toBe(0);
    await cal.deleteItem(item!.id);
    await askGap("how to rotate argo cd secrets again", 5, null);
    await db.execute(sql`update seo_ask_gaps set status = 'open', calendar_id = null where cluster_id = 7`); // even if reopened
    const again = await auto.addAutomaticIdeas(db, await data(), NOW);
    expect((await items()).some((i) => i.title === "how to rotate argo cd secrets")).toBe(false);
    expect(again.ask).toBe(1); // only the new question
  });

  it("adds the Promotion crew's high-scoring ideas, at most two a run", async () => {
    for (const [fp, title, score] of [["a", "Argo Rollouts canary analysis", 90], ["b", "Karpenter consolidation in practice", 85], ["c", "Cilium network policies step by step", 80], ["d", "A low-scoring idea about YAML", 40]] as const) await idea(fp, title, score);
    const added = await auto.addAutomaticIdeas(db, await data(), NOW);
    expect(added.promotion).toBe(auto.PER_SOURCE);
    expect((await bySource("ai")).map((i) => i.title).sort()).toEqual(["Argo Rollouts canary analysis", "Karpenter consolidation in practice"]);
    const [sent] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_content_ideas where status = 'sent'`));
    expect(sent!.n).toBe(2);
    expect((await auto.addAutomaticIdeas(db, await data(), NOW)).promotion).toBe(1); // the third next time; never the low one
  });

  it("adds ML query clusters with demand that no article covers", async () => {
    await cluster("argo rollouts canary", ["argo rollouts canary", "argo rollouts canary analysis", "canary deployment argo rollouts"], 600);
    await cluster("helm chart testing", ["helm chart testing"], 40); // too little demand
    await cluster("kubernetes ingress tls", ["kubernetes ingress tls", "ingress tls cert manager"], 900); // already an article
    const added = await auto.addAutomaticIdeas(db, await data(), NOW);
    expect(added.ml).toBe(1);
    const [item] = await bySource("ml");
    expect(item).toMatchObject({ title: "Argo Rollouts Canary: a practical guide", kind: "measured" });
    expect(item!.brief).toMatchObject({ source: "ml", supportingQueries: expect.arrayContaining(["argo rollouts canary", "argo rollouts canary analysis"]) });
    expect(item!.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ metric: "impressions", value: 600, source: "gsc" })]));
  });

  it("follows what readers engage with in Google Analytics with the next topic in that theme", async () => {
    await db.execute(sql`
      insert into seo_ga4_page_daily (date, landing_page, channel_group, device, country, new_vs_returning, sessions, engaged_sessions, user_engagement_duration)
      values (${DAY}, 'https://jithendar.com/blog/kubernetes-ingress-tls', 'Organic Search', 'desktop', 'India', 'new', 40, 32, 4800)`);
    const added = await auto.addAutomaticIdeas(db, await data(), NOW);
    expect(added.analytics).toBe(1);
    const [item] = await bySource("analytics");
    expect(item).toMatchObject({ cluster: "Kubernetes & EKS", category: "kubernetes", kind: "editorial_idea" });
    expect(String(item!.brief.gap)).toMatch(/32 engaged sessions/);
    expect(item!.brief).toMatchObject({ internalLinks: [expect.objectContaining({ path: "/blog/kubernetes-ingress-tls" })] });
  });

  it("a source that fails is skipped; the others still add their ideas", async () => {
    await db.execute(sql`drop table seo_content_ideas`);
    await askGap("how do i debug a crashloopbackoff pod", 3, null);
    const added = await auto.addAutomaticIdeas(db, await data(), NOW);
    expect(added).toMatchObject({ ask: 1, promotion: 0 });
  });

  it("stops while too many automatic ideas are still open", async () => {
    for (let i = 0; i < auto.OPEN_CAP; i++) {
      await db.execute(sql`insert into seo_editorial_calendar (fingerprint, title, status, kind, brief) values (${`open-${i}`}, ${`Open automatic idea ${i}`}, 'approved', 'editorial_idea', '{"source":"ml"}'::jsonb)`);
    }
    await idea("x", "A high-scoring idea that has to wait", 95);
    expect(await auto.addAutomaticIdeas(db, await data(), NOW)).toEqual({ ask: 0, promotion: 0, ml: 0, analytics: 0 });
    // Scheduling or drafting an open idea makes room.
    await db.execute(sql`update seo_editorial_calendar set target_date = '2026-12-01' where fingerprint = 'open-0'`);
    expect((await auto.addAutomaticIdeas(db, await data(), NOW)).promotion).toBe(1);
  });
});
