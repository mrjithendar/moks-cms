import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => "/admin/crewai/runs", useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const runs = await import("@/lib/crewai/runs");
const { rerunBlocked, flowInfo } = await import("@/lib/crewai/flows");
const { formatDuration } = await import("@/lib/crewai/format");
const { handleCallback } = await import("@/lib/seo-agent/internal-server");
const { clearAgentCache } = await import("@/lib/seo-agent/endpoint");
const { saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");
const runRoute = await import("@/app/api/admin/crewai/runs/[id]/route");
const logsRoute = await import("@/app/api/admin/crewai/runs/[id]/logs/route");
const callRoute = await import("@/app/api/admin/crewai/calls/[id]/route");
const { default: OverviewPage } = await import("@/app/admin/crewai/page");
const { default: RunsPage } = await import("@/app/admin/crewai/runs/page");
const { default: RunPage } = await import("@/app/admin/crewai/runs/[id]/page");
const { renderToStaticMarkup } = await import("react-dom/server");

const ADMIN: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
const AUTHOR: SessionUser = { ...ADMIN, id: "author", email: "author@example.com", role: "author" };
const DEMO_WRITE: SessionUser = { ...ADMIN, id: "demo", email: "demo@example.com", role: "demo", demo: true };
const CB_TOKEN = "c".repeat(40);
const env = { ...process.env };

const req = (url: string, method = "GET", body?: unknown) =>
  new Request(`https://jithendar.com${url}`, { method, headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let db: Db;
let agentCalls: { method: string; path: string; body: unknown }[];
let agentReply: (path: string, body: unknown) => { status: number; json: unknown };

type RunSeed = { flow?: string; target?: string; status?: string; trigger?: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown>; error?: string | null; started?: string; finished?: string | null; correlation?: string; cost?: number; tokens?: number; actor?: string };
async function seedRun(s: RunSeed = {}): Promise<string> {
  const id = randomUUID();
  const started = s.started ?? new Date().toISOString();
  const status = s.status ?? "succeeded";
  const finished = s.finished === undefined ? (["queued", "running"].includes(status) ? null : new Date(new Date(started).getTime() + 65_000).toISOString()) : s.finished;
  await db.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, inputs, outputs, error, started_at, finished_at, triggered_by, correlation_id, cost_usd, tokens, actor)
    values (${id}::uuid, ${s.flow ?? "gsc_sync_flow"}, ${s.target ?? "site"}, ${status}, ${JSON.stringify(s.inputs ?? {})}::jsonb, ${JSON.stringify(s.outputs ?? {})}::jsonb, ${s.error ?? null},
      ${started}::timestamptz, ${finished}::timestamptz, ${s.trigger ?? "cron"}, ${s.correlation ?? id}, ${s.cost ?? 0}, ${s.tokens ?? 0}, ${s.actor ?? null})`);
  return id;
}
const numberOf = async (id: string) => Number(rowsOf<{ n: number }>(await db.execute(sql`select run_number as n from seo_flow_runs where run_id = ${id}::uuid`))[0]?.n);

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  currentUser = ADMIN;
  agentCalls = [];
  agentReply = () => ({ status: 202, json: { run_id: "11111111-2222-4333-8444-555555555555", status: "queued", existing: false } });
  Object.assign(process.env, { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "a".repeat(40), SEO_AGENT_URL: "http://seo-agent.test:8080", SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN });
  clearAgentCache();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    agentCalls.push({ method: init?.method ?? "GET", path, body });
    const r = agentReply(path, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  setDbForTests(undefined);
  currentUser = null;
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe("run numbers (migration 0036)", () => {
  it("numbers runs per flow on insert, and a refused second active run takes no number", async () => {
    const a = await seedRun({ flow: "report_flow", target: "weekly" });
    const b = await seedRun({ flow: "report_flow", target: "weekly" });
    const other = await seedRun({ flow: "gsc_sync_flow" });
    expect([await numberOf(a), await numberOf(b), await numberOf(other)]).toEqual([1, 2, 1]);
    // The agent's insert (moks-seo-agent/app/runs.py): a second active run for the same flow + target conflicts.
    const live = await seedRun({ flow: "report_flow", target: "monthly", status: "running" });
    const dup = randomUUID();
    const inserted = rowsOf(await db.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, triggered_by) values (${dup}::uuid, 'report_flow', 'monthly', 'queued', 'cron') on conflict do nothing returning run_id`));
    expect(inserted).toEqual([]);
    const next = await seedRun({ flow: "report_flow", target: "weekly" });
    expect([await numberOf(live), await numberOf(next)]).toEqual([3, 4]);
  });
});

describe("runs list", () => {
  it("filters by flow, status, trigger and text, newest first, with a cursor", async () => {
    const t0 = Date.now() - 3_600_000;
    const at = (m: number) => new Date(t0 + m * 60_000).toISOString();
    const old = await seedRun({ flow: "gsc_sync_flow", started: at(0) });
    const failed = await seedRun({ flow: "new_article_flow", target: "d-1", status: "failed", error: "Truncated: output cut off", started: at(5), trigger: "manual", actor: "admin@example.com" });
    const running = await seedRun({ flow: "report_flow", target: "weekly", status: "running", started: at(10) });
    expect((await runs.listRuns()).map((r) => r.runId)).toEqual([running, failed, old]);
    expect((await runs.listRuns({ flow: "gsc_sync_flow" })).map((r) => r.runId)).toEqual([old]);
    expect((await runs.listRuns({ status: "failed" })).map((r) => r.runId)).toEqual([failed]);
    expect((await runs.listRuns({ status: "active" })).map((r) => r.runId)).toEqual([running]);
    expect((await runs.listRuns({ trigger: "manual" })).map((r) => r.runId)).toEqual([failed]);
    expect((await runs.listRuns({ q: "truncated" })).map((r) => r.runId)).toEqual([failed]);
    expect((await runs.listRuns({ q: "#1", flow: "report_flow" })).map((r) => r.runId)).toEqual([running]);
    expect((await runs.listRuns({ q: failed })).map((r) => r.runId)).toEqual([failed]);
    expect((await runs.listRuns({ q: "100%_'; drop" })).length).toBe(0);
    const page = await runs.listRuns({ limit: 2 });
    expect((await runs.listRuns({ before: page[1]!.startedAt })).map((r) => r.runId)).toEqual([old]);
  });
});

async function seedHistory(runId: string) {
  await db.execute(sql`insert into seo_flow_run_steps (run_id, seq, step, status, finished_at, detail) values
    (${runId}::uuid, 1, 'load_brief', 'succeeded', now(), '{"seconds": 2.1}'), (${runId}::uuid, 2, 'draft', 'failed', now(), '{"seconds": 238}')`);
  await db.execute(sql`update seo_flow_run_steps set error = 'CrewAborted: invalid model answer from reviewer' where run_id = ${runId}::uuid and step = 'draft'`);
  const [call] = rowsOf<{ id: number }>(await db.execute(sql`insert into seo_flow_run_calls (run_id, step, agent, purpose, model, input_tokens, output_tokens, cost_usd, latency_ms, system, prompt, response)
    values (${runId}::uuid, 'draft', 'writer', 'crew:editorial', 'claude-sonnet-5-5', 8200, 3100, 0.07, 9400, 'You write tutorials.', 'Write the article.', 'The article body.') returning id`));
  await db.execute(sql`insert into seo_flow_run_logs (run_id, step, level, logger, event, message, context) values
    (${runId}::uuid, null, 'info', 'seo_agent.runs', 'flow_started', 'flow run started', '{}'),
    (${runId}::uuid, 'load_brief', 'debug', 'httpx', null, 'HTTP Request: GET http://web/internal/seo-agent/calendar/x/brief', '{}'),
    (${runId}::uuid, 'draft', 'info', 'seo_agent.crews', 'crew_task_started', 'crew task started: editorial.writer', '{"agent": "writer"}'),
    (${runId}::uuid, 'draft', 'info', 'seo_agent.llm', 'llm_call', 'model call writer: claude-sonnet-5-5', ${JSON.stringify({ agent: "writer", call_id: Number(call!.id), input_tokens: 8200, output_tokens: 3100, cost_usd: 0.07, seconds: 9.4 })}::jsonb),
    (${runId}::uuid, 'draft', 'error', 'seo_agent.flows', 'flow_failed', 'flow run failed', '{"exc": "Traceback: CrewAborted"}'),
    (${runId}::uuid, null, 'info', 'seo_agent.runs', 'flow_finished', 'flow run finished', '{"status": "failed"}')`);
  await db.execute(sql`insert into seo_llm_usage (provider, model, purpose, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms, outcome, run_id, agent) values
    ('anthropic', 'claude-sonnet-5-5', 'crew:editorial', 'v6', 8200, 3100, 0.07, 9400, 'ok', ${runId}, 'writer'),
    ('anthropic', 'claude-sonnet-5-5', 'crew:editorial', 'v6', 900, 16000, 0.25, 60000, 'truncated', ${runId}, 'reviewer')`);
  return Number(call!.id);
}

describe("a run's detail", () => {
  it("has steps, cost per agent, parent and children, and neighbours", async () => {
    const parent = await seedRun({ flow: "weekly_recommendations_flow" });
    const id = await seedRun({ flow: "new_article_flow", target: "d-1", status: "failed", correlation: parent, inputs: { draft_id: randomUUID(), calendar_id: randomUUID() }, outputs: { outcome: "generation_failed", errors: ["reviewer truncated"] } });
    const later = await seedRun({ flow: "new_article_flow", target: "d-2" });
    await seedHistory(id);
    const d = (await runs.runDetail(id))!;
    expect(d.steps.map((s) => [s.step, s.status, s.seconds])).toEqual([["load_brief", "succeeded", 2.1], ["draft", "failed", 238]]);
    expect(d.usage.map((u) => [u.agent, u.calls, u.failed])).toEqual([["reviewer", 1, 1], ["writer", 1, 0]]);
    expect(d.parent?.runId).toBe(parent);
    expect((await runs.runDetail(parent))!.children.map((c) => c.runId)).toEqual([id]);
    expect([d.previous, d.next?.runId, d.transcripts, d.outcome]).toEqual([null, later, 1, "generation_failed"]);
    expect(await runs.runDetail("not-a-uuid")).toBeNull();
  });
});

describe("log API", () => {
  it("pages lines as JSON with a level filter, and downloads the log as text", async () => {
    const id = await seedRun({ flow: "new_article_flow", status: "failed" });
    await seedHistory(id);
    const page = (await (await logsRoute.GET(req(`/api/admin/crewai/runs/${id}/logs?format=json&level=info`), params(id))).json()) as { logs: { event: string | null; step: string | null }[] };
    expect(page.logs.map((l) => l.event)).toEqual(["flow_started", "crew_task_started", "llm_call", "flow_failed", "flow_finished"]);
    const all = (await (await logsRoute.GET(req(`/api/admin/crewai/runs/${id}/logs?format=json`), params(id))).json()) as { logs: unknown[] };
    expect(all.logs).toHaveLength(6);
    const text = await logsRoute.GET(req(`/api/admin/crewai/runs/${id}/logs?format=text`), params(id));
    expect(text.headers.get("content-disposition")).toMatch(/attachment; filename="new_article_flow-1\.log"/);
    const body = await text.text();
    expect(body).toContain("# New article #1 (new_article_flow)");
    expect(body).toMatch(/ERROR\s+\[draft\] flow run failed\nTraceback: CrewAborted/);
  });

  it("streams a finished run's lines once and ends", async () => {
    const id = await seedRun({ flow: "new_article_flow", status: "failed" });
    await seedHistory(id);
    const res = await logsRoute.GET(req(`/api/admin/crewai/runs/${id}/logs?after=0`), params(id));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const stream = await res.text();
    expect(stream.match(/event: log/g)).toHaveLength(6);
    expect(stream).toContain('event: status\ndata: {"status":"failed"}');
    expect(stream.trimEnd().endsWith("event: end\ndata: {}")).toBe(true);
  });

  it("serves a kept transcript and says when it is not kept", async () => {
    const id = await seedRun({ flow: "new_article_flow" });
    const callId = await seedHistory(id);
    const ok = (await (await callRoute.GET(req(`/api/admin/crewai/calls/${callId}`), params(String(callId)))).json()) as { call: { system: string; prompt: string; response: string; agent: string } };
    expect(ok.call).toMatchObject({ system: "You write tutorials.", prompt: "Write the article.", response: "The article body.", agent: "writer" });
    const missing = await callRoute.GET(req("/api/admin/crewai/calls/999999"), params("999999"));
    expect(missing.status).toBe(404);
  });

  it("is for admins only", async () => {
    const id = await seedRun();
    currentUser = AUTHOR;
    expect((await logsRoute.GET(req(`/api/admin/crewai/runs/${id}/logs?format=json`), params(id))).status).toBe(403);
    expect((await runRoute.GET(req(`/api/admin/crewai/runs/${id}`), params(id))).status).toBe(403);
  });
});

describe("re-run and cancel", () => {
  it("re-runs a flow through the agent with the same or edited inputs, audit-logged", async () => {
    const id = await seedRun({ flow: "report_flow", target: "weekly", inputs: { period: "weekly" } });
    const res = await runRoute.POST(req(`/api/admin/crewai/runs/${id}`, "POST", { action: "rerun" }), params(id));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "11111111-2222-4333-8444-555555555555", status: "queued", existing: false });
    expect(agentCalls).toEqual([{ method: "POST", path: "/flows/report_flow/kickoff", body: { inputs: { period: "weekly" }, triggered_by: "manual", actor: "admin@example.com" } }]);
    await runRoute.POST(req(`/api/admin/crewai/runs/${id}`, "POST", { action: "rerun", inputs: { period: "monthly" } }), params(id));
    expect(agentCalls[1]!.body).toMatchObject({ inputs: { period: "monthly" } });
    const audits = rowsOf<{ action: string }>(await db.execute(sql`select action from audit_log where target = ${id} order by id`)).map((r) => r.action);
    expect(audits).toEqual(["seo.crewai.rerun", "seo.crewai.rerun"]);
  });

  it("passes the agent's input check back, and refuses flows that are not re-run from here", async () => {
    const id = await seedRun({ flow: "report_flow", target: "weekly" });
    agentReply = () => ({ status: 422, json: { error: "invalid inputs for report_flow: period: Input should be 'weekly' or 'monthly'" } });
    const bad = await runRoute.POST(req(`/api/admin/crewai/runs/${id}`, "POST", { action: "rerun", inputs: { period: "daily" } }), params(id));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toContain("Input should be");
    for (const flow of ["publish_flow", "new_article_flow", "optimize_article_flow", "news_draft_flow", "news_dispatch_flow"]) {
      const r = await seedRun({ flow, target: randomUUID() });
      const res = await runRoute.POST(req(`/api/admin/crewai/runs/${r}`, "POST", { action: "rerun" }), params(r));
      expect(res.status, flow).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(rerunBlocked(flow));
    }
    expect(agentCalls.filter((c) => c.path.endsWith("/kickoff"))).toHaveLength(1);
  });

  it("cancels only a run that is still going", async () => {
    const done = await seedRun();
    expect((await runRoute.POST(req(`/api/admin/crewai/runs/${done}`, "POST", { action: "cancel" }), params(done))).status).toBe(409);
    const live = await seedRun({ flow: "report_flow", status: "running" });
    agentReply = () => ({ status: 200, json: { run_id: live, status: "cancelled" } });
    const res = await runRoute.POST(req(`/api/admin/crewai/runs/${live}`, "POST", { action: "cancel" }), params(live));
    expect(res.status).toBe(200);
    expect(agentCalls).toEqual([{ method: "POST", path: `/flows/runs/${live}/cancel`, body: {} }]);
  });

  it("is read-only for a demo account", async () => {
    const id = await seedRun({ flow: "report_flow" });
    currentUser = DEMO_WRITE;
    const res = await runRoute.POST(req(`/api/admin/crewai/runs/${id}`, "POST", { action: "rerun" }), params(id));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("demo_read_only");
    expect(agentCalls).toEqual([]);
  });
});

describe("settings, the agent's callback and retention", () => {
  it("serves the transcripts switch to the agent and follows the saved setting", async () => {
    const get = async () => (await handleCallback("GET", "/internal/seo-agent/run-history/settings", `Bearer ${CB_TOKEN}`, undefined, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN })).body;
    expect(await get()).toEqual({ transcripts: true });
    const runHistory = (await getSeoSettings()).runHistory;
    await saveSeoSettings({ ...settingsInput(), runHistory: { ...runHistory, transcripts: false } }, "admin");
    expect(await get()).toEqual({ transcripts: false });
    await expect(saveSeoSettings({ ...settingsInput(), runHistory: { ...runHistory, transcriptRetentionDays: 365 } }, "admin")).rejects.toThrow();
  });

  it("deletes log lines and transcripts past their retention, keeping runs and steps", async () => {
    const id = await seedRun({ flow: "new_article_flow" });
    await seedHistory(id);
    await db.execute(sql`update seo_flow_run_logs set at = now() - interval '100 days' where event = 'flow_started'`);
    await db.execute(sql`update seo_flow_run_calls set at = now() - interval '20 days'`);
    const r = await runs.purgeRunHistory(db, { transcripts: true, logRetentionDays: 90, transcriptRetentionDays: 14 });
    expect(r).toEqual({ logs: 1, calls: 1 });
    expect((await runs.runLogs(id)).length).toBe(5);
    expect((await runs.runDetail(id))!.steps).toHaveLength(2);
  });
});

describe("pages", () => {
  it("render the overview, the list and a run with its log", async () => {
    const parent = await seedRun({ flow: "weekly_recommendations_flow" });
    const id = await seedRun({ flow: "new_article_flow", status: "failed", error: "CrewAborted: invalid model answer", correlation: parent, cost: 0.32, tokens: 28_200 });
    await seedRun({ flow: "report_flow", target: "weekly", status: "running" });
    await seedHistory(id);
    const overview = renderToStaticMarkup(await OverviewPage());
    expect(overview).toContain("CrewAI console");
    expect(overview).toContain("Running now");
    expect(overview).toContain("New article");
    expect(overview).toContain("CrewAborted: invalid model answer");

    const list = renderToStaticMarkup(await RunsPage({ searchParams: Promise.resolve({ status: "failed" }) }));
    expect(list).toContain(`/admin/crewai/runs/${id}`);
    expect(list).not.toContain("Report <span");

    const page = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ id }) }));
    expect(page).toContain("New article <span");
    expect(page).toContain("CrewAborted: invalid model answer");
    expect(page).toContain("load_brief");
    expect(page).toContain("Started by");
    expect(page).toContain("Cost by agent and model");
    expect(page).toContain("reviewer");
    expect(page).toContain(rerunBlocked("new_article_flow")!);
    expect(page).toContain("Transcript");
  });
});

describe("flow catalogue and formatting", () => {
  it("names known flows, keeps unknown ones visible, and formats durations", () => {
    expect(flowInfo("new_article_flow")).toMatchObject({ label: "New article", group: "Content", rerun: "review" });
    expect(flowInfo("future_magic_flow")).toMatchObject({ label: "future magic", group: "Other", rerun: "no" });
    expect(rerunBlocked("report_flow")).toBeNull();
    expect([formatDuration(860), formatDuration(12_300), formatDuration(252_000), formatDuration(3_780_000), formatDuration(null)]).toEqual(["0.9s", "12s", "4m 12s", "1h 3m", "—"]);
  });
});
