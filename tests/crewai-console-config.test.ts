import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Bundle, ImportPlan, ImportResult } from "@/lib/crewai/config-io";
import type { CrewVersion } from "@/lib/crewai/crews";
import type { Schedule } from "@/lib/crewai/schedules";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

/**
 * CrewAI console, phases 2 and 3 (D-98): schedules in the database (migration 0037) for the agent's one dispatcher,
 * Run with parameters, crew configuration versions with Test run, and import / export.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => "/admin/crewai/schedules", useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const schedules = await import("@/lib/crewai/schedules");
const crews = await import("@/lib/crewai/crews");
const io = await import("@/lib/crewai/config-io");
const { nextFire } = await import("@/lib/news/cron");
const { relative } = await import("@/components/crewai/Ago");
const { handleCallback } = await import("@/lib/seo-agent/internal-server");
const { clearAgentCache } = await import("@/lib/seo-agent/endpoint");
const scheduleRoute = await import("@/app/api/admin/crewai/schedules/route");
const scheduleIdRoute = await import("@/app/api/admin/crewai/schedules/[id]/route");
const flowRoute = await import("@/app/api/admin/crewai/flows/[name]/route");
const crewRoute = await import("@/app/api/admin/crewai/crews/[crew]/route");
const configRoute = await import("@/app/api/admin/crewai/config/route");
const { default: FlowsPage } = await import("@/app/admin/crewai/flows/page");
const { default: FlowPage } = await import("@/app/admin/crewai/flows/[name]/page");
const { default: SchedulesPage } = await import("@/app/admin/crewai/schedules/page");
const { default: CrewsPage } = await import("@/app/admin/crewai/crews/page");
const { default: CrewPage } = await import("@/app/admin/crewai/crews/[crew]/page");
const { default: ConfigPage } = await import("@/app/admin/crewai/config/page");
const { default: RunPage } = await import("@/app/admin/crewai/runs/[id]/page");
const { renderToStaticMarkup } = await import("react-dom/server");

const ADMIN: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
const AUTHOR: SessionUser = { ...ADMIN, id: "author", email: "author@example.com", role: "author" };
const CB_TOKEN = "c".repeat(40);
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const env = { ...process.env };

const req = (url: string, method = "GET", body?: unknown) =>
  new Request(`https://jithendar.com${url}`, { method, headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

/** What the agent's GET /crews says about the report crew (moks-seo-agent app/crews/config.py catalogue). */
const REPORT_CREW = {
  crew: "report",
  label: "Report crew",
  description: "Writes the briefing.",
  prompt_version: "seo-report-crew-v1",
  default_hash: "aaaaaaaaaaaaaaaa",
  tools: [],
  models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
  replay_flows: ["report_flow"],
  agents: [{ key: "analyst", role: "SEO report writer", goal: "Explain.", backstory: "You write.", tools: [], max_tokens: null }],
  tasks: [{ key: "write", agent: "analyst", label: "Write the briefing", instructions: "Write the {kind} SEO briefing.", expected_output: "The briefing text only.", variables: ["kind"], contract: "Then the facts block.", output_editable: true }],
};
const FLOWS = [
  { name: "report_flow", inputs_schema: { type: "object", properties: { period: { enum: ["weekly", "monthly"], type: "string", default: "weekly" } }, additionalProperties: false }, approval_only: false, schedulable: true, mcp: true, crews: ["report"] },
  { name: "gsc_sync_flow", inputs_schema: { type: "object", properties: { slot: { anyOf: [{ type: "string", maxLength: 40 }, { type: "null" }], default: null } } }, approval_only: false, schedulable: true, mcp: true, crews: [] },
];

let db: Db;
let agentCalls: { method: string; path: string; body: Record<string, unknown> | undefined }[];
let agentUp: boolean;
let agentReply: (path: string, body: Record<string, unknown> | undefined) => { status: number; json: unknown } | undefined;

function defaultReply(path: string, body: Record<string, unknown> | undefined): { status: number; json: unknown } {
  if (path === "/healthz") return { status: 200, json: { status: "ok", version: "test" } };
  if (path === "/flows") return { status: 200, json: { items: FLOWS } };
  if (path === "/crews") return { status: 200, json: { items: [REPORT_CREW] } };
  if (/^\/flows\/[a-z_0-9]+\/validate$/.test(path)) {
    const inputs = (body?.inputs ?? {}) as Record<string, unknown>;
    if ("bogus" in inputs) return { status: 422, json: { error: "invalid inputs: bogus is not allowed" } };
    return { status: 200, json: { inputs } };
  }
  if (path.endsWith("/validate") && path.startsWith("/crews/")) {
    const cfg = (body?.config ?? {}) as { agents?: Record<string, Record<string, unknown>> };
    if (cfg.agents?.ghost) return { status: 422, json: { error: "the crew configuration is not valid", issues: ["agents.ghost: the report crew has no such agent"] } };
    return { status: 200, json: { config: body?.config ?? {}, default_hash: REPORT_CREW.default_hash, prompt_version: REPORT_CREW.prompt_version } };
  }
  if (path.endsWith("/kickoff")) return { status: 202, json: { run_id: RUN_ID, status: "queued", existing: false } };
  return { status: 404, json: { error: "not found" } };
}

async function seedRun(flow: string, status = "succeeded", inputs: Record<string, unknown> = {}, outputs: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, inputs, outputs, started_at, finished_at, triggered_by, correlation_id)
    values (${id}::uuid, ${flow}, ${randomUUID()}, ${status}, ${JSON.stringify(inputs)}::jsonb, ${JSON.stringify(outputs)}::jsonb, now() - interval '1 hour', ${status === "running" ? null : sql`now()`}, 'manual', ${id})`);
  return id;
}

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  currentUser = ADMIN;
  agentCalls = [];
  agentUp = true;
  agentReply = () => undefined;
  Object.assign(process.env, { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "a".repeat(40), SEO_AGENT_URL: "http://seo-agent.test:8080", SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN });
  clearAgentCache();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    agentCalls.push({ method: init?.method ?? "GET", path, body });
    if (!agentUp) throw new TypeError("fetch failed");
    const r = agentReply(path, body) ?? defaultReply(path, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  setDbForTests(undefined);
  currentUser = null;
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe("migration 0037", () => {
  it("seeds the fifteen built-in schedules the CronJobs ran, in UTC, enabled", async () => {
    const list = await schedules.listSchedules();
    expect(list).toHaveLength(15);
    expect(list.every((s) => s.builtin && s.enabled && s.timezone === "Etc/UTC" && s.defaults?.cron === s.cron)).toBe(true);
    const by = new Map(list.map((s) => [s.name, s]));
    expect(by.get("gsc-sync")).toMatchObject({ flow: "gsc_sync_flow", cron: "10 6 * * *" });
    expect(by.get("report-monthly")).toMatchObject({ flow: "report_flow", cron: "0 8 2 * *", inputs: { period: "monthly" } });
    expect(by.get("news-dispatch")).toMatchObject({ flow: "news_dispatch_flow", cron: "*/15 * * * *" });
    expect(list.every((s) => s.nextAt !== null)).toBe(true);
  });

  it("keeps at most one active version per crew", async () => {
    await db.execute(sql`insert into seo_crew_configs (crew, version, active) values ('report', 1, true)`);
    await expect(db.execute(sql`insert into seo_crew_configs (crew, version, active) values ('report', 2, true)`)).rejects.toThrow();
    await expect(db.execute(sql`insert into seo_crew_configs (crew, version, active) values ('report', 1, false)`)).rejects.toThrow();
  });
});

describe("cron helpers", () => {
  it("finds the next fire time quickly, in the schedule's time zone", () => {
    const from = new Date("2026-11-19T10:00:00Z");
    expect(nextFire("0 8 2 * *", "Etc/UTC", from)?.toISOString()).toBe("2026-12-02T08:00:00.000Z");
    expect(nextFire("*/15 * * * *", "Etc/UTC", from)?.toISOString()).toBe("2026-11-19T10:15:00.000Z");
    expect(nextFire("0 7 * * 1", "Asia/Kolkata", from)?.toISOString()).toBe("2026-11-23T01:30:00.000Z");
    expect(nextFire("0 0 29 2 *", "Etc/UTC", from)).toBeNull(); // 29 February 2028 is more than 400 days away
    // A DST change in the night does not skip the next day's first minutes (Europe/Berlin, clocks go forward 2027-03-28).
    expect(nextFire("30 0 * * 0", "Europe/Berlin", new Date("2027-03-27T12:00:00Z"))?.toISOString()).toBe("2027-03-27T23:30:00.000Z");
  });

  it("describes common crons in words and times to come", () => {
    expect(schedules.describeCron("0 7 * * 1")).toBe("Mondays at 07:00");
    expect(schedules.describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(schedules.describeCron("0 8 2 * *")).toBe("monthly on the 2nd at 08:00");
    expect(schedules.describeCron("10 6 * * *")).toBe("daily at 06:10");
    expect(schedules.describeCron("5 1-3 * * *")).toBe("5 1-3 * * *");
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(relative("2026-11-19T13:00:00Z", now)).toBe("in 3 h");
    expect(relative("2026-11-19T10:12:00Z", now)).toBe("in 12 min");
    expect(relative("2026-11-19T09:00:00Z", now)).toBe("1 h ago");
  });
});

describe("schedules API", () => {
  it("creates a schedule after the agent checks its inputs, and refuses bad ones", async () => {
    const ok = await scheduleRoute.POST(req("/api/admin/crewai/schedules", "POST", { name: "report-quarterly", flow: "report_flow", cron: "0 9 1 1,4,7,10 *", timezone: "Asia/Kolkata", inputs: { period: "monthly" } }));
    expect(ok.status).toBe(201);
    const s = ((await ok.json()) as { schedule: Schedule }).schedule;
    expect(s).toMatchObject({ name: "report-quarterly", flow: "report_flow", builtin: false, enabled: true });
    expect(agentCalls.find((c) => c.path === "/flows/report_flow/validate")?.body).toEqual({ inputs: { period: "monthly" } });
    const dup = await scheduleRoute.POST(req("/api/admin/crewai/schedules", "POST", { name: "report-quarterly", flow: "report_flow", cron: "0 9 * * *" }));
    expect(dup.status).toBe(409);
    const badCron = await scheduleRoute.POST(req("/api/admin/crewai/schedules", "POST", { name: "x", flow: "report_flow", cron: "61 * * * *" }));
    expect(badCron.status).toBe(400);
    expect(((await badCron.json()) as { issues: string[] }).issues.join(" ")).toMatch(/cron/);
    const publish = await scheduleRoute.POST(req("/api/admin/crewai/schedules", "POST", { name: "y", flow: "publish_flow", cron: "0 9 * * *" }));
    expect(publish.status).toBe(400);
    const bogus = await scheduleRoute.POST(req("/api/admin/crewai/schedules", "POST", { name: "z", flow: "report_flow", cron: "0 9 * * *", inputs: { bogus: 1 } }));
    expect(bogus.status).toBe(422);
    // The agent is down: the schedule is still saved (the dispatcher checks the inputs at every start).
    agentUp = false;
    expect((await scheduleRoute.POST(req("/api/admin/crewai/schedules", "POST", { name: "offline", flow: "gsc_sync_flow", cron: "0 9 * * *" }))).status).toBe(201);
    currentUser = AUTHOR;
    expect((await scheduleRoute.POST(req("/api/admin/crewai/schedules", "POST", { name: "w", flow: "report_flow", cron: "0 9 * * *" }))).status).toBe(403);
  });

  it("re-arms a schedule only when its time or switch changes, resets built-ins and deletes only an admin's own", async () => {
    const gsc = (await schedules.scheduleByName("gsc-sync"))!;
    await db.execute(sql`update seo_flow_schedules set armed_at = now() - interval '1 day' where id = ${gsc.id}::uuid`);
    const armed = async () => (await schedules.getSchedule(gsc.id))!.armedAt;
    const before = await armed();
    expect((await scheduleIdRoute.PATCH(req(`/api/admin/crewai/schedules/${gsc.id}`, "PATCH", { description: "Search Console, daily." }), p({ id: gsc.id }))).status).toBe(200);
    expect(await armed()).toBe(before);
    expect((await scheduleIdRoute.PATCH(req(`/api/admin/crewai/schedules/${gsc.id}`, "PATCH", { cron: "15 6 * * *" }), p({ id: gsc.id }))).status).toBe(200);
    expect(Date.parse(await armed())).toBeGreaterThan(Date.parse(before));
    expect((await scheduleIdRoute.PATCH(req(`/api/admin/crewai/schedules/${gsc.id}`, "PATCH", { cron: "nope" }), p({ id: gsc.id }))).status).toBe(400);
    const reset = await scheduleIdRoute.POST(req(`/api/admin/crewai/schedules/${gsc.id}`, "POST", { action: "reset" }), p({ id: gsc.id }));
    expect(((await reset.json()) as { schedule: Schedule }).schedule.cron).toBe("10 6 * * *");
    expect((await scheduleIdRoute.DELETE(req(`/api/admin/crewai/schedules/${gsc.id}`, "DELETE"), p({ id: gsc.id }))).status).toBe(409);
    const mine = await schedules.createSchedule({ name: "mine", flow: "reindex_flow", description: "", cron: "0 1 * * *", timezone: "Etc/UTC", inputs: {}, enabled: true }, "admin");
    expect((await scheduleIdRoute.DELETE(req(`/api/admin/crewai/schedules/${mine.id}`, "DELETE"), p({ id: mine.id }))).status).toBe(200);
    expect(await schedules.getSchedule(mine.id)).toBeNull();
    const audit = rowsOf<{ action: string }>(await db.execute(sql`select action from audit_log where action like 'seo.crewai.schedule.%' order by created_at`)).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(["seo.crewai.schedule.update", "seo.crewai.schedule.reset", "seo.crewai.schedule.delete"]));
  });

  it("Run now starts the schedule's flow with its inputs as a manual run", async () => {
    const monthly = (await schedules.scheduleByName("report-monthly"))!;
    const r = await scheduleIdRoute.POST(req(`/api/admin/crewai/schedules/${monthly.id}`, "POST", { action: "run" }), p({ id: monthly.id }));
    expect(r.status).toBe(202);
    expect(agentCalls.find((c) => c.path === "/flows/report_flow/kickoff")?.body).toEqual({ inputs: { period: "monthly" }, triggered_by: "manual", actor: expect.stringContaining("admin") });
  });
});

describe("Run with parameters", () => {
  it("starts a flow with the given inputs and refuses flows started elsewhere", async () => {
    const r = await flowRoute.POST(req("/api/admin/crewai/flows/report_flow", "POST", { inputs: { period: "monthly" } }), p({ name: "report_flow" }));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ runId: RUN_ID, status: "queued", existing: false });
    expect(agentCalls.at(-1)).toMatchObject({ path: "/flows/report_flow/kickoff", body: { inputs: { period: "monthly" }, triggered_by: "manual" } });
    for (const name of ["publish_flow", "new_article_flow", "news_draft_flow", "crew_test_flow", "news_dispatch_flow"]) {
      expect((await flowRoute.POST(req(`/api/admin/crewai/flows/${name}`, "POST", { inputs: {} }), p({ name }))).status, name).toBe(409);
    }
    expect((await flowRoute.POST(req("/api/admin/crewai/flows/nope_flow", "POST", { inputs: {} }), p({ name: "nope_flow" }))).status).toBe(404);
    agentReply = (path) => (path.endsWith("/kickoff") ? { status: 422, json: { error: "invalid inputs for report_flow: period" } } : undefined);
    const bad = await flowRoute.POST(req("/api/admin/crewai/flows/report_flow", "POST", { inputs: { period: "daily" } }), p({ name: "report_flow" }));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toMatch(/invalid inputs/);
  });
});

describe("crew versions", () => {
  it("saves checked versions, activates and rolls back, and serves the active one to the agent", async () => {
    const cfg = { tasks: { write: { instructions: "Write the {kind} briefing in three sentences." } } };
    const saved = await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "save", config: cfg, note: "shorter", activate: true }), p({ crew: "report" }));
    expect(saved.status).toBe(201);
    expect(((await saved.json()) as { version: CrewVersion }).version).toMatchObject({ crew: "report", version: 1, active: true, note: "shorter", baseHash: REPORT_CREW.default_hash, promptVersion: "seo-report-crew-v1" });
    const v2 = await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "save", config: { agents: { analyst: { backstory: "Terse." } } } }), p({ crew: "report" }));
    expect(((await v2.json()) as { version: CrewVersion }).version).toMatchObject({ version: 2, active: false });
    const cb = async () => (await handleCallback("GET", "/internal/seo-agent/crew-configs", `Bearer ${CB_TOKEN}`, undefined, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN })).body;
    expect(await cb()).toEqual({ crews: [{ crew: "report", version: 1, config: cfg }] });
    expect((await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "activate", version: 2 }), p({ crew: "report" }))).status).toBe(200);
    expect(((await cb()) as { crews: { version: number }[] }).crews[0]!.version).toBe(2);
    expect((await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "activate", version: 9 }), p({ crew: "report" }))).status).toBe(404);
    expect((await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "defaults" }), p({ crew: "report" }))).status).toBe(200);
    expect(await cb()).toEqual({ crews: [] });
    const bad = await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "save", config: { agents: { ghost: { role: "x" } } } }), p({ crew: "report" }));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { issues: string[] }).issues[0]).toMatch(/agents.ghost/);
    expect((await crews.listVersions("report")).map((v) => v.version)).toEqual([2, 1]);
  });

  it("Test run replays a finished run with the unsaved configuration through crew_test_flow", async () => {
    const src = await seedRun("report_flow");
    const cfg = { tasks: { write: { instructions: "Edited {kind}." } } };
    const r = await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "test", config: cfg, sourceRunId: src }), p({ crew: "report" }));
    expect(r.status).toBe(202);
    expect(agentCalls.at(-1)).toMatchObject({ path: "/flows/crew_test_flow/kickoff", body: { inputs: { crew: "report", source_run_id: src, config: cfg }, triggered_by: "manual" } });
    const live = await seedRun("report_flow", "running");
    expect((await crewRoute.POST(req("/api/admin/crewai/crews/report", "POST", { action: "test", config: cfg, sourceRunId: live }), p({ crew: "report" }))).status).toBe(409);
    expect(await crews.listVersions("report")).toEqual([]); // nothing saved
  });
});

describe("import and export", () => {
  it("exports schedules, active crew versions and changed skills, and imports a plan that only adds and changes", async () => {
    await crews.saveVersion({ crew: "report", config: { agents: { analyst: { backstory: "Terse." } } }, note: "v1", source: "editor", baseHash: REPORT_CREW.default_hash, promptVersion: "seo-report-crew-v1", activate: true, actor: "admin" });
    const res = await configRoute.GET(req("/api/admin/crewai/config?parts=schedules,crews,skills"));
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="crewai-config-.*\.json"/);
    const bundle = (await res.json()) as Bundle;
    expect(bundle).toMatchObject({ kind: "moks-crewai-config", format: 1 });
    expect(bundle.schedules).toHaveLength(15);
    expect(bundle.crews).toEqual([expect.objectContaining({ crew: "report", version: 1, config: { agents: { analyst: { backstory: "Terse." } } } })]);
    expect(JSON.stringify(bundle)).not.toMatch(/"id"|last_|armedAt/);

    // The same file on this site: nothing to do.
    const same = await configRoute.POST(req("/api/admin/crewai/config", "POST", { bundle }));
    const plan0 = ((await same.json()) as { plan: ImportPlan }).plan;
    expect([...plan0.schedules, ...plan0.crews, ...plan0.skills].every((i) => i.action === "unchanged")).toBe(true);

    // Another site's file: a changed time, a paused schedule, a new one, a conflicting flow and a new crew version.
    const edited: Bundle = {
      ...bundle,
      schedules: [
        ...bundle.schedules.map((s) => (s.name === "gsc-sync" ? { ...s, cron: "30 5 * * *" } : s.name === "promotion" ? { ...s, enabled: false } : s.name === "reindex" ? { ...s, flow: "seo_ml_flow" } : s)),
        { name: "report-quarterly", flow: "report_flow", description: "", cron: "0 9 1 1,4,7,10 *", timezone: "Etc/UTC", inputs: { period: "monthly" }, enabled: true },
      ],
      crews: [{ crew: "report", version: 4, note: "from staging", config: { agents: { analyst: { backstory: "Very terse." } } }, baseHash: REPORT_CREW.default_hash }],
    };
    const planned = await configRoute.POST(req("/api/admin/crewai/config", "POST", { bundle: edited }));
    const plan = ((await planned.json()) as { plan: ImportPlan }).plan;
    const by = new Map(plan.schedules.map((i) => [i.key, i]));
    expect(by.get("gsc-sync")).toMatchObject({ action: "update", changes: ["time: 10 6 * * * → 30 5 * * *"] });
    expect(by.get("promotion")).toMatchObject({ action: "update", changes: ["paused"] });
    expect(by.get("report-quarterly")?.action).toBe("create");
    expect(by.get("reindex")).toMatchObject({ action: "error" });
    expect(plan.crews[0]).toMatchObject({ key: "report", action: "create" });
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("10 6 * * *"); // a plan changes nothing

    const applied = await configRoute.POST(req("/api/admin/crewai/config", "POST", { bundle: edited, apply: true, activate: true }));
    const result = (await applied.json()) as ImportResult;
    expect(result.applied).toEqual({ schedules: 3, crews: 1, skills: 0 });
    expect(result.failed).toEqual([]);
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("30 5 * * *");
    expect((await schedules.scheduleByName("promotion"))!.enabled).toBe(false);
    expect((await schedules.scheduleByName("reindex"))!.flow).toBe("reindex_flow");
    const versions = await crews.listVersions("report");
    expect(versions[0]).toMatchObject({ version: 2, source: "import", active: true, note: "Imported (v4 in the file): from staging" });

    // A crew import needs the agent; schedules still go through without it.
    agentUp = false;
    const offline = await io.planImport(io.bundleSchema.parse({ ...edited, schedules: [{ name: "late", flow: "gsc_sync_flow", cron: "0 4 * * *" }] }), { crew: () => Promise.reject(Object.assign(new Error("down"), { status: 503 })), inputs: () => Promise.reject(Object.assign(new Error("down"), { status: 503 })) });
    expect(offline.schedules[0]!.action).toBe("create");
    expect(offline.crews[0]).toMatchObject({ action: "error", error: expect.stringMatching(/must answer/) });
    expect(offline.warnings.join(" ")).toMatch(/did not answer/);

    expect((await configRoute.POST(req("/api/admin/crewai/config", "POST", { bundle: { kind: "something-else", format: 1 } }))).status).toBe(400);
    expect(io.stable({ b: [1, { d: 2, c: 1 }], a: null })).toBe('{"a":null,"b":[1,{"c":1,"d":2}]}');
  });
});

describe("pages", () => {
  it("render the flows, a flow, schedules, crews, a crew, import / export and a test run", async () => {
    const flows = renderToStaticMarkup(await FlowsPage());
    expect(flows).toContain("Run with parameters");
    expect(flows).toContain("Report");
    const flow = renderToStaticMarkup(await FlowPage({ params: Promise.resolve({ name: "report_flow" }) }));
    expect(flow).toContain("report-weekly");
    expect(flow).toContain("weekly | monthly");
    const sched = renderToStaticMarkup(await SchedulesPage({ searchParams: Promise.resolve({}) }));
    expect(sched).toContain("gsc-sync");
    expect(sched).toContain("Mondays at 07:00");
    expect(sched).toContain("New schedule");
    const crewList = renderToStaticMarkup(await CrewsPage());
    expect(crewList).toContain("Report crew");
    const src = await seedRun("report_flow");
    const crew = renderToStaticMarkup(await CrewPage({ params: Promise.resolve({ crew: "report" }), searchParams: Promise.resolve({ source: src }) }));
    expect(crew).toContain("Write the {kind} SEO briefing.");
    expect(crew).toContain("Test run");
    expect(crew).toContain("Code defaults");
    expect(renderToStaticMarkup(await ConfigPage())).toContain("Download configuration");
    const test = await seedRun("crew_test_flow", "succeeded", { crew: "report", source_run_id: src, config: { tasks: { write: { instructions: "X {kind}" } } } }, { outcome: "done", result: { status: "completed", narrative: "Clicks rose 14.1% to 665.", check: { ok: true } } });
    const run = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ id: test }) }));
    expect(run).toContain("Test run of the report crew");
    expect(run).toContain("Clicks rose 14.1% to 665.");
    expect(run).toContain("Save as new version");
    const replay = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ id: src }) }));
    expect(replay).toContain(`/admin/crewai/crews/report?source=${src}`);
    // The agent is off: the pages still render from the database.
    agentUp = false;
    clearAgentCache();
    expect(renderToStaticMarkup(await FlowsPage())).toContain("did not answer");
    expect(renderToStaticMarkup(await CrewPage({ params: Promise.resolve({ crew: "report" }), searchParams: Promise.resolve({}) }))).toContain("did not answer");
  });
});
