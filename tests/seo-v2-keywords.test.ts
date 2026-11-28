import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";
import { fakeLiteLlm, LITELLM_ENV, LITELLM_PATH, noLiteLlm, useLiteLlm } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const K = await import("@/lib/seo-intel/keywords");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");

describe("CTR curve and click gap (pure)", () => {
  it("uses the site's own CTR where there is enough data, pooled to be non-increasing; sparse positions fall back", () => {
    const c = K.buildCurve([
      { pos: 1, clicks: 300, impressions: 1000 },
      { pos: 2, clicks: 100, impressions: 1000 },
      { pos: 3, clicks: 120, impressions: 1000 }, // violates monotonicity → pooled with pos 2
      { pos: 4, clicks: 1, impressions: 10 }, // too sparse → fallback
    ]);
    expect(c.ctr[0]).toBeCloseTo(0.3);
    expect(c.ctr[1]).toBeCloseTo(0.11);
    expect(c.ctr[2]).toBeCloseTo(0.11);
    expect(c.source.slice(0, 4)).toEqual(["site", "site", "site", "fallback"]);
    for (let i = 1; i < c.ctr.length; i++) expect(c.ctr[i]!).toBeLessThanOrEqual(c.ctr[i - 1]! + 1e-12);
    expect(K.curveAt(c, 2.4)).toBeCloseTo(0.11);
    expect(K.curveAt(c, 99)).toBe(c.ctr[29]);
  });
  it("click gap = impressions × (expected − actual CTR)", () => {
    expect(K.clickGap(1000, 20, 0.06)).toBeCloseTo(40);
    expect(K.clickGap(1000, 100, 0.06)).toBeCloseTo(-40); // beating the curve
    expect(K.clickGap(0, 0, 0.06)).toBe(0);
  });
});

describe("intent, clusters, cannibalization fix (pure)", () => {
  const brand = /jithendar/i;
  it.each([
    ["how kubernetes ingress works", "informational"],
    ["crashloopbackoff fix", "troubleshooting"],
    ["argo cd vs flux", "comparison"],
    ["best kubernetes monitoring tools", "commercial"],
    ["jithendar blog", "navigational"],
    ["istio docs", "navigational"],
  ])("rules: %s → %s", (q, intent) => expect(K.intentByRules(q, brand)).toBe(intent));

  it("groups similar queries; the parent topic is the cluster's top query", () => {
    const c = K.clusterQueries([
      { query: "kubernetes ingress tls", impressions: 900 },
      { query: "ingress tls kubernetes cert-manager", impressions: 300 },
      { query: "kubernetes ingress tls setup", impressions: 200 },
      { query: "terraform state locking", impressions: 500 },
      { query: "terraform state lock dynamodb", impressions: 100 },
    ], 0.5);
    expect(c.get("kubernetes ingress tls setup")!.parent).toBe("kubernetes ingress tls");
    expect(c.get("ingress tls kubernetes cert-manager")!.id).toBe(c.get("kubernetes ingress tls")!.id);
    expect(c.get("terraform state lock dynamodb")!.parent).toBe("terraform state locking");
    expect(c.get("terraform state locking")!.id).not.toBe(c.get("kubernetes ingress tls")!.id);
  });

  it("suggests link / consolidate / differentiate — never delete", () => {
    expect(K.cannibalizationFix([{ share: 0.9, position: 3 }, { share: 0.1, position: 12 }]).action).toBe("link");
    expect(K.cannibalizationFix([{ share: 0.55, position: 6 }, { share: 0.45, position: 7.5 }]).action).toBe("consolidate");
    expect(K.cannibalizationFix([{ share: 0.6, position: 4 }, { share: 0.4, position: 14 }]).action).toBe("differentiate");
    for (const f of [K.cannibalizationFix([{ share: 0.55, position: 6 }, { share: 0.45, position: 7 }])]) expect(f.why).not.toMatch(/\bdelete (the|a|one)\b/i);
  });

  it("multi-column sort is allowlisted", () => {
    expect(K.orderByText("gap:desc,impressions:asc", "all")).toBe("gap desc nulls last, impressions asc nulls last, query asc");
    expect(K.orderByText("gap; drop table post:desc", "striking")).toBe("gap desc nulls last, query asc");
  });
});

describe("keyword views (SQL over seeded Search Console rows)", () => {
  let db: Db;
  const env = { ...process.env };
  const ASOF = "2026-11-08";
  const day = (n: number) => new Date(Date.parse(`${ASOF}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  async function seed(query: string, page: string, opts: { days: [number, number]; impressions: number; clicks: number; position: number }) {
    const rows = [];
    for (let d = opts.days[0]; d <= opts.days[1]; d++) rows.push(sql`(${day(d)}, ${`https://jithendar.com${page}`}, ${query}, 'web', 'mobile', 'ind', ${opts.clicks}, ${opts.impressions}, ${opts.impressions ? opts.clicks / opts.impressions : 0}, ${opts.position})`);
    await db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr, position) values ${sql.join(rows, sql`, `)}`);
  }
  beforeEach(async () => {
    db = await freshDb();
    await saveSeoSettings(settingsInput(), "admin");
    process.env.SITE_URL = "https://jithendar.com";
    noLiteLlm();
    // Curve data: lots of impressions at positions 1–3 with healthy CTR.
    await seed("brand anchor jithendar", "/", { days: [0, 89], impressions: 100, clicks: 30, position: 1 });
    await seed("curve two", "/blog/a", { days: [0, 89], impressions: 100, clicks: 15, position: 2 });
    // Striking distance: position 8, many impressions, few clicks → big gap.
    await seed("kubernetes ingress tls", "/blog/ingress", { days: [0, 27], impressions: 40, clicks: 0, position: 8 });
    await seed("kubernetes ingress tls", "/blog/ingress", { days: [28, 55], impressions: 40, clicks: 0, position: 9 });
    // Low CTR: position 2 but no clicks.
    await seed("helm values schema", "/blog/helm", { days: [0, 27], impressions: 30, clicks: 0, position: 2 });
    // Rising: 5/day before, 20/day now.
    await seed("argo cd vs flux", "/blog/gitops", { days: [28, 55], impressions: 5, clicks: 0, position: 15 });
    await seed("argo cd vs flux", "/blog/gitops", { days: [0, 27], impressions: 20, clicks: 1, position: 12 });
    // New: first seen 10 days ago.
    await seed("karpenter consolidation", "/blog/scaling", { days: [0, 9], impressions: 6, clicks: 0, position: 18 });
    // Lost: impressions only in the previous period.
    await seed("old kubectl alias", "/blog/old", { days: [28, 55], impressions: 4, clicks: 0, position: 11 });
    // Cannibalization: two pages for one query.
    await seed("istio mtls", "/blog/istio", { days: [0, 27], impressions: 10, clicks: 1, position: 6 });
    await seed("istio mtls", "/blog/mesh", { days: [0, 27], impressions: 8, clicks: 0, position: 7 });
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const p = (o: Record<string, string>) => K.parseKwParams(o);

  it("all view: aggregated metrics, expected CTR from the site's curve, click gap, change, best page, total for pagination", async () => {
    const r = await K.keywordTable(p({ view: "all", sort: "gap:desc", limit: "50" }));
    expect(r.asOf).toBe(ASOF);
    const row = r.rows.find((x) => x.query === "kubernetes ingress tls")!;
    expect(row).toMatchObject({ impressions: 1120, clicks: 0, page: "https://jithendar.com/blog/ingress" });
    expect(row.position).toBeCloseTo(8);
    expect(row.change).toBeCloseTo(1); // 9 → 8 = improved by 1
    expect(row.expectedCtr).toBeCloseTo(K.curveAt(r.curve!, 8));
    expect(row.gap).toBeCloseTo(1120 * row.expectedCtr);
    const gaps = r.rows.map((x) => x.gap);
    expect(gaps).toEqual([...gaps].sort((a, b) => b - a)); // sorted by gap, largest first
    // position 2 with zero clicks has the largest gap: the site's curve expects ~15% CTR there
    expect(r.rows[0]!.query).toBe("helm values schema");
    expect(r.total).toBe(r.rows.length);
    const page2 = await K.keywordTable(p({ view: "all", limit: "10", offset: "2", sort: "query:asc" }));
    expect(page2.rows[0]!.query).toBe((await K.keywordTable(p({ view: "all", limit: "10", sort: "query:asc" }))).rows[2]!.query);
  });

  it("views: striking, low CTR, rising, new, lost", async () => {
    const q = async (view: string, extra: Record<string, string> = {}) => (await K.keywordTable(p({ view, ...extra }))).rows.map((x) => x.query);
    expect(await q("striking")).toContain("kubernetes ingress tls");
    expect(await q("striking")).not.toContain("helm values schema");
    expect(await q("low_ctr")).toEqual(["helm values schema"]);
    expect(await q("rising")).toContain("argo cd vs flux");
    expect(await q("new")).toContain("karpenter consolidation"); // first seen 10 days ago
    expect(await q("new")).not.toContain("argo cd vs flux"); // seen in the previous period too
    expect(await q("new")).not.toContain("kubernetes ingress tls");
    expect(await q("lost")).toEqual(["old kubectl alias"]);
  });

  it("filters: position range, impressions, brand split, ignore list", async () => {
    const q = async (extra: Record<string, string>) => (await K.keywordTable(p({ view: "all", ...extra }))).rows.map((x) => x.query);
    expect(await q({ posMin: "5", posMax: "10" })).toEqual(expect.arrayContaining(["kubernetes ingress tls", "istio mtls"]));
    expect((await q({ imprMin: "1000" })).sort()).toEqual(["brand anchor jithendar", "curve two", "kubernetes ingress tls"].sort());
    expect(await q({ brand: "brand" })).toEqual(["brand anchor jithendar"]);
    expect(await q({ brand: "non_brand" })).not.toContain("brand anchor jithendar");
    await db.execute(sql`insert into seo_keyword_ignores (query) values ('kubernetes ingress tls')`);
    expect(await q({})).not.toContain("kubernetes ingress tls");
  });

  it("cannibalization: one query, two pages, split + volatility + suggested fix", async () => {
    const c = await K.cannibalization(p({ view: "cannibalization", imprMin: "10" }));
    const istio = c.find((x) => x.query === "istio mtls")!;
    expect(istio.pages.map((x) => x.page)).toEqual(["https://jithendar.com/blog/istio", "https://jithendar.com/blog/mesh"]);
    expect(istio.pages.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1);
    expect(istio.volatility).toBe(0); // /blog/istio led every day
    expect(istio.fix.action).toBe("consolidate");
  });

  it("refresh: clusters + rules intents without LiteLLM; LiteLLM's fast alias with it (cached, logged)", async () => {
    const r1 = await K.refreshKeywords();
    expect(r1.clustered).toBeGreaterThan(0);
    expect(r1.byLlm).toBe(0);
    const [it1] = rowsOf<{ intent: string; source: string }>(await db.execute(sql`select intent, source from seo_query_intents where query = 'argo cd vs flux'`));
    expect(it1).toEqual({ intent: "comparison", source: "rules" });
    // With LiteLLM: only new queries are classified, by its fast alias.
    await db.execute(sql`delete from seo_query_intents where query in ('helm values schema', 'karpenter consolidation')`);
    useLiteLlm();
    const api = fakeLiteLlm({ answers: [JSON.stringify({ items: [{ query: "helm values schema", intent: "informational" }, { query: "karpenter consolidation", intent: "commercial" }] })] });
    const r2 = await K.refreshKeywords({ fetchImpl: api.fetchImpl });
    expect(r2.byLlm).toBe(2);
    const req = api.calls.find((c) => c.path === LITELLM_PATH)!;
    expect(req.body!.model).toBe("ops-claude-haiku-latest");
    expect(req.headers.get("authorization")).toBe(`Bearer ${LITELLM_ENV.LITELLM_API_KEY}`);
    expect(JSON.stringify(req.body!.messages)).toContain('<data name=\\"queries\\">');
    const [it2] = rowsOf<{ intent: string; source: string; model: string }>(await db.execute(sql`select intent, source, model from seo_query_intents where query = 'karpenter consolidation'`));
    expect(it2).toEqual({ intent: "commercial", source: "llm", model: "ops-claude-haiku-latest" });
    expect(rowsOf(await db.execute(sql`select 1 from seo_llm_usage where purpose = 'intent'`))).toHaveLength(1);
    // content gaps need clusters: the rising query sits at position 12–15 with enough impressions? (gap threshold from settings)
    const gaps = await K.contentGaps(p({ view: "gaps" }));
    expect(gaps.every((g) => g.bestPosition === null || g.bestPosition > 15)).toBe(true);
    const intents = await K.keywordTable(p({ view: "all", intent: "comparison" }));
    expect(intents.rows.map((x) => x.query)).toEqual(["argo cd vs flux"]);
  });

  it("tracked keywords: history and an alert when the 7-day position moves more than N", async () => {
    await db.execute(sql`insert into seo_tracked_keywords (query) values ('argo cd vs flux')`);
    await db.execute(sql`update seo_gsc_query_daily set position = 4 where query = 'argo cd vs flux' and date > ${day(7)}`);
    const sent: string[] = [];
    await saveSeoSettings({ ...settingsInput(), drafts: { ...settingsInput().drafts, digest: { ...settingsInput().drafts.digest, recipients: ["owner@example.com"] } } }, "admin");
    const a = await K.trackedAlerts(new Date(`${ASOF}T12:00:00Z`), { send: async (_to, subject) => (sent.push(subject), true), mailReady: async () => true });
    expect(a).toEqual([expect.objectContaining({ query: "argo cd vs flux", delta: 8 })]);
    expect(sent[0]).toMatch(/1 tracked keyword moved/);
    expect(await K.trackedAlerts(new Date(`${ASOF}T13:00:00Z`))).toEqual([]); // not again within 6 days
    const t = await K.trackedKeywords();
    expect(t.rows[0]!.history).toHaveLength(90);
  });
});

describe("migration 0014", () => {
  it("applies, rolls back and re-applies", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrateDb, migrationsDir } = await import("@/db/migrate");
    const pg = new PGlite();
    const clean = drizzle(pg, { schema }) as unknown as Db;
    await migrateDb(clean);
    const n = async () => rowsOf(await clean.execute(sql`select 1 from information_schema.tables where table_name in ('seo_query_intents', 'seo_query_clusters', 'seo_tracked_keywords', 'seo_keyword_ignores', 'seo_saved_views')`)).length;
    expect(await n()).toBe(5);
    for (const stmt of fs.readFileSync(path.resolve(migrationsDir(), "../rollback/0014_seo_keywords.down.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await clean.execute(sql.raw(stmt));
    expect(await n()).toBe(0);
    expect(await migrateDb(clean)).toEqual(["0014_seo_keywords.sql"]);
    await pg.close();
  });
});
