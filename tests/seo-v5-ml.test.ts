import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";
import { fakeGoogle, FIXTURE_ENV, settingsInput } from "./seo-fixtures";
import { seedArticle } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const admin: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
vi.mock("@/lib/session", () => ({ getSessionUser: async () => admin, requireRole: async () => admin, requireUser: async () => admin }));

const ml = await import("@/lib/seo-intel/ml");
const { decayRule } = await import("@/lib/seo-intel/rules");
const { DEFAULT_SEO_SETTINGS, saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");

const NOW = new Date("2026-11-10T12:00:00Z");
const FRESH = "2026-11-08T00:00:00Z";
const STALE = "2026-10-01T00:00:00Z";
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
});
afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
});

async function model(kind: string, version: string, o: { active?: boolean; beats?: boolean; status?: string; metrics?: object } = {}) {
  await db.execute(sql`insert into seo_ml_models (kind, version, active, beats_rule, status, metrics, trained_at) values (${kind}, ${version}, ${o.active ?? false}, ${o.beats ?? o.active ?? false}, ${o.status ?? "trained"}, ${JSON.stringify(o.metrics ?? {})}::jsonb, ${FRESH})`);
}
async function decayRow(page: string, decaying: boolean, at = FRESH, method = "stl-v1") {
  const ev = { dates: ["2026-11-06", "2026-11-07", "2026-11-08"], actual: [10, 8, 6], trend: [9, 8, 7], falling_days: 30, z: 4 };
  await db.execute(sql`insert into seo_ml_decay_signals (page, window_start, window_end, decaying, trend_slope, drop_pct, confidence, method_version, evidence, computed_at)
    values (${page}, '2026-05-01', '2026-11-08', ${decaying}, -0.2, 0.35, 0.8, ${method}, ${JSON.stringify(method === "stl-v1" ? ev : { reason: "90 days of history (needs 120)" })}::jsonb, ${at})`);
}

describe("mlDecision: model only when active/forced and fresh; otherwise the rule", () => {
  it("no model → rule", async () => {
    expect(await ml.mlDecision(db, "decay", NOW)).toMatchObject({ mode: "rule", label: "rule", reason: "no model trained yet" });
  });
  it("trained but not beating the rule (or awaiting review) → rule", async () => {
    await model("decay", "v1", { active: false, beats: true, status: "needs_review" });
    await decayRow("https://jithendar.com/blog/a", true);
    expect((await ml.mlDecision(db, "decay", NOW)).mode).toBe("rule");
  });
  it("active and fresh → model vN", async () => {
    await model("decay", "v3", { active: true });
    await decayRow("https://jithendar.com/blog/a", true);
    expect(await ml.mlDecision(db, "decay", NOW)).toMatchObject({ mode: "model", label: "model v3", version: "v3" });
  });
  it("active but stale output (> 14 days) → rule (stale model output)", async () => {
    await model("decay", "v3", { active: true });
    await decayRow("https://jithendar.com/blog/a", true, STALE);
    expect(await ml.mlDecision(db, "decay", NOW)).toMatchObject({ mode: "rule", label: "rule (stale model output)" });
  });
  it("override rule beats an active model; override model uses an inactive one only while fresh", async () => {
    await model("decay", "v2", { active: true });
    await decayRow("https://jithendar.com/blog/a", true);
    await db.execute(sql`insert into seo_ml_overrides (kind, mode) values ('decay', 'rule')`);
    expect((await ml.mlDecision(db, "decay", NOW)).mode).toBe("rule");
    await db.execute(sql`update seo_ml_overrides set mode = 'model'`);
    await db.execute(sql`update seo_ml_models set active = false`);
    expect(await ml.mlDecision(db, "decay", NOW)).toMatchObject({ mode: "model", label: "model v2" });
    await db.execute(sql`update seo_ml_decay_signals set computed_at = ${STALE}`);
    expect(await ml.mlDecision(db, "decay", NOW)).toMatchObject({ mode: "rule", label: "rule (stale model output)" });
  });
  it("priority never applies by itself", async () => {
    await model("priority", "v1", { active: true });
    expect((await ml.mlDecision(db, "priority", NOW)).mode).toBe("rule");
  });
});

describe("decayRule with the STL model", () => {
  const page = "https://jithendar.com/blog/a";
  const base = () => ({
    asOf: "2026-11-08",
    periods: { cur: ["2026-10-12", "2026-11-08"] as [string, string], prev: ["2026-09-14", "2026-10-11"] as [string, string], yoy: ["2025-10-13", "2025-11-09"] as [string, string] },
    pageQuery: [],
    pages: new Map([[page, { cur: { clicks: 50, impressions: 900, position: 8 }, prev: { clicks: 100, impressions: 1500, position: 7 }, yoy: null }]]),
    yoyAvailable: false,
    articles: [],
    articleByUrl: new Map(),
    knownPaths: new Set<string>(),
  });
  const decision = (mode: "model" | "rule") => ({ kind: "decay" as const, mode, label: mode === "model" ? "model v3" : "rule", version: mode === "model" ? "v3" : null, reason: "", override: "auto" as const });
  const sig = (decaying: boolean, methodVersion = "stl-v1") => ({ page, decaying, trendSlope: -0.2, dropPct: 0.35, confidence: 0.8, methodVersion, evidence: { dates: ["2026-11-07", "2026-11-08"], actual: [8, 6], trend: [8, 7], falling_days: 30, z: 4 } });

  it("without ML data: the 28-day rule, labelled rule", () => {
    const [c] = decayRule(base(), DEFAULT_SEO_SETTINGS);
    expect(c!.ruleKey).toBe("content_decay.28d_only");
    expect(c!.evidence.find((e) => e.metric === "decay_method")?.valueText).toBe("rule");
  });
  it("model in use: the model decides (a −50 % 28-day drop the model calls noise is not flagged)", () => {
    expect(decayRule({ ...base(), ml: { decay: { decision: decision("model"), signals: new Map([[page, sig(false)]]) } } }, DEFAULT_SEO_SETTINGS)).toEqual([]);
    const [c] = decayRule({ ...base(), ml: { decay: { decision: decision("model"), signals: new Map([[page, sig(true)]]) } } }, DEFAULT_SEO_SETTINGS);
    expect(c!.ruleKey).toBe("content_decay.stl");
    expect(c!.evidence.find((e) => e.metric === "decay_method")?.valueText).toBe("model v3");
    expect(c!.evidence.find((e) => e.metric === "trend_vs_actual")?.detail).toMatchObject({ trend: [8, 7] });
    expect(c!.confidence).toBe("high");
  });
  it("model in use but too little history for a page: the rule, labelled rule (insufficient history)", () => {
    const [c] = decayRule({ ...base(), ml: { decay: { decision: decision("model"), signals: new Map([[page, sig(false, "insufficient_history")]]) } } }, DEFAULT_SEO_SETTINGS);
    expect(c!.ruleKey).toBe("content_decay.28d_only");
    expect(c!.evidence.find((e) => e.metric === "decay_method")?.valueText).toBe("rule (insufficient history)");
  });
  it("model disabled: signals are ignored", () => {
    const [c] = decayRule({ ...base(), ml: { decay: { decision: decision("rule"), signals: new Map([[page, sig(false)]]) } } }, DEFAULT_SEO_SETTINGS);
    expect(c!.ruleKey).toBe("content_decay.28d_only");
  });
});

describe("keyword refresh: clusters and intents from the models, with fallbacks", () => {
  async function seedQueries() {
    await db.execute(sql`insert into seo_gsc_daily_totals (date, search_type, clicks, impressions, ctr, position) values ('2026-11-08', 'web', 10, 100, 0.1, 5)`);
    for (const [q, imp] of [["istio strict mtls", 300], ["enable mtls istio", 200], ["terraform state lock", 150]] as const) {
      await db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr, position) values ('2026-11-08', 'https://jithendar.com/blog/a', ${q}, 'web', 'desktop', 'ind', 1, ${imp}, 0.01, 5)`);
    }
  }
  it("rule when no model; model clusters + rule for unseen queries when active; confident intents skip the LLM", async () => {
    const { refreshKeywords } = await import("@/lib/seo-intel/keywords");
    await saveSeoSettings({ ...settingsInput(), keywords: { ...settingsInput().keywords, classifyWithLlm: false } }, "admin");
    await seedQueries();
    let r = await refreshKeywords({ now: NOW });
    expect(r).toMatchObject({ clusterSource: "rule", intentSource: "rule", byModel: 0 });
    const src = rowsOf<{ source: string }>(await db.execute(sql`select distinct source from seo_query_clusters`));
    expect(src.map((x) => x.source)).toEqual(["rule"]);

    await db.execute(sql`delete from seo_query_intents`);
    await model("query_clusters", "v2", { active: true });
    await model("intent", "v4", { active: true, metrics: { threshold: 0.8 } });
    await db.execute(sql`insert into seo_ml_query_clusters (query, cluster_id, cluster_label, model_version, computed_at) values ('istio strict mtls', 7, 'istio strict mtls', 'v2', now()), ('enable mtls istio', 7, 'istio strict mtls', 'v2', now())`);
    await db.execute(sql`insert into seo_ml_intent_predictions (query, intent, confidence, model_version, computed_at) values ('istio strict mtls', 'informational', 0.95, 'v4', now()), ('enable mtls istio', 'troubleshooting', 0.5, 'v4', now())`);
    r = await refreshKeywords({ now: NOW });
    expect(r).toMatchObject({ clusterSource: "model v2", intentSource: "model v4", byModel: 1 });
    const cl = Object.fromEntries(rowsOf<{ query: string; cluster_id: number; source: string }>(await db.execute(sql`select query, cluster_id, source from seo_query_clusters`)).map((x) => [x.query, x]));
    expect(cl["enable mtls istio"]).toMatchObject({ cluster_id: 7, source: "model v2" });
    expect(cl["terraform state lock"]!.source).toBe("rule"); // not seen by the weekly model yet
    expect(Number(cl["terraform state lock"]!.cluster_id)).toBeGreaterThan(1_000_000);
    const it = Object.fromEntries(rowsOf<{ query: string; source: string; model: string | null }>(await db.execute(sql`select query, source, model from seo_query_intents`)).map((x) => [x.query, x]));
    expect(it["istio strict mtls"]).toMatchObject({ source: "model", model: "model v4" });
    expect(it["enable mtls istio"]!.source).toBe("rules"); // below the threshold → (LLM off here) the rules

    await db.execute(sql`update seo_ml_query_clusters set computed_at = ${STALE}`);
    expect((await refreshKeywords({ now: NOW })).clusterSource).toBe("rule (stale model output)");
  });
});

describe("related articles: A/B by id parity, override, freshness", () => {
  it("plans", async () => {
    const even = "00000000-0000-4000-8000-00000000000a";
    const odd = "00000000-0000-4000-8000-00000000000b";
    expect(ml.relatedArm(even)).toBe("model");
    expect(ml.relatedArm(odd)).toBe("rule");
    expect(await ml.relatedPlan(db, even, NOW)).toMatchObject({ use: "rule", arm: null }); // no model at all
    await model("related", "v1", { status: "experiment_running" });
    const a = await seedArticle(db, { slug: "a" });
    const b = await seedArticle(db, { slug: "b" });
    await db.execute(sql`insert into seo_ml_related_articles (article_id, related_id, rank, score, model_version, computed_at) values (${a.id}, ${b.id}, 1, 0.9, 'v1', now())`);
    expect(await ml.relatedPlan(db, even, new Date())).toMatchObject({ use: "model", arm: "model", label: "model v1 (A/B)" });
    expect(await ml.relatedPlan(db, odd, new Date())).toMatchObject({ use: "rule", arm: "rule" });
    await db.execute(sql`insert into seo_ml_overrides (kind, mode) values ('related', 'rule')`);
    expect(await ml.relatedPlan(db, even, new Date())).toMatchObject({ use: "rule", arm: null });
    await db.execute(sql`delete from seo_ml_overrides`);
    await db.execute(sql`update seo_ml_related_articles set computed_at = ${STALE}`);
    expect((await ml.relatedPlan(db, even, NOW)).use).toBe("rule");
    expect(await ml.mlRelated(db, a.id, 3)).toEqual([{ id: b.id, score: 0.9 }]);
  });
});

describe("ask gaps use the embedding clusters when that model is in use", () => {
  it("clusters", async () => {
    const gaps = await import("@/lib/seo-agent/gaps");
    for (const [n, q] of [["how to schedule gpu workloads volcano", "How to schedule GPU workloads with Volcano?"], ["volcano gang scheduling", "Volcano gang scheduling"]] as const) {
      await db.execute(sql`insert into seo_ask_gaps (normalized, sample_question, asked) values (${n}, ${q}, 2)`);
    }
    await gaps.clusterAskGaps();
    const rule = rowsOf<{ cluster_id: number }>(await db.execute(sql`select distinct cluster_id from seo_ask_gaps`));
    expect(rule.length).toBe(2); // token sets don't see these as one topic
    await model("query_clusters", "v1", { active: true });
    await db.execute(sql`insert into seo_ml_query_clusters (query, cluster_id, cluster_label, model_version) values ('ask:how to schedule gpu workloads volcano', 3, 'ask:volcano gang scheduling', 'v1'), ('ask:volcano gang scheduling', 3, 'ask:volcano gang scheduling', 'v1')`);
    await gaps.clusterAskGaps();
    const ml2 = rowsOf<{ cluster_id: number; cluster_label: string }>(await db.execute(sql`select distinct cluster_id, cluster_label from seo_ask_gaps`));
    expect(ml2).toEqual([{ cluster_id: 3, cluster_label: "volcano gang scheduling" }]);
  });
});

describe("admin: overrides, review, labels, weight proposals", () => {
  const req = (url: string, method: string, body?: unknown) =>
    new Request(`https://jithendar.com/api/admin/seo/${url}`, { method, headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it("override and review", async () => {
    const route = await import("@/app/api/admin/seo/models/[kind]/route");
    const p = (kind: string) => ({ params: Promise.resolve({ kind }) });
    expect((await route.PUT(req("models/x", "PUT", { override: "rule" }), p("nope"))).status).toBe(404);
    expect((await route.PUT(req("models/decay", "PUT", { override: "rule" }), p("decay"))).status).toBe(200);
    expect(await ml.mlOverride(db, "decay")).toBe("rule");
    await model("decay", "v1", { beats: true, status: "needs_review" });
    const r = await route.PUT(req("models/decay", "PUT", { approveReview: true }), p("decay"));
    expect(await r.json()).toMatchObject({ review: { reviewed: true, activated: true } });
    const [m] = rowsOf<{ active: boolean; reviewed_by: string }>(await db.execute(sql`select active, reviewed_by from seo_ml_models where kind = 'decay'`));
    expect(m).toMatchObject({ active: true });
    const audit = rowsOf<{ action: string }>(await db.execute(sql`select action from audit_log where action like 'seo.ml.%' order by created_at`));
    expect(audit.map((a) => a.action)).toEqual(["seo.ml.override", "seo.ml.review"]);
  });

  it("labels: confirm stores the suggestion, change stores the owner's answer", async () => {
    const route = await import("@/app/api/admin/seo/models/labels/route");
    await db.execute(sql`insert into seo_ml_labels (task, item, suggestion) values ('cluster', 'istio mtls', '{"group":"istio security"}'), ('intent_check', 'helm vs kustomize', '{"haiku":"comparison","model":"informational","confidence":0.6}')`);
    const ids = rowsOf<{ id: number; task: string }>(await db.execute(sql`select id, task from seo_ml_labels order by id`));
    expect((await route.PATCH(req("models/labels", "PATCH", { id: ids[0]!.id, status: "confirmed" }), { params: Promise.resolve({}) })).status).toBe(200);
    expect((await route.PATCH(req("models/labels", "PATCH", { id: ids[1]!.id, status: "changed", label: { intent: "informational" } }), { params: Promise.resolve({}) })).status).toBe(200);
    expect((await route.PATCH(req("models/labels", "PATCH", { id: ids[1]!.id, status: "changed" }), { params: Promise.resolve({}) })).status).toBe(404);
    const rows = rowsOf<{ status: string; label: { group?: string; intent?: string } }>(await db.execute(sql`select status, label from seo_ml_labels order by id`));
    expect(rows[0]).toMatchObject({ status: "confirmed", label: { group: "istio security" } });
    const list = await (await route.GET(req("models/labels?task=intent_check", "GET"), { params: Promise.resolve({}) })).json();
    expect(list.counts).toEqual({ changed: 1 });
  });

  it("an approved proposal becomes the scoring weights; a decided one can't be decided again", async () => {
    await saveSeoSettings(settingsInput(), "admin");
    const route = await import("@/app/api/admin/seo/models/proposals/[id]/route");
    const [p] = rowsOf<{ id: string }>(
      await db.execute(sql`insert into seo_ml_weight_proposals (model_version, weights, current_weights, metrics, n_outcomes) values ('v1', '{"searchOpportunity":50,"rankingOpportunity":10,"relevance":10,"qualityGap":10,"trend":10,"effort":10}', '{}', '{"ndcg10_proposed":0.8,"ndcg10_current":0.7}', 60) returning id`),
    );
    const ctx = { params: Promise.resolve({ id: p!.id }) };
    expect((await route.POST(req(`models/proposals/${p!.id}`, "POST", { decision: "approve" }), ctx)).status).toBe(200);
    expect((await getSeoSettings()).weights.searchOpportunity).toBe(50);
    expect((await route.POST(req(`models/proposals/${p!.id}`, "POST", { decision: "dismiss" }), ctx)).status).toBe(409);
  });
});

describe("GA4 page pairs (co-visitation) never break the GA4 sync", () => {
  async function run(unsupported: boolean) {
    const { runSeoJob } = await import("@/lib/seo-intel/jobs");
    await saveSeoSettings(settingsInput(), "admin");
    const deps = { fetchImpl: fakeGoogle({ ga4PairsUnsupported: unsupported }).fetch, sleep: async () => {}, env: FIXTURE_ENV, now: () => new Date("2026-10-27T12:00:00Z") };
    return runSeoJob({ type: "ga4_sync", trigger: "manual" }, deps);
  }
  it("supported: pairs stored", async () => {
    const r = await run(false);
    expect(r.status).toBe("succeeded");
    const n = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_ga4_page_pairs`));
    expect(Number(n[0]!.n)).toBeGreaterThan(0);
    const [cfg] = rowsOf<{ config: { pagePairs?: string } }>(await db.execute(sql`select config from seo_integrations where provider = 'ga4'`));
    expect(cfg!.config.pagePairs).toBe("ok");
  });
  it("unsupported: recorded, sync still succeeds", async () => {
    const r = await run(true);
    expect(r.status).toBe("succeeded");
    const [cfg] = rowsOf<{ config: { pagePairs?: string } }>(await db.execute(sql`select config from seo_integrations where provider = 'ga4'`));
    expect(cfg!.config.pagePairs).toBe("unsupported");
  });
});

describe("migrations 0018/0019", () => {
  it("apply, roll back and re-apply", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrateDb, migrationsDir } = await import("@/db/migrate");
    const clean = drizzle(new PGlite(), { schema }) as unknown as Db;
    await migrateDb(clean);
    const tables = async () => rowsOf<{ t: string }>(await clean.execute(sql`select table_name as t from information_schema.tables where table_name like 'seo_ml_%' or table_name in ('seo_ga4_page_pairs', 'seo_rag_eval_runs')`)).length;
    expect(await tables()).toBe(11);
    for (const f of ["0019_seo_v5_ml", "0018_seo_v5_rag"]) {
      const down = fs.readFileSync(path.join(migrationsDir(), "..", "rollback", `${f}.down.sql`), "utf8");
      for (const stmt of down.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await clean.execute(sql.raw(stmt));
    }
    expect(await tables()).toBe(0);
    await migrateDb(clean);
    expect(await tables()).toBe(11);
    await clean.execute(sql`insert into seo_ml_models (kind, version, active) values ('decay', 'v1', true)`);
    await expect(clean.execute(sql`insert into seo_ml_models (kind, version, active) values ('decay', 'v2', true)`)).rejects.toThrow(); // one active per kind
  });
});
