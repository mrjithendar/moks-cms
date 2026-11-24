import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { loadSiteFile } from "@/config/site-files";
import { auditSafe } from "../audit";
import { enqueue } from "../jobs";
import { log } from "../log";
import { siteOrigin } from "../seo-intel/urls";
import { buildReport, crewFamilies } from "./build";
import { CATEGORY_KEYS, categoryOf, SOURCES } from "./catalog";
import { bounds, PRESETS, rangeInput, RangeError, resolveRange } from "./ranges";
import { renderCsv, renderHtmlDocument, renderJson } from "./render";
import type { Analysis, AnalysisCheck, FileKind, ReportStatus, SiteReport, StoredFile } from "./types";

/**
 * CrewAI console reports (D-102): one row per report in seo_reports (the weekly and monthly briefings live there too,
 * with `request` null). Lifecycle:
 *
 *   create (admin, CrewAI console or SEO-AI Reports)  → queued, job "report" in the web worker's queue (lib/jobs.ts)
 *   job: build the data (build.ts) → store JSON, CSV and HTML in R2 → start report_flow {report_id} in the SEO agent
 *   agent: /site-reports/{id}/data → analysis → /analysis → PDF → /pdf (stores it, re-renders the HTML, completed)
 *          → /notify (queues the emails the report asked for)
 *
 * A report never waits on a request: the job runs in the background and the page polls. A run that fails or is
 * cancelled in the agent fails or cancels its report (reconcile, on every read). Without the agent (switched off,
 * unreachable three times) the report completes without the AI analysis and the PDF, and says why.
 * Every query is filtered by this site; a report of another site is "not found".
 */
export class ReportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "invalid",
  ) {
    super(message);
  }
}

export const REPORTS_PREFIX = "jithendar/www/reports";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_PART = (v: string) => v.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "site";
const CONTENT_TYPES: Record<FileKind, string> = { pdf: "application/pdf", html: "text/html; charset=utf-8", json: "application/json", csv: "text/csv; charset=utf-8" };
const AGENT_ATTEMPTS = 3;

/** This deployment's tenant and site. One site per deployment; MOKS_TENANT_ID names the customer when set. */
export function reportScope(env: Record<string, string | undefined> = process.env) {
  let site: { host: string; name: string } = { host: siteOrigin(env).host, name: siteOrigin(env).host };
  try {
    const f = loadSiteFile();
    site = { host: f.host || site.host, name: f.name || site.host };
  } catch {
    /* tests and setups without site.json: the origin's host */
  }
  const siteId = KEY_PART(site.host);
  return { tenantId: KEY_PART(env.MOKS_TENANT_ID?.trim() || siteId), siteId, siteName: site.name, origin: siteOrigin(env).origin };
}

export const requestSchema = z.object({
  title: z.string().trim().max(160).optional(),
  range: rangeInput,
  categories: z.array(z.enum(CATEGORY_KEYS as [string, ...string[]])).min(1, "Choose at least one category.").max(CATEGORY_KEYS.length),
  crews: z.union([z.literal("all"), z.array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)).min(1).max(50)]).default("all"),
  flows: z.union([z.literal("all"), z.array(z.string().regex(/^[a-z][a-z0-9_]{2,39}_flow$/)).min(1).max(80)]).default("all"),
  sources: z.union([z.literal("all"), z.array(z.enum(SOURCES.map((s) => s.key) as [string, ...string[]])).min(1)]).default("all"),
  email: z.object({ recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(10), attach: z.boolean().default(true) }).optional(),
});
export type ReportRequest = z.output<typeof requestSchema>;
export type Actor = { id?: string | null; label: string };

const q = async <T = Record<string, unknown>>(db: Db, query: ReturnType<typeof sql>) => rowsOf<T>(await db.execute(query));
const obj = <T>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

/** The same report asked twice: the same dates, categories, crews, flows and sources (title and email aside). */
export function requestHash(req: ReportRequest, range: { start: string; end: string }) {
  const sort = (v: string[] | "all") => (v === "all" ? "all" : [...v].sort());
  return createHash("sha256").update(JSON.stringify({ start: range.start, end: range.end, categories: [...req.categories].sort(), crews: sort(req.crews), flows: sort(req.flows), sources: sort(req.sources) })).digest("hex").slice(0, 32);
}

export function defaultTitle(req: ReportRequest) {
  const all = req.categories.length === CATEGORY_KEYS.length;
  const what = all ? "Site-wide report" : req.categories.length === 1 ? (categoryOf(req.categories[0]!)?.label ?? "Report") : `${req.categories.length}-category report`;
  return `${what} · ${PRESETS[req.range.preset]}`;
}

export async function createReport(actor: Actor, raw: unknown, opts: { now?: Date; db?: Db } = {}): Promise<{ id: string; existing: boolean }> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new ReportError(parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "), 400);
  const req = parsed.data;
  let range;
  try {
    range = resolveRange(req.range, opts.now);
  } catch (e) {
    if (e instanceof RangeError) throw new ReportError(e.message, 400);
    throw e;
  }
  const db = opts.db ?? (await getDb());
  const scope = reportScope();
  const hash = requestHash(req, range);
  const [open] = await q<{ id: string }>(db, sql`select id from seo_reports where site_id = ${scope.siteId} and request_hash = ${hash} and status in ('queued', 'running') and deleted_at is null`);
  if (open) return { id: open.id, existing: true };
  const { getSeoSettings } = await import("../seo-intel/settings");
  const keep = (await getSeoSettings().catch(() => null))?.reports.keepDays ?? 0;
  const id = randomUUID();
  const title = req.title?.trim() || defaultTitle(req);
  const rows = await q<{ id: string }>(db, sql`
    insert into seo_reports (id, period_type, period_start, period_end, payload, trigger, generated_at, title, status, categories, request, request_hash, progress, created_by, created_by_id, tenant_id, site_id, expires_at)
    values (${id}, ${req.range.preset}, ${range.start}, ${range.end}, '{}'::jsonb, 'manual', now(), ${title}, 'queued', ${`{${req.categories.join(",")}}`}::text[], ${JSON.stringify({ ...req, resolved: range })}::jsonb, ${hash},
      ${JSON.stringify({ step: "queued", percent: 0, message: "Waiting for the web worker" })}::jsonb, ${actor.label}, ${actor.id ?? null}, ${scope.tenantId}, ${scope.siteId},
      ${keep > 0 ? new Date((opts.now ?? new Date()).getTime() + keep * 86_400_000).toISOString() : null})
    on conflict do nothing returning id`);
  if (!rows.length) {
    const [again] = await q<{ id: string }>(db, sql`select id from seo_reports where site_id = ${scope.siteId} and request_hash = ${hash} and status in ('queued', 'running') and deleted_at is null`);
    if (again) return { id: again.id, existing: true };
    throw new ReportError("The report could not be created.", 409, "conflict");
  }
  await enqueue("report", { id }, { dedupeKey: `report:${id}:0`, maxAttempts: AGENT_ATTEMPTS + 1 });
  return { id, existing: false };
}

// --- reading -------------------------------------------------------------------------------------------------------

export type ReportRow = {
  id: string;
  kind: "console" | "briefing";
  title: string;
  status: ReportStatus;
  preset: string;
  start: string;
  end: string;
  categories: string[];
  request: (ReportRequest & { resolved?: unknown }) | null;
  progress: { step?: string; percent?: number; message?: string };
  files: Partial<Record<FileKind, StoredFile>>;
  error: string | null;
  warnings: string[];
  runId: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  llmTokens: number;
  llmCostUsd: number;
  expiresAt: string | null;
  emailedAt: string | null;
  siteId: string | null;
  bytes: number;
  /** A briefing whose narrative passed the number check (report_flow). */
  summarized: boolean;
};

function shape(r: Record<string, unknown>): ReportRow {
  const files = obj<Partial<Record<FileKind, StoredFile>>>(r.files, {});
  const legacyPdf = obj<{ key?: string; bytes?: number; filename?: string; generatedAt?: string } | null>(r.legacy_pdf, null);
  if (r.request === null && legacyPdf?.key && !files.pdf) files.pdf = { key: legacyPdf.key, bytes: Number(legacyPdf.bytes ?? 0), contentType: "application/pdf", filename: legacyPdf.filename ?? "report.pdf", storedAt: legacyPdf.generatedAt ?? "" };
  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
  return {
    id: String(r.id),
    kind: r.request === null || r.request === undefined ? "briefing" : "console",
    title: String(r.title ?? (r.request ? "Report" : `SEO ${String(r.period_type)} report`)),
    status: String(r.status ?? "completed") as ReportStatus,
    preset: String(r.period_type),
    start: String(r.period_start).slice(0, 10),
    end: String(r.period_end).slice(0, 10),
    categories: Array.isArray(r.categories) ? (r.categories as string[]) : typeof r.categories === "string" ? String(r.categories).slice(1, -1).split(",").filter(Boolean) : [],
    request: obj(r.request, null),
    progress: obj(r.progress, {}),
    files,
    error: (r.error as string | null) ?? null,
    warnings: obj<string[]>(r.warnings, []),
    runId: (r.run_id as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.created_at ?? r.generated_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    llmTokens: Number(r.llm_tokens ?? 0),
    llmCostUsd: Number(r.llm_cost_usd ?? 0),
    expiresAt: iso(r.expires_at),
    emailedAt: iso(r.emailed_at),
    siteId: (r.site_id as string | null) ?? null,
    bytes: Object.values(files).reduce((n, f) => n + Number(f?.bytes ?? 0), 0),
    summarized: r.summarized === true || r.summarized === "t",
  };
}

const COLUMNS = sql`id, period_type, period_start::text, period_end::text, generated_at, emailed_at, trigger, title, status, categories, request, progress, files, error, warnings, run_id, created_by, created_at, started_at, finished_at, duration_ms, llm_tokens, llm_cost_usd, expires_at, site_id, payload->'pdf' as legacy_pdf, payload ? 'narrative' as summarized`;
/** This site's reports, and the briefings made before reports had a site (single-site deployments). */
const SITE = (siteId: string) => sql`deleted_at is null and (site_id = ${siteId} or (site_id is null and request is null))`;

export type ListFilters = { q?: string; category?: string; status?: string; type?: string; from?: string; to?: string; limit?: number; offset?: number };

export async function listReports(f: ListFilters = {}, db?: Db): Promise<{ items: ReportRow[]; total: number }> {
  const d = db ?? (await getDb());
  await reconcileOpen(d);
  const { siteId } = reportScope();
  const parts = [SITE(siteId)];
  if (f.q) parts.push(sql`coalesce(title, '') ilike ${`%${f.q.replace(/[%_\\]/g, "\\$&")}%`}`);
  if (f.category) parts.push(sql`(${f.category} = any(categories) or (${f.category} = 'seo' and request is null))`);
  if (f.status) parts.push(sql`status = ${f.status}`);
  if (f.type === "briefing") parts.push(sql`request is null`);
  else if (f.type) parts.push(sql`period_type = ${f.type} and request is not null`);
  if (f.from) parts.push(sql`coalesce(created_at, generated_at) >= ${bounds(f.from, f.from).from}`);
  if (f.to) parts.push(sql`coalesce(created_at, generated_at) < ${bounds(f.to, f.to).to}`);
  const where = sql.join(parts, sql` and `);
  const [{ n } = { n: 0 }] = await q<{ n: number }>(d, sql`select count(*)::int as n from seo_reports where ${where}`);
  const rows = await q(d, sql`select ${COLUMNS} from seo_reports where ${where} order by coalesce(created_at, generated_at) desc limit ${Math.min(100, f.limit ?? 25)} offset ${Math.max(0, f.offset ?? 0)}`);
  return { items: rows.map(shape), total: Number(n) };
}

export async function getReportRow(id: string, db?: Db): Promise<ReportRow | null> {
  if (!ID.test(id)) return null;
  const d = db ?? (await getDb());
  await reconcileOpen(d, id);
  const [r] = await q(d, sql`select ${COLUMNS} from seo_reports where id = ${id} and ${SITE(reportScope().siteId)}`);
  return r ? shape(r) : null;
}

/** The report's data (built, plus the analysis once it is back), or null while it is being built. */
export async function getReportData(id: string, db?: Db): Promise<SiteReport | null> {
  if (!ID.test(id)) return null;
  const d = db ?? (await getDb());
  const [r] = await q<{ payload: unknown }>(d, sql`select payload from seo_reports where id = ${id} and request is not null and ${SITE(reportScope().siteId)}`);
  const p = obj<Partial<SiteReport>>(r?.payload, {});
  return p.schema ? (p as SiteReport) : null;
}

/**
 * Follow the agent: a console report whose report_flow run failed, was cancelled or ended without storing the PDF fails
 * (or is cancelled) with the run's reason; one stuck for two hours fails. Cheap enough to run on every read.
 */
export async function reconcileOpen(db: Db, id?: string) {
  const open = await q<{ id: string; run_id: string | null; status: string; started_at: string | null; created_at: string; run_status: string | null; run_error: string | null }>(
    db,
    sql`select r.id, r.run_id, r.status, r.started_at, r.created_at, f.status as run_status, f.error as run_error from seo_reports r left join seo_flow_runs f on f.run_id = r.run_id
      where r.status in ('queued', 'running') and r.request is not null and r.deleted_at is null ${id ? sql`and r.id = ${id}` : sql``}`,
  ).catch(() => []);
  for (const r of open) {
    if (r.run_status === "failed" || r.run_status === "paused_budget") await finish(db, r.id, "failed", `The report flow ${r.run_status === "paused_budget" ? "stopped on the LLM budget" : "failed"}: ${String(r.run_error ?? "no error recorded").slice(0, 400)}`);
    else if (r.run_status === "cancelled") await finish(db, r.id, "cancelled", "The report flow was cancelled.");
    else if (r.run_status === "succeeded") {
      const [row] = await q<{ files: unknown }>(db, sql`select files from seo_reports where id = ${r.id}`);
      if (!obj<Record<string, unknown>>(row?.files, {}).pdf) await finish(db, r.id, "failed", "The report flow finished without storing the PDF (see its run in the CrewAI console).");
    } else if (Date.now() - Date.parse(r.started_at ?? r.created_at) > 2 * 3_600_000) await finish(db, r.id, "failed", "Timed out: the report was not finished within two hours.");
  }
}

async function progress(db: Db, id: string, step: string, percent: number, message: string) {
  await db.execute(sql`update seo_reports set progress = ${JSON.stringify({ step, percent, message })}::jsonb where id = ${id}`);
}

async function finish(db: Db, id: string, status: "completed" | "failed" | "cancelled", error: string | null, warning?: string) {
  await db.execute(sql`
    update seo_reports set status = ${status}, error = ${error}, finished_at = now(), generated_at = now(),
      duration_ms = (extract(epoch from now() - coalesce(started_at, created_at)) * 1000)::int,
      warnings = case when ${warning ?? null}::text is null or warnings ? ${warning ?? ""} then warnings else warnings || to_jsonb(${warning ?? ""}::text) end,
      progress = ${JSON.stringify({ step: status, percent: status === "completed" ? 100 : 0, message: status === "completed" ? "Done" : (error ?? status) })}::jsonb
    where id = ${id} and status in ('queued', 'running')`);
}

// --- R2 ----------------------------------------------------------------------------------------------------------------

export function objectKey(row: { id: string; tenantId: string; siteId: string; createdAt: Date }, kind: FileKind) {
  if (!ID.test(row.id)) throw new Error("report id must be a UUID");
  const yyyy = String(row.createdAt.getUTCFullYear());
  const mm = String(row.createdAt.getUTCMonth() + 1).padStart(2, "0");
  return `${REPORTS_PREFIX}/${KEY_PART(row.tenantId)}/${KEY_PART(row.siteId)}/${yyyy}/${mm}/${row.id}/report.${kind}`;
}

async function storeFiles(db: Db, id: string, files: Partial<Record<FileKind, Buffer>>): Promise<string | null> {
  const [row] = await q<{ tenant_id: string; site_id: string; created_at: string; title: string; period_start: string }>(db, sql`select tenant_id, site_id, created_at, title, period_start::text from seo_reports where id = ${id}`);
  if (!row) throw new ReportError("Report not found.", 404, "not_found");
  const { storageReady, putObject } = await import("../storage");
  if (!(await storageReady())) return "Files are not stored: media storage (Cloudflare R2) is not configured (Settings → Storage). The report can still be viewed here.";
  const stored: Partial<Record<FileKind, StoredFile>> = {};
  const base = `${String(row.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report"}-${String(row.period_start).slice(0, 10)}`;
  for (const [kind, body] of Object.entries(files) as [FileKind, Buffer][]) {
    const key = objectKey({ id, tenantId: row.tenant_id, siteId: row.site_id, createdAt: new Date(row.created_at) }, kind);
    await putObject(key, body, { contentType: CONTENT_TYPES[kind], cacheControl: "private, no-store", contentMd5: createHash("md5").update(body).digest("base64") });
    stored[kind] = { key, bytes: body.length, contentType: CONTENT_TYPES[kind], filename: `${base}.${kind}`, storedAt: new Date().toISOString() };
  }
  await db.execute(sql`update seo_reports set files = files || ${JSON.stringify(stored)}::jsonb where id = ${id}`);
  return null;
}

async function storeRendered(db: Db, id: string, report: SiteReport, pdf?: Buffer) {
  return storeFiles(db, id, { ...(pdf ? { pdf } : {}), html: Buffer.from(renderHtmlDocument(report)), json: Buffer.from(renderJson(report)), csv: Buffer.from(renderCsv(report)) });
}

/** A 5-minute signed link to one of the report's files (the objects are private; the URL never outlives the link). */
export async function downloadUrl(id: string, kind: FileKind, expiresIn = 300): Promise<{ url: string; file: StoredFile }> {
  const row = await getReportRow(id);
  if (!row) throw new ReportError("Report not found.", 404, "not_found");
  const file = row.files[kind];
  if (!file) throw new ReportError(row.status === "completed" ? `This report has no ${kind.toUpperCase()} file${kind === "pdf" ? " (the PDF is made by the SEO agent)" : ""}.` : "The report is not finished yet.", 404, "no_file");
  const { presignGet } = await import("../storage");
  return { url: await presignGet(file.key, file.filename, expiresIn), file };
}

// --- the job (web worker) ----------------------------------------------------------------------------------------------

/** Job "report": build, store, and hand over to the agent. Retried (by the queue) while the agent is unreachable. */
export async function reportJobHandler(payload: Record<string, unknown>) {
  const id = String(payload.id ?? "");
  const db = await getDb();
  const [row] = await q<{ status: string; request: unknown; title: string; tenant_id: string; site_id: string; attempts: number; payload: unknown }>(db, sql`select status, request, title, tenant_id, site_id, attempts, payload from seo_reports where id = ${id} and deleted_at is null`);
  if (!row || !["queued", "running"].includes(row.status)) return; // cancelled, deleted or already done
  const req = obj<ReportRequest & { resolved: SiteReport["range"] }>(row.request, null as never);
  await db.execute(sql`update seo_reports set status = 'running', started_at = coalesce(started_at, now()), attempts = attempts + 1 where id = ${id}`);
  let report = obj<SiteReport | Record<string, never>>(row.payload, {}) as SiteReport;
  if (!report.schema) {
    await progress(db, id, "collecting", 10, "Reading the data sources");
    const scope = reportScope();
    report = await buildReport(db, { id, title: row.title, range: req.resolved, scope: { categories: req.categories, crews: req.crews, flows: req.flows, sources: req.sources }, site: { id: scope.siteId, name: scope.siteName, origin: scope.origin }, tenant: scope.tenantId }, { crewOfFamily: await crewFamilies() });
    await db.execute(sql`update seo_reports set payload = ${JSON.stringify(report)}::jsonb where id = ${id}`);
    await progress(db, id, "storing", 30, "Storing HTML, JSON and CSV");
    const warning = await storeRendered(db, id, report);
    if (warning) await addWarning(db, id, warning);
  }
  // The analysis and the PDF: report_flow in the SEO agent.
  const [now] = await q<{ status: string }>(db, sql`select status from seo_reports where id = ${id}`);
  if (now?.status !== "running") return;
  const attempts = Number(row.attempts) + 1;
  try {
    const { orchestrator } = await import("../seo-agent/endpoint");
    if ((await orchestrator()) !== "crewai") return await withoutAgent(db, id, report, "the SEO agent is not set up (Settings → Integrations → SEO agent)");
    const { kickoff } = await import("../seo-agent/client");
    await progress(db, id, "analysing", 40, "Handed to the SEO agent: AI analysis and PDF");
    const r = await kickoff("report_flow", { report_id: id }, { triggeredBy: "manual", actor: `report:${id}` });
    await db.execute(sql`update seo_reports set run_id = ${r.run_id} where id = ${id}`);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    const transient = status === 0 || status >= 500 || status === 429;
    if (transient && attempts < AGENT_ATTEMPTS) {
      await progress(db, id, "waiting_agent", 35, `The SEO agent did not answer (attempt ${attempts} of ${AGENT_ATTEMPTS}); trying again`);
      throw e; // the queue retries with backoff
    }
    await withoutAgent(db, id, report, `the SEO agent could not start the analysis: ${(e as Error).message.slice(0, 200)}`);
  }
}

async function addWarning(db: Db, id: string, warning: string) {
  await db.execute(sql`update seo_reports set warnings = warnings || to_jsonb(${warning}::text) where id = ${id} and not warnings ? ${warning}`);
}

async function withoutAgent(db: Db, id: string, report: SiteReport, why: string) {
  const r: SiteReport = { ...report, aiUnavailable: why };
  await db.execute(sql`update seo_reports set payload = ${JSON.stringify(r)}::jsonb where id = ${id}`);
  const warning = await storeRendered(db, id, r);
  if (warning) await addWarning(db, id, warning);
  await finish(db, id, "completed", null, `No AI analysis and no PDF: ${why}.`);
  log.warn("report completed without the agent", { operation: "report", reportId: id, reason: why });
  await notify(id);
}

// --- agent callbacks (internal-server.ts /site-reports/…) ----------------------------------------------------------------

export async function agentData(id: string) {
  const db = await getDb();
  const [r] = await q<{ payload: unknown; status: string }>(db, sql`select payload, status from seo_reports where id = ${id} and request is not null and deleted_at is null`);
  if (!r) throw new ReportError("Report not found.", 404, "not_found");
  if (r.status !== "running") throw new ReportError(`The report is ${r.status}.`, 409, "not_running");
  const report = obj<SiteReport>(r.payload, null as never);
  if (!report?.schema) throw new ReportError("The report has no data yet.", 409, "not_built");
  await progress(db, id, "analysing", 50, "The Report crew is analysing the data");
  const { analysis: _a, analysisCheck: _c, aiUnavailable: _u, ...data } = report;
  return { report: data };
}

export async function agentAnalysis(id: string, body: { analysis: Analysis; check: AnalysisCheck; crew: Record<string, unknown> }) {
  const db = await getDb();
  const [r] = await q<{ payload: unknown }>(db, sql`select payload from seo_reports where id = ${id} and request is not null and status = 'running'`);
  if (!r) throw new ReportError("Report not found or not running.", 404, "not_found");
  const has = !!(body.analysis && Object.keys(body.analysis).length);
  const reason = has ? null : `the Report crew gave no analysis (${String(body.crew?.reason ?? body.check?.reason ?? "no reason given").slice(0, 200)})`;
  const report: SiteReport = { ...obj<SiteReport>(r.payload, null as never), analysis: has ? body.analysis : null, analysisCheck: body.check ?? null, aiUnavailable: reason };
  await db.execute(sql`update seo_reports set payload = ${JSON.stringify(report)}::jsonb where id = ${id}`);
  await progress(db, id, "rendering", 75, "Rendering the PDF");
  return { ok: true };
}

export async function agentPdf(id: string, pdf: Buffer) {
  if (pdf.length < 100 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ReportError("not a PDF", 400);
  if (pdf.length > 12 * 1024 * 1024) throw new ReportError("PDF too large", 400);
  const db = await getDb();
  const [r] = await q<{ payload: unknown; run_id: string | null }>(db, sql`select payload, run_id from seo_reports where id = ${id} and request is not null and status = 'running'`);
  if (!r) throw new ReportError("Report not found or not running.", 404, "not_found");
  await progress(db, id, "storing", 90, "Storing the files in R2");
  const report = obj<SiteReport>(r.payload, null as never);
  const warning = await storeRendered(db, id, report, pdf);
  if (warning) throw new ReportError("Could not store the PDF: Cloudflare R2 is not configured.", 503, "storage");
  const [cost] = r.run_id ? await q<{ cost: number; tokens: number }>(db, sql`select coalesce(sum(cost_usd), 0)::float8 as cost, coalesce(sum(input_tokens + output_tokens), 0)::int as tokens from seo_llm_usage where run_id = ${r.run_id}`) : [];
  await db.execute(sql`update seo_reports set llm_cost_usd = ${Number(cost?.cost ?? 0)}, llm_tokens = ${Number(cost?.tokens ?? 0)} where id = ${id}`);
  await finish(db, id, "completed", null, report.aiUnavailable ? `No AI analysis: ${report.aiUnavailable}.` : undefined);
  const [f] = await q<{ files: unknown }>(db, sql`select files from seo_reports where id = ${id}`);
  return { key: obj<Record<string, StoredFile>>(f?.files, {}).pdf?.key ?? null, bytes: pdf.length };
}

/** The emails the report asked for when it was made (Generate and email). */
export async function notify(id: string): Promise<{ queued: number }> {
  const db = await getDb();
  const [r] = await q<{ request: unknown; created_by: string | null }>(db, sql`select request, created_by from seo_reports where id = ${id} and request is not null`);
  const req = obj<ReportRequest | null>(r?.request, null);
  if (!req?.email?.recipients.length) return { queued: 0 };
  const { queueDeliveries } = await import("./email");
  return queueDeliveries(id, req.email.recipients, { attach: req.email.attach, createdBy: r?.created_by ?? "report" });
}

// --- actions ---------------------------------------------------------------------------------------------------------

export async function cancelReport(id: string, actor: Actor) {
  const row = await getReportRow(id);
  if (!row || row.kind !== "console") throw new ReportError("Report not found.", 404, "not_found");
  if (!["queued", "running"].includes(row.status)) throw new ReportError("This report has already finished.", 409, "finished");
  if (row.runId) {
    const { cancelRun } = await import("../seo-agent/client");
    await cancelRun(row.runId).catch((e) => log.warn("report run cancel failed", { operation: "report", reportId: id, error: (e as Error).message }));
  }
  await finish(await getDb(), id, "cancelled", `Cancelled by ${actor.label}.`);
  await auditSafe(actor, "report.cancel", id, {});
}

/** Start a failed or cancelled report again, from scratch (its data is rebuilt; its files replaced). */
export async function retryReport(id: string, actor: Actor) {
  const row = await getReportRow(id);
  if (!row || row.kind !== "console") throw new ReportError("Report not found.", 404, "not_found");
  if (!["failed", "cancelled"].includes(row.status)) throw new ReportError("Only a failed or cancelled report can be retried.", 409, "not_failed");
  const db = await getDb();
  const [open] = await q<{ id: string }>(db, sql`select o.id from seo_reports o join seo_reports r on r.id = ${id} where o.site_id = r.site_id and o.request_hash = r.request_hash and o.status in ('queued', 'running') and o.deleted_at is null`);
  if (open) throw new ReportError("The same report is already being generated.", 409, "running");
  const attempt = Date.now();
  await db.execute(sql`update seo_reports set status = 'queued', error = null, run_id = null, attempts = 0, payload = '{}'::jsonb, started_at = null, finished_at = null, duration_ms = null, warnings = '[]'::jsonb, progress = ${JSON.stringify({ step: "queued", percent: 0, message: "Waiting for the web worker" })}::jsonb where id = ${id}`);
  await enqueue("report", { id }, { dedupeKey: `report:${id}:${attempt}`, maxAttempts: AGENT_ATTEMPTS + 1 });
  await auditSafe(actor, "report.retry", id, {});
}

/** A new report with the same dates (re-resolved for presets), categories, crews, flows and sources. */
export async function regenerateReport(id: string, actor: Actor) {
  const row = await getReportRow(id);
  if (!row || row.kind !== "console" || !row.request) throw new ReportError("Only a report made in the console can be generated again.", 404, "not_found");
  const { resolved: _r, email: _e, ...req } = row.request as ReportRequest & { resolved?: unknown };
  const out = await createReport(actor, req);
  await auditSafe(actor, "report.regenerate", out.id, { from: id });
  return out;
}

export async function deleteReport(id: string, actor: Actor) {
  const row = await getReportRow(id);
  if (!row) throw new ReportError("Report not found.", 404, "not_found");
  if (row.kind === "console" && ["queued", "running"].includes(row.status)) await cancelReport(id, actor);
  const removed = await deleteFiles(row);
  await (await getDb()).execute(sql`update seo_reports set deleted_at = now(), files = '{}'::jsonb where id = ${id}`);
  await auditSafe(actor, "report.delete", id, { title: row.title, files: removed });
}

async function deleteFiles(row: ReportRow): Promise<number> {
  let n = 0;
  const { deleteObject } = await import("../storage");
  for (const f of Object.values(row.files)) {
    if (!f?.key?.startsWith(`${REPORTS_PREFIX}/`)) continue;
    try {
      await deleteObject(f.key);
      n++;
    } catch (e) {
      log.warn("report file not deleted", { operation: "report_delete", key: f.key, error: (e as Error).message });
    }
  }
  return n;
}

/** Retention (daily): console reports past their expiry are deleted with their files (AI & SEO → Settings → Reports). */
export async function purgeExpiredReports(now = new Date()): Promise<number> {
  const db = await getDb();
  const rows = await q(db, sql`select ${COLUMNS} from seo_reports where request is not null and deleted_at is null and expires_at is not null and expires_at < ${now.toISOString()} and status not in ('queued', 'running') limit 200`);
  for (const r of rows) {
    const row = shape(r);
    await deleteFiles(row);
    await db.execute(sql`update seo_reports set deleted_at = now(), files = '{}'::jsonb where id = ${row.id}`);
  }
  return rows.length;
}
