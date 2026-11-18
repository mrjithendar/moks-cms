import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

await import("@/lib/seo-intel/handlers");
const { runSeoJob, dueSlots } = await import("@/lib/seo-intel/jobs");
const { DEFAULT_SEO_SETTINGS, saveSeoSettings } = await import("@/lib/seo-intel/settings");
const { readSerp, monthSpend, backlinkOverview, DfsClient, DataForSeoError } = await import("@/lib/seo-intel/dataforseo");
const { keywordTable, parseKwParams } = await import("@/lib/seo-intel/keywords");

const ENV = { SITE_URL: "https://jithendar.com", DATAFORSEO_LOGIN: "login", DATAFORSEO_PASSWORD: "pw" };
const NOW = new Date("2026-11-11T10:00:00Z");
type Call = { path: string; task: Record<string, unknown>; auth: string | null };

/** Fake DataForSEO: answers by endpoint path; every response costs `cost`. */
function fakeDfs(answer: (path: string, task: Record<string, unknown>) => unknown, cost = 0.01) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.dataforseo.com/v3/", "");
    const task = (JSON.parse(String(init.body)) as Record<string, unknown>[])[0]!;
    calls.push({ path, task, auth: new Headers(init.headers).get("authorization") });
    const result = answer(path, task);
    if (result instanceof Response) return result;
    return Response.json({ status_code: 20000, status_message: "Ok.", cost, tasks: [{ status_code: 20000, status_message: "Ok.", cost, result: [result] }] });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const on = (over: Partial<typeof DEFAULT_SEO_SETTINGS.dataforseo> = {}) => settingsInput({ dataforseo: { ...DEFAULT_SEO_SETTINGS.dataforseo, enabled: true, ...over } });

describe("readSerp", () => {
  it("finds this site's organic position (www and subdomains count), the top results and an AI Overview", () => {
    const r = readSerp(
      {
        item_types: ["ai_overview", "organic", "people_also_ask"],
        items: [
          { type: "ai_overview" },
          { type: "organic", rank_group: 1, domain: "argo-cd.readthedocs.io", url: "https://argo-cd.readthedocs.io/x", title: "Docs" },
          { type: "featured_snippet", rank_group: 1, domain: "jithendar.com", url: "https://jithendar.com/snippet" },
          { type: "organic", rank_group: 2, domain: "www.jithendar.com", url: "https://www.jithendar.com/blog/argo", title: "Mine" },
        ],
      },
      "jithendar.com",
    );
    expect(r).toMatchObject({ position: 2, url: "https://www.jithendar.com/blog/argo", aiOverview: true });
    expect(r.top.map((t) => t.domain)).toEqual(["argo-cd.readthedocs.io", "jithendar.com"]);
    expect(readSerp(null, "jithendar.com")).toMatchObject({ position: null, aiOverview: false, top: [] });
  });
});

describe("DfsClient", () => {
  it("refuses a request that would cross the budget and maps DataForSEO errors", async () => {
    const { fetchImpl, calls } = fakeDfs(() => ({}));
    const c = new DfsClient({ login: "l", password: "p" }, 0.015, fetchImpl);
    await c.post("x", {}, 0.01);
    expect(c.spent).toBeCloseTo(0.01);
    await expect(c.post("x", {}, 0.01)).rejects.toMatchObject({ code: "budget" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from("l:p").toString("base64")}`);
    const denied = new DfsClient({ login: "l", password: "p" }, 1, (async () => new Response("", { status: 401 })) as unknown as typeof fetch);
    await expect(denied.post("x", {}, 0)).rejects.toBeInstanceOf(DataForSeoError);
    const funds = new DfsClient({ login: "l", password: "p" }, 1, (async () => Response.json({ status_code: 20000, tasks: [{ status_code: 40210, status_message: "Insufficient funds." }] })) as unknown as typeof fetch);
    await expect(funds.post("x", {}, 0)).rejects.toMatchObject({ code: "quota" });
  });
});

describe("DataForSEO jobs", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    const rows = [
      ["argo cd sync waves", 900],
      ["terraform state lock", 400],
      ["jithendar", 50],
    ].map(([q, i]) => sql`('2026-11-01', 'https://jithendar.com/blog/a', ${q}, 'web', 'desktop', 'ind', 3, ${i}, 0.01, 8)`);
    await db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr, position) values ${sql.join(rows, sql`, `)}`);
    await db.execute(sql`insert into seo_tracked_keywords (query) values ('gitops tutorial'), ('argo cd sync waves')`);
  });
  afterEach(() => setDbForTests(undefined));

  it("skips without credentials or while switched off, and schedules nothing while off", async () => {
    await saveSeoSettings(settingsInput(), "admin");
    expect((await runSeoJob({ type: "dataforseo_keywords", trigger: "manual" }, { env: ENV, now: () => NOW })).errorCode).toBe("disabled");
    await saveSeoSettings(on(), "admin");
    expect((await runSeoJob({ type: "dataforseo_keywords", trigger: "manual" }, { env: { SITE_URL: ENV.SITE_URL }, now: () => NOW })).errorCode).toBe("not_configured");
    const at = new Date("2026-11-11T12:00:00Z"); // a Wednesday
    expect(dueSlots(DEFAULT_SEO_SETTINGS, at).filter((d) => ["dataforseo_keywords", "serp_ranks", "backlinks"].includes(d.type))).toEqual([]);
    const enabled = { ...DEFAULT_SEO_SETTINGS, dataforseo: { ...DEFAULT_SEO_SETTINGS.dataforseo, enabled: true } };
    expect(dueSlots(enabled, at).map((d) => d.type)).toEqual(expect.arrayContaining(["dataforseo_keywords", "serp_ranks"]));
    expect(dueSlots(enabled, at).map((d) => d.type)).not.toContain("backlinks");
  });

  it("buys metrics for tracked keywords and top queries once, records the cost and shows them in the keyword table", async () => {
    await saveSeoSettings(on(), "admin");
    const { fetchImpl, calls } = fakeDfs((_p, task) => ({
      items: (task.keywords as string[]).filter((k) => k !== "jithendar").map((k) => ({ keyword: k, keyword_info: { search_volume: k.length * 10, cpc: 1.5, competition: 0.2, monthly_searches: [{ year: 2026, month: 10, search_volume: 100 }] }, keyword_properties: { keyword_difficulty: 42 }, search_intent_info: { main_intent: "informational" } })),
    }), 0.0115);
    const out = await runSeoJob({ type: "dataforseo_keywords", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(out.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("dataforseo_labs/google/keyword_overview/live");
    expect((calls[0]!.task.keywords as string[])[0]).toBe("argo cd sync waves"); // tracked first, then impressions
    expect(calls[0]!.task).toMatchObject({ location_code: 2840, language_code: "en" });
    const m = rowsOf<{ query: string; search_volume: number | null; keyword_difficulty: number | null }>(await db.execute(sql`select query, search_volume, keyword_difficulty from seo_keyword_metrics order by query`));
    expect(m.map((r) => r.query)).toEqual(["argo cd sync waves", "gitops tutorial", "jithendar", "terraform state lock"]);
    expect(m.find((r) => r.query === "jithendar")!.search_volume).toBeNull(); // no data: stored, not re-bought
    expect(await monthSpend(db, NOW)).toBeCloseTo(0.0115);

    const again = await runSeoJob({ type: "dataforseo_keywords", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(again.detail).toMatchObject({ upToDate: true });
    expect(calls).toHaveLength(1);

    const t = await keywordTable({ ...parseKwParams({ days: "90" }), sort: "volume:desc" });
    expect(t.rows[0]).toMatchObject({ query: "terraform state lock", volume: 200, difficulty: 42 });
  });

  it("stops at the monthly cap and keeps what it already bought", async () => {
    await saveSeoSettings(on({ monthlyBudgetUsd: 0.01, rankTracking: { ...DEFAULT_SEO_SETTINGS.dataforseo.rankTracking, depth: 10 } }), "admin");
    const { fetchImpl, calls } = fakeDfs(() => ({ items: [] }), 0.009);
    const out = await runSeoJob({ type: "serp_ranks", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(out).toMatchObject({ status: "partial", errorCode: "budget" });
    expect(calls).toHaveLength(1);
    const next = await runSeoJob({ type: "serp_ranks", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(next).toMatchObject({ status: "skipped", errorCode: "budget" });
  });

  it("records live positions of tracked keywords", async () => {
    await saveSeoSettings(on(), "admin");
    const { fetchImpl, calls } = fakeDfs((_p, task) => ({
      item_types: task.keyword === "gitops tutorial" ? ["organic"] : ["ai_overview", "organic"],
      items: task.keyword === "gitops tutorial" ? [{ type: "organic", rank_group: 1, domain: "example.com", url: "https://example.com/" }] : [{ type: "organic", rank_group: 3, domain: "jithendar.com", url: "https://jithendar.com/blog/a" }],
    }), 0.006);
    expect((await runSeoJob({ type: "serp_ranks", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW })).status).toBe("succeeded");
    expect(calls.map((c) => c.task.depth)).toEqual([30, 30]);
    const r = rowsOf<{ query: string; position: number | null; ai_overview: boolean }>(await db.execute(sql`select query, position, ai_overview from seo_serp_ranks order by query`));
    expect(r).toEqual([{ query: "argo cd sync waves", position: 3, ai_overview: true }, { query: "gitops tutorial", position: null, ai_overview: false }]);
  });

  it("diffs referring domains between snapshots", async () => {
    await saveSeoSettings(on({ backlinks: { enabled: true, weekday: 0, hourUtc: 5 } }), "admin");
    let domains = [{ domain: "a.example", rank: 300, backlinks: 2 }, { domain: "b.example", rank: 100, backlinks: 1 }];
    const { fetchImpl } = fakeDfs((path) => (path.startsWith("backlinks/summary") ? { backlinks: 3, referring_domains: domains.length, rank: 50 } : { items: domains }));
    await runSeoJob({ type: "backlinks", trigger: "manual" }, { env: ENV, fetchImpl, now: () => new Date("2026-11-01T05:00:00Z") });
    domains = [{ domain: "a.example", rank: 310, backlinks: 2 }, { domain: "c.example", rank: 200, backlinks: 4 }];
    await runSeoJob({ type: "backlinks", trigger: "manual" }, { env: ENV, fetchImpl, now: () => new Date("2026-11-08T05:00:00Z") });
    const o = await backlinkOverview();
    expect(o!.gained.map((d) => d.domain)).toEqual(["c.example"]);
    expect(o!.lost.map((d) => d.domain)).toEqual(["b.example"]);
    expect(o!.top.map((d) => d.domain)).toEqual(["a.example", "c.example"]);
  });
});
