import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const catalog = await import("@/lib/crewai/catalog");
const shared = await import("@/lib/crewai/catalog-shared");
const custom = await import("@/lib/crewai/custom");
const { handleCallback } = await import("@/lib/seo-agent/internal-server");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");

/**
 * The one catalogue of crews and flows (migration 0041, D-100): every crew and flow has the same lifecycle, categories
 * and tags, the same filters; the agent checks specs (POST /custom/validate, mocked: it echoes the spec, refuses the key
 * "refused") and copies code crews (POST /crews/{crew}/as-spec, mocked).
 */
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const CB = "c".repeat(40);
const cb = (method: string, p: string, body?: unknown) => handleCallback(method, `/internal/seo-agent${p}`, `Bearer ${CB}`, body, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB });
const env = { ...process.env };
let db: Db;
let calls: { path: string; body: Record<string, unknown> }[] = [];

const CREW = { key: "explainer", label: "Explainer", inputs: ["topic"], agents: [{ key: "writer", role: "Writer", goal: "Write well", backstory: "Plain", tools: [] }], tasks: [{ key: "write", agent: "writer", label: "Write", instructions: "Write {topic}.", expected_output: "MDX", context: [] }] };
const FLOW = { key: "explain_topic", label: "Explain a topic", inputs: ["topic"], steps: [{ kind: "crew", crew: "explainer", inputs: { topic: "{input.topic}" }, save_as: "result" }, { kind: "draft", title: "{input.topic}", body: "{steps.result}", collection: "blog" }] };
const MIGRATION = readFileSync(path.resolve(import.meta.dirname, "../src/db/migrations/0041_crewai_catalogue.sql"), "utf8");

async function rerunMigration() {
  for (const stmt of MIGRATION.split("--> statement-breakpoint")) if (stmt.trim()) await db.execute(sql.raw(stmt));
}

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "jithendar-dharmapuri", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  Object.assign(process.env, { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "a".repeat(40), SEO_AGENT_CALLBACK_TOKEN: CB, SEO_AGENT_URL: "http://seo-agent.test:8080" });
  calls = [];
  vi.stubGlobal("fetch", (async (u: string | URL, init?: RequestInit) => {
    const p = new URL(String(u)).pathname;
    const b = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path: p, body: b });
    if (p === "/custom/validate") {
      const spec = b.spec as { key: string };
      if (spec.key === "refused") return Response.json({ error: "invalid spec", issues: ["agents.0.tools: shell is not allowed"] }, { status: 422 });
      return Response.json({ spec: b.spec });
    }
    const m = /^\/crews\/([a-z_]+)\/as-spec$/.exec(p);
    if (m) return Response.json({ spec: { ...CREW, key: b.key, label: b.label, description: `copy of ${m[1]}` }, dropped_tools: ["gsc_queries_for_page"] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...env };
});

describe("migration 0041", () => {
  it("lists every code crew and flow of the agent, with categories, and no runner flows", async () => {
    const crews = await catalog.allItems("crew", db);
    expect(crews.map((c) => c.key).sort()).toEqual(["editorial", "news", "optimization", "promotion", "report"]);
    expect(crews.every((c) => c.definition === "code" && c.enabled && c.categories.length > 0)).toBe(true);
    const flows = await catalog.allItems("flow", db);
    expect(flows.find((f) => f.key === "gsc_sync_flow")).toMatchObject({ label: "Search Console sync", definition: "code", flowName: "gsc_sync_flow", categories: ["seo", "automation"], start: "manual" });
    expect(flows.find((f) => f.key === "publish_flow")?.start).toBe("approval");
    expect(flows.map((f) => f.key)).not.toEqual(expect.arrayContaining(["custom_flow"]));
    expect(flows.some((f) => ["custom_flow", "news_job_flow", "crew_test_flow"].includes(f.key))).toBe(false);
    expect((await catalog.listCategories(db)).map((c) => c.slug)).toEqual(["seo", "content", "ai", "automation", "research", "monitoring", "custom"]);
  });

  it("copies custom crews and flows (keys, specs, versions, switches, deletions) and content flows, and can run again", async () => {
    await db.execute(sql`insert into seo_custom_crews (key, label, spec, version, enabled, updated_by) values ('explainer', 'Explainer', ${JSON.stringify(CREW)}::jsonb, 3, false, 'old admin')`);
    await db.execute(sql`insert into seo_custom_flows (key, label, spec, version, updated_by, deleted_at) values ('explain_topic', 'Explain a topic', ${JSON.stringify(FLOW)}::jsonb, 2, 'old admin', now())`);
    const [job] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_jobs (name, description, enabled) values ('Daily Kubernetes news', 'k8s', true) returning id`));
    await db.execute(sql`delete from crewai_flows where content_job_id = ${job!.id}::uuid`); // as if the job existed before 0041
    await rerunMigration();
    await rerunMigration(); // idempotent
    const crew = await catalog.getItem("crew", "explainer", db);
    expect(crew).toMatchObject({ definition: "spec", version: 3, enabled: false, categories: ["custom"], updatedBy: "old admin" });
    expect(crew?.spec).toMatchObject({ key: "explainer" });
    const flow = await catalog.getItem("flow", "explain_topic", db);
    expect(flow).toMatchObject({ definition: "spec", flowName: "custom_flow", version: 2, crews: ["explainer"] });
    expect(flow?.deletedAt).not.toBeNull();
    expect((await catalog.specVersions("crew", "explainer", db)).map((v) => v.version)).toEqual([3]);
    const content = await catalog.contentFlowOf(job!.id, db);
    expect(content).toMatchObject({ label: "Daily Kubernetes news", definition: "content", flowName: "news_job_flow", enabled: true, crews: ["news"], categories: ["content"] });
  });

  it("keeps a content flow's row in step with its news_jobs row", async () => {
    const [job] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_jobs (name, enabled) values ('Weekly AI digest', false) returning id`));
    expect((await catalog.contentFlowOf(job!.id, db))?.label).toBe("Weekly AI digest");
    await db.execute(sql`update news_jobs set name = 'Weekly AI roundup', enabled = true where id = ${job!.id}::uuid`);
    expect(await catalog.contentFlowOf(job!.id, db)).toMatchObject({ label: "Weekly AI roundup", enabled: true });
    await db.execute(sql`update news_jobs set next_run_at = now() where id = ${job!.id}::uuid`); // what the agent writes: no catalogue write
    const key = (await catalog.contentFlowOf(job!.id, db))!.key;
    await catalog.setEnabled("flow", admin, key, false);
    expect(rowsOf<{ enabled: boolean }>(await db.execute(sql`select enabled from news_jobs where id = ${job!.id}::uuid`))[0]?.enabled).toBe(false);
    await catalog.updateItem("flow", admin, key, { label: "AI roundup", categories: ["content", "ai"], tags: ["weekly"] });
    expect(rowsOf<{ name: string }>(await db.execute(sql`select name from news_jobs where id = ${job!.id}::uuid`))[0]?.name).toBe("AI roundup");
  });
});

describe("one lifecycle for every crew and flow", () => {
  it("creates, edits, versions and restores a spec crew; the agent checks every spec", async () => {
    const c = await catalog.createItem("crew", admin, { key: "explainer", label: "Explainer", objective: "Explain one topic", categories: ["content"], tags: ["Beginners", "beginners"], spec: CREW });
    expect(c).toMatchObject({ definition: "spec", version: 1, tags: ["beginners"], objective: "Explain one topic" });
    const c2 = await catalog.updateItem("crew", admin, "explainer", { spec: { ...CREW, tasks: [{ ...CREW.tasks[0], instructions: "Explain {topic} simply." }] }, note: "simpler" });
    expect(c2.version).toBe(2);
    expect((await catalog.specVersions("crew", "explainer")).map((v) => [v.version, v.note])).toEqual([[2, "simpler"], [1, "created"]]);
    expect((await catalog.restoreVersion("crew", admin, "explainer", 1)).version).toBe(3);
    await expect(catalog.createItem("crew", admin, { key: "refused", label: "Nope", spec: { ...CREW, key: "refused" } })).rejects.toMatchObject({ status: 422, issues: ["agents.0.tools: shell is not allowed"] });
    await expect(catalog.createItem("crew", admin, { key: "explainer", label: "Again", spec: CREW })).rejects.toMatchObject({ status: 409 });
    await expect(catalog.createItem("crew", admin, { key: "new", label: "Reserved", spec: CREW })).rejects.toMatchObject({ status: 400 });
    await expect(catalog.createItem("crew", admin, { key: "x_y", label: "Bad category", categories: ["nope"], spec: CREW })).rejects.toMatchObject({ status: 400 });
  });

  it("edits a code crew's and a code flow's name, objective, categories and tags, but not their code", async () => {
    const c = await catalog.updateItem("crew", admin, "report", { label: "Weekly report crew", objective: "Brief the owner", categories: ["seo", "research"], tags: ["weekly"] });
    expect(c).toMatchObject({ label: "Weekly report crew", objective: "Brief the owner", categories: ["seo", "research"], tags: ["weekly"], definition: "code" });
    await expect(catalog.updateItem("crew", admin, "report", { spec: CREW })).rejects.toMatchObject({ status: 400 });
    const f = await catalog.updateItem("flow", admin, "gsc_sync_flow", { label: "GSC sync", categories: ["automation"] });
    expect(f).toMatchObject({ label: "GSC sync", categories: ["automation"] });
  });

  it("switches any flow off and on: a code flow switched off is served to the agent as refused", async () => {
    await catalog.setEnabled("flow", admin, "gsc_sync_flow", false, "quota exhausted");
    await catalog.deleteItem("flow", admin, "tech_audit_flow");
    const r = await cb("GET", "/flow-switches");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ disabled: [{ flow: "gsc_sync_flow", reason: "quota exhausted" }, { flow: "tech_audit_flow", reason: "deleted in the admin" }] });
    await catalog.restoreItem("flow", admin, "tech_audit_flow");
    await catalog.setEnabled("flow", admin, "tech_audit_flow", true);
    await catalog.setEnabled("flow", admin, "gsc_sync_flow", true);
    expect((await cb("GET", "/flow-switches")).body).toEqual({ disabled: [] });
  });

  it("refuses to switch off or delete a crew a flow runs, and to switch on a flow whose crew is off", async () => {
    await catalog.createItem("crew", admin, { key: "explainer", label: "Explainer", spec: CREW });
    await catalog.createItem("flow", admin, { key: "explain_topic", label: "Explain a topic", spec: FLOW });
    await expect(catalog.setEnabled("crew", admin, "explainer", false)).rejects.toMatchObject({ status: 409 });
    await expect(catalog.deleteItem("crew", admin, "explainer")).rejects.toMatchObject({ status: 409 });
    await expect(catalog.setEnabled("crew", admin, "editorial", false)).rejects.toMatchObject({ status: 409 }); // new_article_flow runs it
    await catalog.setEnabled("flow", admin, "explain_topic", false);
    await catalog.setEnabled("crew", admin, "explainer", false);
    await expect(catalog.setEnabled("flow", admin, "explain_topic", true)).rejects.toMatchObject({ status: 409 });
    expect((await cb("GET", "/custom-crews")).body).toEqual({ items: [] });
  });

  it("deletes and restores: a spec flow's schedules go, a code flow's schedules are paused", async () => {
    await catalog.createItem("crew", admin, { key: "explainer", label: "Explainer", spec: CREW });
    await catalog.createItem("flow", admin, { key: "explain_topic", label: "Explain a topic", spec: FLOW });
    await db.execute(sql`insert into seo_flow_schedules (name, flow_name, cron, inputs) values ('explain-daily', 'custom_flow', '0 7 * * *', '{"flow": "explain_topic"}'::jsonb)`);
    expect((await catalog.deleteItem("flow", admin, "explain_topic")).schedulesRemoved).toBe(1);
    expect((await catalog.getItem("flow", "explain_topic"))?.deletedAt).not.toBeNull();
    expect((await catalog.listCatalog("flow", { status: "deleted" })).items.map((i) => i.key)).toEqual(["explain_topic"]);
    const back = await catalog.restoreItem("flow", admin, "explain_topic");
    expect(back).toMatchObject({ enabled: false, deletedAt: null });
    expect((await catalog.deleteItem("flow", admin, "report_flow")).schedulesPaused).toBe(2); // weekly and monthly
    await expect(catalog.createItem("flow", admin, { key: "report_flow", label: "Taken", spec: FLOW })).rejects.toMatchObject({ status: 409 });
  });

  it("duplicates any crew or flow as one defined by a spec, switched off", async () => {
    const { item, notes } = await catalog.duplicateItem("crew", admin, "editorial", { key: "my_editorial", label: "My editorial" });
    expect(item).toMatchObject({ key: "my_editorial", definition: "spec", enabled: false, categories: ["content"] });
    expect(notes[0]).toContain("gsc_queries_for_page");
    expect(calls.find((c) => c.path === "/crews/editorial/as-spec")?.body).toMatchObject({ key: "my_editorial", config: null });
    const f = await catalog.duplicateItem("flow", admin, "gsc_sync_flow");
    expect(f.item).toMatchObject({ key: "gsc_sync_copy", label: "Search Console sync (copy)", definition: "spec", flowName: "custom_flow" });
    expect(f.item.spec?.steps).toEqual([{ kind: "flow", flow: "gsc_sync_flow", inputs: {}, save_as: "result", label: "Search Console sync" }]);
    const again = await catalog.duplicateItem("crew", admin, "my_editorial", { key: "my_editorial_2" });
    expect(again.item.spec).toMatchObject({ key: "my_editorial_2", label: "My editorial (copy)" });
  });
});

describe("filters", () => {
  beforeEach(async () => {
    await catalog.createItem("crew", admin, { key: "explainer", label: "Explainer", description: "Explains Kubernetes topics", categories: ["content", "research"], tags: ["k8s"], spec: CREW });
    await catalog.createItem("flow", admin, { key: "explain_topic", label: "Explain a topic", categories: ["content"], tags: ["k8s", "weekly"], spec: FLOW });
    await db.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, inputs, started_at, triggered_by) values
      (gen_random_uuid(), 'gsc_sync_flow', 'site', 'succeeded', '{}'::jsonb, now() - interval '2 days', 'cron'),
      (gen_random_uuid(), 'gsc_sync_flow', 'site', 'failed', '{}'::jsonb, now() - interval '1 day', 'cron'),
      (gen_random_uuid(), 'custom_flow', 'custom:explain_topic', 'succeeded', '{"flow": "explain_topic"}'::jsonb, now(), 'manual')`);
  });

  it("searches names and descriptions, filters by categories, tags, status and last run, sorts and pages", async () => {
    expect((await catalog.listCatalog("crew", { q: "kubernetes" })).items.map((i) => i.key)).toEqual(["explainer"]);
    expect((await catalog.listCatalog("flow", { categories: ["research", "seo"] })).items.every((i) => i.categories.some((c) => ["research", "seo"].includes(c)))).toBe(true);
    expect((await catalog.listCatalog("flow", { tags: ["weekly"] })).items.map((i) => i.key)).toEqual(["explain_topic"]);
    const failed = await catalog.listCatalog("flow", { run: "failed" });
    expect(failed.items.map((i) => i.key)).toEqual(["gsc_sync_flow"]);
    expect(failed.items[0]?.runs).toMatchObject({ total: 2, last: { status: "failed" } });
    const byRuns = await catalog.listCatalog("flow", { sort: "runs" });
    expect(byRuns.items[0]?.key).toBe("gsc_sync_flow");
    const page2 = await catalog.listCatalog("flow", { pageSize: 10, page: 2 });
    expect(page2.total).toBe(22);
    expect(page2.items).toHaveLength(10);
    expect((await catalog.listCatalog("crew", {})).items.find((i) => i.key === "explainer")?.runs.total).toBe(1); // via the flow that runs it
    const facets = (await catalog.listCatalog("flow", { categories: ["content"] })).facets;
    expect(facets.categories.find((c) => c.value === "seo")?.n).toBeGreaterThan(0); // facets ignore the selected categories
    await catalog.setEnabled("flow", admin, "explain_topic", false);
    expect((await catalog.listCatalog("flow", { status: "disabled" })).items.map((i) => i.key)).toEqual(["explain_topic"]);
    expect((await catalog.listCatalog("crew", { recent: "created_7d" })).total).toBe(6);
  });

  it("reads and writes the same query string", () => {
    const f = shared.parseFilter(new URLSearchParams("q=sync&category=seo,automation&tag=k8s&status=disabled&run=failed&sort=runs&dir=desc&page=2&size=50&bogus=1"));
    expect(f).toMatchObject({ q: "sync", categories: ["seo", "automation"], tags: ["k8s"], status: "disabled", run: "failed", sort: "runs", dir: "desc", page: 2, pageSize: 50 });
    expect(shared.filterQuery(f)).toBe("q=sync&category=seo%2Cautomation&tag=k8s&status=disabled&run=failed&sort=runs&dir=desc&page=2&size=50");
    expect(shared.filterQuery(shared.parseFilter({}))).toBe("");
    expect(shared.parseFilter({ status: "weird", sort: "nope", page: "-3" })).toMatchObject({ status: "active", sort: "name", page: 1 });
  });
});

describe("categories", () => {
  it("are created, renamed and removed; removing one takes it off every crew and flow", async () => {
    const c = await catalog.createCategory(admin, { label: "Social media" });
    expect(c.slug).toBe("social-media");
    await expect(catalog.createCategory(admin, { label: "Social media" })).rejects.toMatchObject({ status: 409 });
    await catalog.updateItem("flow", admin, "promotion_flow", { categories: ["content", "social-media"] });
    expect((await catalog.updateCategory(admin, "social-media", { label: "Social" })).label).toBe("Social");
    expect((await catalog.getItem("flow", "promotion_flow"))?.categories).toEqual(["content", "social-media"]); // the slug stays
    expect((await catalog.listCategories()).find((x) => x.slug === "social-media")?.flows).toBe(1);
    expect(await catalog.deleteCategory(admin, "social-media")).toEqual({ crews: 0, flows: 1 });
    expect((await catalog.getItem("flow", "promotion_flow"))?.categories).toEqual(["content"]);
  });
});

describe("what the agent reads, and the old custom API", () => {
  it("serves the enabled spec crews and flows, adds what a newer agent reports, and keeps the old custom API working", async () => {
    await custom.saveCustom("crew", admin, CREW);
    await custom.saveCustom("flow", admin, FLOW);
    expect((await custom.saveCustom("crew", admin, { ...CREW, label: "Explainer 2" })).version).toBe(2);
    expect((await cb("GET", "/custom-crews")).body).toMatchObject({ items: [{ key: "explainer", version: 2 }] });
    expect((await cb("GET", "/custom-flows")).body).toMatchObject({ items: [{ key: "explain_topic", version: 1 }] });
    expect((await catalog.getItem("crew", "explainer"))?.categories).toEqual(["custom"]);
    await expect(custom.saveCustom("crew", admin, { ...CREW, key: "report" })).rejects.toMatchObject({ status: 409 });
    const added = await catalog.syncFromAgent(
      [{ name: "backlinks_sync_flow", label: "Backlinks sync", description: "Imports backlinks.", categories: ["seo", "nope"], start: "manual", crews: [], inputs_schema: {}, approval_only: false, schedulable: true, mcp: false }, { name: "custom_flow", inputs_schema: {}, approval_only: false, schedulable: true, mcp: false, crews: [] }],
      [{ crew: "social", label: "Social crew", description: "", categories: ["content"], prompt_version: "v1", default_hash: "x", tools: [], models: [], replay_flows: [], agents: [], tasks: [] }],
    );
    expect(added).toBe(2);
    expect(await catalog.getItem("flow", "backlinks_sync_flow")).toMatchObject({ label: "Backlinks sync", categories: ["seo"], definition: "code" });
    expect(await catalog.getItem("flow", "custom_flow")).toBeNull();
    await catalog.updateItem("flow", admin, "backlinks_sync_flow", { label: "My backlinks" });
    await catalog.syncFromAgent([{ name: "backlinks_sync_flow", label: "Backlinks sync", crews: ["social"], inputs_schema: {}, approval_only: false, schedulable: true, mcp: false }], null);
    expect(await catalog.getItem("flow", "backlinks_sync_flow")).toMatchObject({ label: "My backlinks", crews: ["social"] }); // the admin's name stays
  });

  it("tells the agent the run-history switches", async () => {
    expect((await cb("GET", "/run-history/settings")).body).toEqual({ transcripts: true, logs: true, step_io: true });
  });
});
