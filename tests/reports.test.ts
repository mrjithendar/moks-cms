import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { fakeR2 } from "./fake-r2";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
const r2 = { ...fakeR2(), ready: true };
vi.mock("@/lib/storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage")>()),
  ...r2,
  storageReady: async () => r2.ready,
  getObjectBytes: async (key: string, max: number) => {
    const o = r2.objects.get(key);
    return o && o.body.length <= max ? o.body : null;
  },
}));
const agent = vi.hoisted(() => ({ mode: "crewai" as "crewai" | "legacy", kickoffs: [] as { flow: string; inputs: Record<string, unknown> }[], fail: null as null | { status: number; message: string }, cancelled: [] as string[] }));
vi.mock("@/lib/seo-agent/endpoint", async (orig) => ({ ...(await orig<typeof import("@/lib/seo-agent/endpoint")>()), orchestrator: async () => agent.mode, agentStatus: async () => ({ enabled: agent.mode === "crewai", version: null, reason: "test" }) }));
vi.mock("@/lib/seo-agent/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/seo-agent/client")>()),
  kickoff: async (flow: string, inputs: Record<string, unknown>) => {
    if (agent.fail) throw Object.assign(new Error(agent.fail.message), { status: agent.fail.status });
    agent.kickoffs.push({ flow, inputs });
    return { run_id: "99999999-9999-4999-8999-999999999999", status: "queued", existing: false };
  },
  cancelRun: async (id: string) => {
    agent.cancelled.push(id);
    return { status: "cancelled" };
  },
  crewCatalogue: async () => ({ items: [{ crew: "editorial", label: "Editorial crew", prompt_version: "seo-crew-v12" }, { crew: "optimization", label: "Optimization crew", prompt_version: "seo-optimize-crew-v3" }] }),
}));
const mail = vi.hoisted(() => ({ configured: true, sent: [] as { to: string; subject: string; html?: string; attachments?: { filename: string }[] }[], failWith: null as string | null }));
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  mailConfigured: async () => mail.configured,
  activeMailProvider: async () => (mail.configured ? "smtp" : null),
  sendRichMail: async (m: { to: string; subject: string; html?: string; attachments?: { filename: string }[] }) => {
    if (mail.failWith) throw new Error(mail.failWith);
    mail.sent.push(m);
    return { provider: "smtp" };
  },
}));

const { resolveRange, RangeError, istToday } = await import("@/lib/reports/ranges");
const { fmt } = await import("@/lib/reports/format");
const { buildReport, redactText, factsOf } = await import("@/lib/reports/build");
const svc = await import("@/lib/reports/service");
const email = await import("@/lib/reports/email");
const { renderCsv, renderHtmlDocument, esc } = await import("@/lib/reports/render");
const callbacks = await import("@/lib/reports/callbacks");
const { runDueJobs } = await import("@/lib/jobs");

const NOW = new Date("2026-11-24T10:00:00Z"); // 15:30 IST
let db: Db;
const admin = { id: "admin", label: "admin@example.com" };

beforeEach(async () => {
  db = await freshDb();
  agent.mode = "crewai";
  agent.kickoffs = [];
  agent.fail = null;
  agent.cancelled = [];
  mail.configured = true;
  mail.sent = [];
  mail.failWith = null;
  r2.ready = true;
  r2.objects.clear();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
});
afterEach(() => setDbForTests(undefined));

async function run(flow: string, status: string, startedAt: string, cost = 0, error: string | null = null, ms = 60_000) {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, error, triggered_by, started_at, finished_at, cost_usd) values (${id}, ${flow}, ${`t-${id}`}, ${status}, ${error}, 'cron', ${startedAt}, ${new Date(Date.parse(startedAt) + ms).toISOString()}, ${cost})`);
  return id;
}
async function usage(at: string, model: string, cost: number, runId: string | null, extra: Partial<{ agent: string; prompt: string; purpose: string; out: number; error: string | null }> = {}) {
  await db.execute(sql`insert into seo_llm_usage (at, provider, model, purpose, prompt_version, mode, input_tokens, output_tokens, cost_usd, latency_ms, outcome, error_code, run_id, agent)
    values (${at}, 'anthropic', ${model}, ${extra.purpose ?? "crew"}, ${extra.prompt ?? "seo-crew-v12"}, 'sync', 1000, ${extra.out ?? 500}, ${cost}, 2000, ${extra.error ? "truncated" : "ok"}, ${extra.error ?? null}, ${runId}, ${extra.agent ?? "writer"})`);
}

describe("date ranges", () => {
  it("resolves presets in India Standard Time and compares with the equal period before", () => {
    const late = new Date("2026-11-30T19:00:00Z"); // 2026-12-01 00:30 IST
    expect(istToday(late)).toBe("2026-12-01");
    expect(resolveRange({ preset: "today" }, late)).toMatchObject({ start: "2026-12-01", end: "2026-12-01", previousStart: "2026-11-30", previousEnd: "2026-11-30", days: 1 });
    expect(resolveRange({ preset: "last_7_days" }, NOW)).toMatchObject({ start: "2026-11-18", end: "2026-11-24", previousStart: "2026-11-11", previousEnd: "2026-11-17", days: 7 });
    expect(resolveRange({ preset: "this_month" }, NOW)).toMatchObject({ start: "2026-11-01", end: "2026-11-24", days: 24 });
    expect(resolveRange({ preset: "previous_month" }, NOW)).toMatchObject({ start: "2026-10-01", end: "2026-10-31", previousStart: "2026-08-31", previousEnd: "2026-09-30", days: 31 });
    expect(resolveRange({ preset: "custom", start: "2026-11-01", end: "2026-11-10" }, NOW)).toMatchObject({ days: 10, previousStart: "2026-10-22", previousEnd: "2026-10-31", label: "2026-11-01 – 2026-11-10" });
  });

  it("refuses ranges that make no sense", () => {
    expect(() => resolveRange({ preset: "custom" }, NOW)).toThrow(RangeError);
    expect(() => resolveRange({ preset: "custom", start: "2026-11-10", end: "2026-11-01" }, NOW)).toThrow(/after the end/);
    expect(() => resolveRange({ preset: "custom", start: "2026-11-20", end: "2026-11-25" }, NOW)).toThrow(/future/);
    expect(() => resolveRange({ preset: "custom", start: "2023-01-01", end: "2026-11-01" }, NOW)).toThrow(/at most 731 days/);
  });

  it("formats figures exactly as the agent's number check reads them", () => {
    expect([fmt(0.925, "pct"), fmt(4.25, "usd"), fmt(0.0012, "usd"), fmt(1234567, "int"), fmt(12_500, "ms"), fmt(950, "ms"), fmt(null, "int")]).toEqual(["92.5%", "$4.25", "$0.0012", "1,234,567", "12.5 s", "950 ms", "–"]);
  });
});

describe("building a report", () => {
  beforeEach(async () => {
    const t = (d: string, h = "06:00") => `${d}T${h}:00Z`;
    const ok1 = await run("optimize_article_flow", "succeeded", t("2026-11-20"), 0.5);
    for (let i = 0; i < 4; i++) await run("optimize_article_flow", "failed", t("2026-11-21", `0${i}:10`), 0.1, `WebAppError: HTTP 503 from https://user:hunter2@web.internal/x token=sk-abcdefghijklmnop ${crypto.randomUUID()}`);
    await run("news_job_flow", "succeeded", t("2026-11-22"));
    await run("news_dispatch_flow", "succeeded", t("2026-11-22")); // housekeeping: not counted
    await run("optimize_article_flow", "succeeded", t("2026-11-12"), 0.4); // previous period
    await usage(t("2026-11-20"), "claude-sonnet-5-5", 0.5, ok1, { agent: "editor", prompt: "seo-optimize-crew-v3", purpose: "draft" });
    await usage(t("2026-11-21"), "claude-haiku-5-5", 0.02, null, { agent: "", prompt: "news-classify-v1", purpose: "news.classify" });
    await usage(t("2026-11-21"), "claude-sonnet-5-5", 0.3, null, { agent: "writer", error: "max_tokens" });
    await usage(t("2026-11-21"), "custom-model", 0, null, { agent: "researcher" }); // tokens, no price
    await usage(t("2026-11-12"), "claude-sonnet-5-5", 0.2, null);
    await db.execute(sql`insert into seo_editorial_calendar (title, status, kind, target_date, brief) values ('Late idea', 'approved', 'editorial_idea', '2026-11-12', '{}'::jsonb)`);
  });

  const build = (categories: string[], scope: Partial<{ crews: string[] | "all"; flows: string[] | "all"; sources: string[] | "all" }> = {}) =>
    buildReport(db, { id: "11111111-1111-4111-8111-111111111111", title: "Test", range: resolveRange({ preset: "last_7_days" }, NOW), scope: { categories, crews: "all", flows: "all", sources: "all", ...scope }, site: { id: "jithendar.com", name: "Jithendar.com", origin: "https://jithendar.com" }, tenant: "jithendar.com", now: NOW }, { crewOfFamily: new Map([["seo-crew", "Editorial crew · editorial"], ["seo-optimize-crew", "Optimization crew · optimization"]]) });

  it("counts runs, finds failing flows with their recorded error, and keeps secrets out", async () => {
    const r = await build(["crewai", "reliability"]);
    const crew = r.categories.find((c) => c.key === "crewai")!;
    expect(crew.kpis.find((k) => k.label === "Flow runs")).toMatchObject({ value: 6, previous: 1, change: 5 });
    expect(crew.kpis.find((k) => k.label === "Failed")?.value).toBe(4);
    const failing = r.findings.find((f) => f.title === "optimize_article_flow failed 4 of 5 runs")!;
    expect(failing).toMatchObject({ severity: "high", confirmed: true, owner: "optimize_article_flow" });
    const errId = failing.evidence.find((e) => e.startsWith("E"))!;
    const err = r.untrusted.find((u) => u.id === errId)!.text;
    expect(err).toContain("HTTP 503");
    expect(err).not.toMatch(/hunter2|sk-abcdefghijklmnop/);
    expect(r.findings.find((f) => f.title.startsWith("optimize_article_flow: the same error"))).toBeTruthy(); // ids folded: 4 × one error
    expect(r.findings.map((f) => f.id)).toEqual(r.findings.map((_, i) => `F${i + 1}`)); // most severe first, numbered
    expect(r.facts.find((f) => f.label.endsWith("Flow runs"))?.value).toBe("6");
  });

  it("analyses LLM cost from the usage ledger: by model, crew, flow and agent, budgets, unknown prices", async () => {
    // The agent creates its budget table at start-up (seo-agent/app/llm_budgets.py); here, with no limit set.
    await db.execute(sql`create table seo_agent_llm_budget (id boolean primary key, daily_usd float8, monthly_usd float8)`);
    await db.execute(sql`insert into seo_agent_llm_budget values (true, null, null)`);
    const r = await build(["llm_cost", "ai_usage", "agents"]);
    const cost = r.categories.find((c) => c.key === "llm_cost")!;
    expect(cost.kpis[0]).toMatchObject({ label: "LLM cost", previous: 0.2 });
    expect(cost.kpis[0]!.value).toBeCloseTo(0.82, 6);
    const byCrew = cost.tables.find((t) => t.title === "Cost by crew")!;
    expect(byCrew.rows.map((x) => x.crew)).toEqual(expect.arrayContaining(["Optimization crew", "Editorial crew", "news-classify (prompt family)"]));
    expect(cost.tables.find((t) => t.title === "Cost by flow")!.rows.map((x) => x.flow)).toEqual(expect.arrayContaining(["optimize_article_flow", "web app (no flow run)"]));
    expect(r.findings.map((f) => f.title)).toEqual(expect.arrayContaining(["No LLM budget is set", "1 call(s) have tokens but no recorded cost", "1 model call(s) were cut off at their output limit"]));
    expect(r.categories.find((c) => c.key === "agents")!.tables[0]!.rows.map((x) => x.agent)).toEqual(expect.arrayContaining(["editor", "writer"]));
  });

  it("says the budget is unknown, not unset, when neither the agent nor its table answers", async () => {
    const r = await build(["llm_cost"]);
    expect(r.categories[0]!.note).toMatch(/LLM budget could not be read/);
    expect(r.findings.map((f) => f.title)).not.toContain("No LLM budget is set");
    expect(r.sources.find((s) => s.key === "llm_budget")?.status).toBe("unavailable");
  });

  it("reads the budget from the agent when it answers", async () => {
    const client = await import("@/lib/seo-agent/client");
    const spy = vi.spyOn(client, "getLlmBudget").mockResolvedValue({ budget: { daily_usd: 5, monthly_usd: 1 }, spent_usd: 0.95, forecast_usd: 3 } as never);
    const r = await build(["llm_cost"]);
    spy.mockRestore();
    expect(r.findings.find((f) => f.title === "95.0% of the monthly LLM budget is used")).toMatchObject({ severity: "high", confirmed: true });
  });

  it("reports sources that are not there instead of leaving them out", async () => {
    const r = await build(["traffic", "editorial"]);
    const traffic = r.categories.find((c) => c.key === "traffic")!;
    expect(traffic.status).toBe("unavailable");
    expect(r.sources.find((s) => s.key === "ga4")).toMatchObject({ status: "unavailable", detail: expect.stringMatching(/nothing synced from Google Analytics 4/) });
    expect(r.findings.find((f) => f.title.startsWith("Website traffic and analytics: data"))).toBeTruthy();
    expect(r.findings.find((f) => f.title.includes("past their date"))).toMatchObject({ category: "editorial", confirmed: true });
  });

  it("narrows to the flows chosen, and to the flows that run the crews chosen", async () => {
    const r = await build(["crewai"], { flows: ["news_job_flow"] });
    expect(r.categories[0]!.kpis[0]!.value).toBe(1);
    await db.execute(sql`update crewai_flows set crews = '{optimization}' where flow_name = 'optimize_article_flow'`);
    const c = await build(["crewai", "llm_cost"], { crews: ["optimization"] });
    expect(c.categories[0]!.kpis[0]!.value).toBe(5);
    expect(c.categories[1]!.kpis[0]!.value).toBe(0.5); // only the optimization crew's calls of its flow runs
    const sources = await build(["crewai"], { sources: ["flow_runs"] });
    expect(sources.sources.find((s) => s.key === "run_steps")?.status).toBe("not_selected");
  });

  it("lists table cells as facts, formatted", () => {
    const facts = factsOf([{ key: "x", label: "X", status: "ok", note: null, kpis: [{ id: "M1", label: "Cost", value: 1.5, previous: 1, change: 0.5, format: "usd" }], charts: [], tables: [{ id: "T1", title: "By flow", columns: [{ key: "flow", label: "Flow" }, { key: "cost", label: "Cost", format: "usd" }], rows: [{ flow: "a_flow", cost: 0.25 }] }] }]);
    expect(facts).toEqual([
      { id: "M1", label: "X: Cost", value: "$1.50" },
      { id: "M1p", label: "X: Cost, previous period", value: "$1.00" },
      { id: "M1c", label: "X: Cost, change", value: "+50.0%" },
      { id: "T1.r1.cost", label: "By flow: a_flow, Cost", value: "$0.25" },
    ]);
  });

  it("redacts credentials in any text it quotes", () => {
    expect(redactText("Authorization: Bearer abc.def password=s3cret https://u:p@host/x AKIAABCDEFGHIJKLMNOP")).toBe("Authorization: Bearer [redacted] password=[redacted] https://[redacted]@host/x [redacted]");
  });
});

describe("report lifecycle", () => {
  const body = { range: { preset: "last_7_days" }, categories: ["crewai", "llm_cost"] };

  it("validates the request and returns the open report when the same one is asked again", async () => {
    await expect(svc.createReport(admin, { range: { preset: "last_7_days" }, categories: [] })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createReport(admin, { range: { preset: "custom", start: "2026-11-20", end: "2999-01-01" }, categories: ["crewai"] })).rejects.toThrow(/future/);
    await expect(svc.createReport(admin, { range: { preset: "last_7_days" }, categories: ["nope"] })).rejects.toMatchObject({ status: 400 });
    const a = await svc.createReport(admin, body);
    const b = await svc.createReport(admin, { ...body, categories: ["llm_cost", "crewai"], title: "Other title" });
    expect(a.existing).toBe(false);
    expect(b).toEqual({ id: a.id, existing: true });
    const row = await svc.getReportRow(a.id);
    expect(row).toMatchObject({ status: "queued", kind: "console", title: "2-category report · Last 7 days", categories: ["crewai", "llm_cost"] });
    const [job] = rowsOf<{ kind: string; payload: { id: string } }>(await db.execute(sql`select kind, payload from job where kind = 'report'`));
    expect(job!.payload.id).toBe(a.id);
  });

  it("runs end to end: data and files, the agent's analysis and PDF in R2, cost, then the emails it asked for", async () => {
    const runId = "99999999-9999-4999-8999-999999999999";
    await db.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, triggered_by) values (${runId}, 'report_flow', 'x', 'running', 'manual')`);
    await usage(new Date().toISOString(), "claude-sonnet-5-5", 0.12, runId, { prompt: "seo-report-crew-v1", purpose: "report" });
    const { id } = await svc.createReport(admin, { ...body, email: { recipients: ["owner@example.com"], attach: true } });
    await runDueJobs({ report: svc.reportJobHandler });
    expect(agent.kickoffs).toEqual([{ flow: "report_flow", inputs: { report_id: id } }]);
    let row = (await svc.getReportRow(id))!;
    expect(row).toMatchObject({ status: "running", runId, progress: { step: "analysing" } });
    expect(Object.keys(row.files).sort()).toEqual(["csv", "html", "json"]);
    expect(row.files.html!.key).toMatch(new RegExp(`^jithendar/www/reports/jithendar\\.com/jithendar\\.com/\\d{4}/\\d{2}/${id}/report\\.html$`));
    // The agent's side.
    const data = await callbacks.siteReportData(id);
    expect(data.report).toMatchObject({ schema: "site-report/1", id });
    await expect(callbacks.siteReportAnalysis(id, { analysis: { root_causes: [{ issue: "x", cause: "y", status: "certain", evidence: [] }] }, check: {} })).rejects.toMatchObject({ status: 400 });
    await callbacks.siteReportAnalysis(id, { analysis: { executive_summary: "Runs fell. <script>alert(1)</script>", action_plan: [{ priority: "critical", action: "Retry the failed runs", owner: "optimize_article_flow", evidence: ["F1"] }] }, check: { ok: true, removed: [] }, crew: { status: "completed" } });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(400, 32)]);
    await expect(callbacks.siteReportPdf(id, { pdf: Buffer.from("not a pdf at all, definitely longer than one hundred bytes ............................................").toString("base64") })).rejects.toMatchObject({ status: 400 });
    const stored = await callbacks.siteReportPdf(id, { pdf: pdf.toString("base64") });
    row = (await svc.getReportRow(id))!;
    expect(row).toMatchObject({ status: "completed", llmCostUsd: 0.12 });
    expect(stored.key).toBe(row.files.pdf!.key);
    expect(r2.objects.get(row.files.pdf!.key)!.cacheControl).toBe("private, no-store");
    const html = r2.objects.get(row.files.html!.key)!.body.toString();
    expect(html).toContain("Retry the failed runs");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Content-Security-Policy");
    // Notify: the email the report asked for.
    expect(await callbacks.siteReportNotify(id)).toMatchObject({ queued: 1 });
    await runDueJobs({ report_email: email.reportEmailHandler });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "owner@example.com", attachments: [{ filename: expect.stringMatching(/\.pdf$/) }] });
    expect(mail.sent[0]!.html).toContain("r2.test/"); // the signed download link
    expect((await email.listDeliveries(id))[0]).toMatchObject({ status: "sent", mode: "attachment", attempts: 1 });
    // Downloads are short-lived signed links.
    expect((await svc.downloadUrl(id, "pdf")).url).toMatch(/X-Amz-Signature/);
  });

  it("completes without the agent, and says why", async () => {
    agent.mode = "legacy";
    r2.ready = false;
    const { id } = await svc.createReport(admin, body);
    await runDueJobs({ report: svc.reportJobHandler });
    const row = (await svc.getReportRow(id))!;
    expect(row.status).toBe("completed");
    expect(row.warnings).toEqual([expect.stringMatching(/^Files are not stored: media storage \(Cloudflare R2\) is not configured/), expect.stringMatching(/^No AI analysis and no PDF: the SEO agent is not set up/)]);
    expect((await svc.getReportData(id))!.aiUnavailable).toMatch(/not set up/);
    expect(row.files).toEqual({});
  });

  it("retries while the agent is unreachable, then completes without it", async () => {
    agent.fail = { status: 0, message: "unreachable" };
    const { id } = await svc.createReport(admin, body);
    const later = (m: number) => new Date(Date.now() + m * 60_000);
    await runDueJobs({ report: svc.reportJobHandler });
    expect((await svc.getReportRow(id))!.progress.step).toBe("waiting_agent");
    await runDueJobs({ report: svc.reportJobHandler }, later(2));
    await runDueJobs({ report: svc.reportJobHandler }, later(10));
    const row = (await svc.getReportRow(id))!;
    expect(row.status).toBe("completed");
    expect(row.warnings.join(" ")).toMatch(/could not start the analysis/);
  });

  it("follows the agent run: a failed run fails the report; retry, cancel and delete", async () => {
    const { id } = await svc.createReport(admin, body);
    await runDueJobs({ report: svc.reportJobHandler });
    await db.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, error, triggered_by) values ('99999999-9999-4999-8999-999999999999', 'report_flow', 'x', 'failed', 'crew blew up', 'manual')`);
    expect(await svc.getReportRow(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/report flow failed: crew blew up/) });
    await svc.retryReport(id, admin);
    expect(await svc.getReportRow(id)).toMatchObject({ status: "queued", error: null, runId: null });
    await db.execute(sql`delete from seo_flow_runs`);
    await runDueJobs({ report: svc.reportJobHandler }, new Date(Date.now() + 60_000));
    await svc.cancelReport(id, admin);
    expect(agent.cancelled).toEqual(["99999999-9999-4999-8999-999999999999"]);
    expect((await svc.getReportRow(id))!.status).toBe("cancelled");
    const again = await svc.regenerateReport(id, admin);
    expect(again.id).not.toBe(id);
    const keys = Object.values((await svc.getReportRow(id))!.files).map((f) => f!.key);
    await svc.deleteReport(id, admin);
    expect(await svc.getReportRow(id)).toBeNull();
    for (const k of keys) expect(r2.objects.has(k)).toBe(false);
  });

  it("never shows another site's report", async () => {
    const { id } = await svc.createReport(admin, body);
    await db.execute(sql`update seo_reports set site_id = 'other.example' where id = ${id}`);
    expect(await svc.getReportRow(id)).toBeNull();
    expect((await svc.listReports()).items.map((r) => r.id)).not.toContain(id);
    await expect(svc.downloadUrl(id, "pdf")).rejects.toMatchObject({ status: 404 });
  });

  it("lists briefings and console reports, filtered", async () => {
    await db.execute(sql`insert into seo_reports (period_type, period_start, period_end, payload, trigger) values ('weekly', '2026-11-16', '2026-11-22', '{}'::jsonb, 'schedule')`);
    const { id } = await svc.createReport(admin, body);
    expect((await svc.listReports()).items.map((r) => r.kind).sort()).toEqual(["briefing", "console"]);
    expect((await svc.listReports({ type: "briefing" })).items).toHaveLength(1);
    expect((await svc.listReports({ category: "llm_cost" })).items.map((r) => r.id)).toEqual([id]);
    expect((await svc.listReports({ q: "category report" })).total).toBe(1);
    expect((await svc.listReports({ status: "failed" })).total).toBe(0);
  });
});

describe("report email", () => {
  async function completed(pdfBytes: number) {
    const { id } = await svc.createReport(admin, { range: { preset: "yesterday" }, categories: ["editorial"] });
    await db.execute(sql`update seo_reports set status = 'completed', files = ${JSON.stringify({ pdf: { key: `jithendar/www/reports/t/s/2026/11/${id}/report.pdf`, bytes: pdfBytes, contentType: "application/pdf", filename: "r.pdf", storedAt: "" } })}::jsonb where id = ${id}`);
    r2.objects.set(`jithendar/www/reports/t/s/2026/11/${id}/report.pdf`, { body: Buffer.alloc(Math.min(pdfBytes, 2048)), contentType: "application/pdf" });
    return id;
  }

  it("attaches a PDF that fits and links one that does not; the preview is what is sent", async () => {
    const small = await completed(200_000);
    const big = await completed(9_000_000);
    expect((await email.previewEmail(small)).mode).toBe("attachment");
    const p = await email.previewEmail(big);
    expect(p.mode).toBe("link");
    expect(p.text).toMatch(/too large to attach/);
    expect(p.subject).toMatch(/^Editorial calendar and content planning · Yesterday · (\d{4}-\d{2}-\d{2}) – \1$/);
  });

  it("records each delivery: sent, or retried and then failed with the reason", async () => {
    const id = await completed(1000);
    mail.failWith = "SMTP 550 mailbox unavailable";
    await email.queueDeliveries(id, ["a@example.com", "A@example.com "], { attach: true, createdBy: "admin@example.com" });
    const later = (m: number) => new Date(Date.now() + m * 60_000);
    await runDueJobs({ report_email: email.reportEmailHandler });
    expect((await email.listDeliveries(id))).toMatchObject([{ recipient: "a@example.com", status: "retried", attempts: 1, error: "SMTP 550 mailbox unavailable" }]);
    await runDueJobs({ report_email: email.reportEmailHandler }, later(2));
    await runDueJobs({ report_email: email.reportEmailHandler }, later(10));
    expect((await email.listDeliveries(id))[0]).toMatchObject({ status: "failed", attempts: 3 });
    mail.failWith = null;
    await email.queueDeliveries(id, ["b@example.com"], { attach: false, createdBy: "admin@example.com" });
    await runDueJobs({ report_email: email.reportEmailHandler }, later(20));
    expect((await email.listDeliveries(id))[0]).toMatchObject({ recipient: "b@example.com", status: "sent", mode: "link" });
  });

  it("refuses to queue when email is not configured or the report is not finished", async () => {
    const id = await completed(1000);
    mail.configured = false;
    await expect(email.queueDeliveries(id, ["a@example.com"], { attach: true, createdBy: "x" })).rejects.toMatchObject({ status: 409, code: "mail_not_configured" });
    mail.configured = true;
    const { id: open } = await svc.createReport(admin, { range: { preset: "today" }, categories: ["crewai"] });
    await expect(email.queueDeliveries(open, ["a@example.com"], { attach: true, createdBy: "x" })).rejects.toMatchObject({ code: "not_completed" });
  });
});

describe("rendering", () => {
  it("escapes every value in HTML and keeps CSV cells from running as formulas", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const r = await buildReport(db, { id, title: `<img src=x onerror=alert(1)>"Report"`, range: resolveRange({ preset: "today" }, NOW), scope: { categories: ["editorial"], crews: "all", flows: "all", sources: "all" }, site: { id: "s", name: "S", origin: "https://s" }, tenant: "t", now: NOW });
    r.findings.push({ id: "F9", category: "editorial", severity: "low", title: "=HYPERLINK(\"x\")", detail: "</details><script>x</script>", impact: "", evidence: [], confirmed: false });
    const html = renderHtmlDocument(r);
    expect(html).not.toMatch(/<img src=x|<script>x|<\/details><script/);
    expect(html).toContain(esc(`<img src=x onerror=alert(1)>"Report"`));
    expect(html).toMatch(/default-src 'none'/);
    expect(renderCsv(r)).toContain(`'=HYPERLINK`);
  });

  it("keeps the weekly briefing's upsert working with the new partial index", async () => {
    const { generateReport } = await import("@/lib/seo-intel/reports");
    const a = await generateReport("weekly", "manual", NOW, { notify: false });
    const b = await generateReport("weekly", "manual", NOW, { notify: false });
    expect(b.id).toBe(a.id);
  });
});
