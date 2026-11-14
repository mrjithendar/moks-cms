import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { auditSafe } from "../audit";
import { articlePanel } from "../seo-intel/article-panel";
import type { Change } from "../seo-intel/changeset";
import { changeDiff } from "../seo-intel/diff-model";
import { getDraft, rejectDraft, reviewQueue } from "../seo-intel/drafts";
import { runSeoJob } from "../seo-intel/jobs";
import { keywordTable, parseKwParams } from "../seo-intel/keywords";
import { overview, parseFilters } from "../seo-intel/queries";
import { generateReport, notifyReport, storeReportNarrative, storeReportPdf } from "../seo-intel/reports";
import { addDays } from "../seo-intel/sqlutil";
import { latestScan } from "../seo-intel/technical";
import { siteOrigin } from "../seo-intel/urls";
import { CallbackError } from "./callbacks";
import { clusterAskGaps } from "./gaps";

/**
 * v4 callbacks for the seo-agent (CrewAI flows and the MCP servers' service layer). Every handler is a thin wrapper
 * over the function the admin UI already uses; nothing here publishes. Writes: run an existing sync/audit job, reject a
 * draft (idempotent), add a review note, store a report's narrative/PDF, re-cluster Ask-the-Blog gaps.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (v: string, what = "id") => {
  if (!UUID.test(v)) throw new CallbackError(`Invalid ${what}.`, 400, "invalid");
  return v;
};
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CallbackError(`Invalid request: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 5).join("; ")}`, 400, "invalid");
  return r.data;
}
const agentActor = (label: string) => ({ id: null, label: `seo-agent (${label.slice(0, 120)})` });

// --- Jobs (gsc_sync_flow, ga4_sync_flow, tech_audit_flow) ---------------------------------------------------------

/**
 * POST /jobs/run {type, slot, trigger} — the existing v1 job runner (lease, seo_sync_jobs row, metrics). A scheduled
 * run is idempotent per slot: if this job type already ran for the slot (from the CronJob or, before switching, the
 * in-process scheduler), it is skipped, so a job never runs twice for one schedule occurrence.
 */
export async function runJob(body: unknown) {
  await import("../seo-intel/handlers"); // registers the technical_scan (and other) handlers
  const b = parse(z.object({ type: z.enum(["gsc_sync", "ga4_sync", "technical_scan", "topic_discovery"]), slot: z.string().regex(/^[0-9A-Za-z:_-]{1,40}$/).nullable().optional(), trigger: z.enum(["schedule", "manual"]) }), body);
  if (b.trigger === "schedule" && b.slot) {
    const db = await getDb();
    const [seen] = rowsOf<{ id: string; status: string }>(await db.execute(sql`select id, status from seo_sync_jobs where job_type = ${b.type} and trigger = 'schedule' and detail->>'slot' = ${b.slot} order by started_at desc limit 1`));
    if (seen) return { id: seen.id, status: "skipped", rows: 0, skipped: "slot already ran", previousStatus: seen.status };
  }
  const r = await runSeoJob({ type: b.type, trigger: b.trigger, slot: b.slot ?? undefined, actor: "seo-agent" });
  return { id: r.id, status: r.status, rows: r.rows, error: r.error ?? null, errorCode: r.errorCode ?? null, window: r.window ?? null, correlationId: r.correlationId };
}

// --- Drafts (review decision + admin MCP) ------------------------------------------------------------------------

export async function draftSummary(draftId: string) {
  const d = await getDraft(uuid(draftId, "draft id"));
  if (!d) throw new CallbackError("Draft not found.", 404, "not_found");
  // generatedAt: null for a draft that was reserved but never drafted (the admin MCP may only draft those, or failed
  // ones). publishedApprovalId: the approval whose publish made a published draft live (publish_flow's retry check).
  let publishedApprovalId: string | null = null;
  if (d.status === "published") {
    const db = await getDb();
    publishedApprovalId = rowsOf<{ id: string }>(await db.execute(sql`select id from seo_draft_approvals where draft_id = ${d.id} and used_at is not null order by used_at desc limit 1`))[0]?.id ?? null;
  }
  const generatedAt = d.generated_at ? new Date(String(d.generated_at)).toISOString() : null;
  return { id: d.id, kind: d.kind ?? "optimize", articleId: d.article_id, calendarId: (d.calendar_id as string | null) ?? null, status: d.status, recommendationIds: d.recommendation_ids ?? [], generatedAt, publishedApprovalId };
}

/** POST /drafts/{id}/reject — v2's rejectDraft; a no-op for a draft that is already rejected (the web route did it). */
export async function rejectDraftCb(draftId: string, body: unknown) {
  const b = parse(z.object({ reason: z.string().max(1000).nullable().optional(), actor: z.string().max(200) }), body);
  const d = await getDraft(uuid(draftId, "draft id"));
  if (!d) throw new CallbackError("Draft not found.", 404, "not_found");
  if (d.status === "rejected") return { status: "rejected", already: true };
  if (["published", "scheduled", "rolled_back"].includes(d.status)) throw new CallbackError(`This draft is ${d.status.replace(/_/g, " ")}.`, 409, "conflict");
  const actor = agentActor(b.actor);
  await rejectDraft(draftId, actor, b.reason ?? null);
  await auditSafe(actor, "seo.draft.reject", draftId, { reason: b.reason ?? null, via: b.actor.startsWith("mcp:") ? "mcp" : "agent" });
  return { status: "rejected" };
}

/** POST /drafts/{id}/notes — a note shown in the web diff view (admin MCP add_review_note). */
export async function addNote(draftId: string, body: unknown) {
  const b = parse(z.object({ note: z.string().trim().min(1).max(2000), actor: z.string().max(200) }), body);
  if (!(await getDraft(uuid(draftId, "draft id")))) throw new CallbackError("Draft not found.", 404, "not_found");
  const db = await getDb();
  const [r] = rowsOf<{ id: number }>(await db.execute(sql`insert into seo_draft_notes (draft_id, author, note) values (${draftId}, ${b.actor}, ${b.note}) returning id`));
  await auditSafe(agentActor(b.actor), "seo.draft.note", draftId, { length: b.note.length });
  return { id: Number(r!.id) };
}

export async function draftNotes(draftId: string) {
  const db = await getDb();
  return rowsOf<{ id: number; author: string; note: string; created_at: string }>(await db.execute(sql`select id, author, note, created_at::text from seo_draft_notes where draft_id = ${draftId} order by created_at`));
}

/** GET /review/queue — v2's reviewQueue, trimmed, paginated. */
export async function reviewQueueCb(q: URLSearchParams) {
  const sort = (["priority", "changes"] as const).find((s) => s === q.get("sort")) ?? (q.get("sort") === "age" ? "oldest" : "priority");
  const priority = (["high", "medium", "low"] as const).find((p) => p === q.get("priority"));
  const kind = q.get("kind");
  const items = (await reviewQueue({ sort, priority, ...(kind === "news" ? { collection: "news" as const } : {}) })).filter((i) => i.status === "ready_for_review" && (!kind || kind === "news" || i.kind === kind));
  const limit = Math.min(51, Math.max(1, Number(q.get("limit") ?? 20) || 20));
  const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  return {
    total: items.length,
    items: items.slice(offset, offset + limit).map((i) => ({ id: i.id, title: i.title, path: i.path, kind: i.collection === "news" ? "news" : i.kind, priority: i.band, status: i.status, changes: i.changeCount, accepted: i.accepted, flags: i.errorFlags, createdAt: i.createdAt, summary: i.evidence.join(" · ") })),
  };
}

/** GET /drafts/{id}/diff — change list with before/after, a text diff, rationale, evidence and flags. No HTML. */
export async function draftDiff(draftId: string) {
  const d = await getDraft(uuid(draftId, "draft id"));
  if (!d) throw new CallbackError("Draft not found.", 404, "not_found");
  // Word-diff markup: [-removed-]{+added+} (git's word-diff convention), plain text only.
  const text = (c: Change) => {
    const d = changeDiff(c);
    const segs = d.lines ?? d.segments;
    return segs.map((x) => (x.op === "ins" ? `{+${x.text}+}` : x.op === "del" ? `[-${x.text}-]` : x.text)).join(d.lines ? "\n" : " ").slice(0, 4000);
  };
  return {
    title: d.article.title,
    path: d.article.path,
    status: d.status,
    summary: (d.summary as string | null) ?? null,
    flags: d.flags,
    notes: await draftNotes(draftId),
    changes: d.changes.map((c) => ({ id: c.id, type: c.type, location: c.location ?? null, decision: c.decision, before: c.before, after: c.edited ?? c.after, diffText: text(c), rationale: c.rationale ?? null, evidence: c.evidenceRef ?? [], flags: c.flags })),
  };
}

export async function openDraftArticles(q: URLSearchParams) {
  const db = await getDb();
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const rows = rowsOf<{ article_id: string }>(await db.execute(sql`select distinct article_id from seo_drafts where status = 'ready_for_review' and coalesce(kind, 'optimize') = 'optimize' limit ${limit}`));
  return { articleIds: rows.map((r) => r.article_id) };
}

// --- Dashboard read models (admin MCP) ---------------------------------------------------------------------------

const RANGE: Record<string, string> = { "7d": "7", "28d": "28", "90d": "90", "16m": "90" };
const VIEW: Record<string, string> = { striking: "striking", low_ctr: "low_ctr", rising: "rising", lost: "lost", cannibalization: "cannibalization", gaps: "gaps" };

/** Period-over-period breakdown for one page or one query, by query/page, device and country (evidence rows). */
async function trafficChange(q: URLSearchParams) {
  const db = await getDb();
  const days = Number(RANGE[q.get("period") ?? "28d"] ?? 28);
  const [m] = rowsOf<{ d: string | null }>(await db.execute(sql`select max(date)::text as d from seo_gsc_query_daily where search_type = 'web'`));
  if (!m?.d) return { source: "Google Search Console (web)", note: "No Search Console data synced yet.", breakdown: {} };
  const end = m.d;
  const start = addDays(end, -(days - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  const page = q.get("page");
  const query = q.get("query");
  if (!page && !query) throw new CallbackError("Give a page or a query.", 400, "invalid");
  const where = page ? sql`page = ${`${siteOrigin().origin}${page}`}` : sql`query = ${query!.slice(0, 200)}`;
  const by = async (dim: "query" | "page" | "device" | "country") =>
    rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select ${sql.raw(dim)} as key,
          sum(clicks) filter (where date between ${start} and ${end})::float8 as clicks,
          sum(clicks) filter (where date between ${prevStart} and ${prevEnd})::float8 as prev_clicks,
          sum(impressions) filter (where date between ${start} and ${end})::float8 as impressions,
          sum(impressions) filter (where date between ${prevStart} and ${prevEnd})::float8 as prev_impressions,
          (sum(position * impressions) filter (where date between ${start} and ${end})) / nullif(sum(impressions) filter (where date between ${start} and ${end}), 0) as position,
          (sum(position * impressions) filter (where date between ${prevStart} and ${prevEnd})) / nullif(sum(impressions) filter (where date between ${prevStart} and ${prevEnd}), 0) as prev_position
        from seo_gsc_query_daily where search_type = 'web' and ${where} and date between ${prevStart} and ${end}
        group by 1 order by abs(coalesce(sum(clicks) filter (where date between ${start} and ${end}), 0) - coalesce(sum(clicks) filter (where date between ${prevStart} and ${prevEnd}), 0)) desc limit 15`),
    ).map((r) => ({ key: String(r.key), clicks: Number(r.clicks ?? 0), prevClicks: Number(r.prev_clicks ?? 0), deltaClicks: Number(r.clicks ?? 0) - Number(r.prev_clicks ?? 0), impressions: Number(r.impressions ?? 0), prevImpressions: Number(r.prev_impressions ?? 0), position: r.position === null ? null : Number(Number(r.position).toFixed(1)), prevPosition: r.prev_position === null ? null : Number(Number(r.prev_position).toFixed(1)) }));
  const { safeQueries } = await import("../seo-intel/llm");
  const byQuery = page ? await by("query") : await by("page");
  const keep = new Set(safeQueries(byQuery.map((r) => r.key)));
  return {
    source: "Google Search Console (web), aggregated",
    subject: page ? { page } : { query },
    period: { start, end, prevStart, prevEnd },
    breakdown: { [page ? "byQuery" : "byPage"]: page ? byQuery.filter((r) => keep.has(r.key)) : byQuery, byDevice: await by("device"), byCountry: await by("country") },
  };
}

/** GET /data/{name} — the dashboard's own read models for the admin MCP tools. */
export async function data(name: string, q: URLSearchParams) {
  const db = await getDb();
  switch (name) {
    case "overview": {
      const o = await overview(parseFilters({ range: RANGE[q.get("period") ?? "28d"] ?? "28" }));
      return { source: "Google Search Console (web) and GA4", status: o.status, period: o.gscPeriod, ga4Period: o.ga4Period, kpis: o.kpis };
    }
    case "traffic-change":
      return trafficChange(q);
    case "keywords": {
      const view = VIEW[q.get("view") ?? "striking"] ?? "striking";
      const p = parseKwParams({ view, q: q.get("q") ?? undefined, brand: q.get("brand") === "yes" ? "brand" : q.get("brand") === "no" ? "non_brand" : undefined, intent: q.get("intent") ?? undefined, imprMin: q.get("min_impressions") ?? undefined, limit: q.get("limit") ?? "25", offset: q.get("offset") ?? "0" });
      const t = await keywordTable(p);
      const { safeQueries } = await import("../seo-intel/llm");
      const keep = new Set(safeQueries(t.rows.map((r) => r.query)));
      return { view, source: "Google Search Console (web)", period: t.period, total: t.total, rows: t.rows.filter((r) => keep.has(r.query)), notes: "Click gap = impressions × (expected − actual CTR), an estimate from the site's own CTR curve." };
    }
    case "page-report": {
      const m = /^\/(blog|news|projects)\/([a-z0-9-]{1,120})$/.exec(q.get("path") ?? "");
      if (!m) throw new CallbackError("Invalid path.", 400, "invalid");
      const [p] = rowsOf<{ id: string }>(await db.execute(sql`select id from post where collection = ${m[1]} and slug = ${m[2]} and status = 'published' and deleted_at is null`));
      if (!p) throw new CallbackError("Article not found.", 404, "not_found");
      const a = await articlePanel(p.id);
      if (!a) throw new CallbackError("Article not found.", 404, "not_found");
      const article = Object.fromEntries(Object.entries(a.article).filter(([k]) => k !== "body")); // the body is not needed here
      return { article, period: a.period, gsc: a.gsc, ga4: a.ga4, queries: a.queries.slice(0, 25), audit: a.audit, recommendations: a.recommendations.slice(0, 20) };
    }
    case "audit-issues": {
      const s = await latestScan({ severity: q.get("severity") ?? undefined, check: q.get("check") ?? undefined, limit: Math.min(50, Number(q.get("limit") ?? 25) || 25), offset: Math.max(0, Number(q.get("offset") ?? 0) || 0) });
      return s ?? { scan: null, issues: [], total: 0, note: "No technical audit has run yet." };
    }
    case "llm-usage": {
      const days = { day: 1, week: 7, month: 31 }[q.get("period") ?? "month"] ?? 31;
      const rows = rowsOf<Record<string, unknown>>(
        await db.execute(sql`
          select purpose, model, count(*)::int as calls, sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)::float8 as tokens, sum(cost_usd)::float8 as cost_usd
          from seo_llm_usage where at > now() - make_interval(days => ${days}) group by 1, 2 order by cost_usd desc`),
      );
      return { period: q.get("period") ?? "month", rows: rows.map((r) => ({ purpose: String(r.purpose), model: String(r.model), calls: Number(r.calls), tokens: Number(r.tokens), costUsd: Number(Number(r.cost_usd).toFixed(4)) })) };
    }
    default:
      throw new CallbackError("Unknown data view.", 404, "not_found");
  }
}

/** GET /articles/topics — categories with published article counts and their hub URLs. */
export async function topics() {
  const db = await getDb();
  const rows = rowsOf<{ slug: string; label: string; n: number }>(
    await db.execute(sql`select c.slug, c.label, count(p.id)::int as n from category c left join post p on p.category = c.slug and p.status = 'published' and p.deleted_at is null and p.noindex = false group by c.slug, c.label, c.sort order by c.sort, c.label`),
  );
  return { topics: rows.filter((r) => Number(r.n) > 0).map((r) => ({ name: r.label, slug: r.slug, count: Number(r.n), path: `/category/${r.slug}` })) };
}

// --- Reports (report_flow) ---------------------------------------------------------------------------------------

export async function reportGenerate(body: unknown) {
  const b = parse(z.object({ period: z.enum(["weekly", "monthly"]) }), body);
  const r = await generateReport(b.period, "schedule", new Date(), { notify: false });
  return { id: r.id, report: r.report };
}

export async function reportNarrative(id: string, body: unknown) {
  const b = parse(z.object({ narrative: z.string().max(5000), check: z.record(z.string(), z.unknown()) }), body);
  if (b.check.ok !== true) throw new CallbackError("Only a narrative that passed the number check is stored.", 409, "check_failed");
  return storeReportNarrative(uuid(id, "report id"), b.narrative, b.check);
}

export async function reportPdf(id: string, body: unknown) {
  const b = parse(z.object({ pdf: z.string().max(14_000_000) }), body);
  try {
    return await storeReportPdf(uuid(id, "report id"), Buffer.from(b.pdf, "base64"));
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "not a PDF" || msg === "PDF too large" || msg === "report not found") throw new CallbackError(msg, msg === "report not found" ? 404 : 400, "invalid");
    throw new CallbackError("Could not store the PDF in R2 (is storage configured?).", 503, "storage");
  }
}

export async function reportNotify(id: string) {
  return notifyReport(uuid(id, "report id"));
}

export async function clusterGaps() {
  return { clustered: await clusterAskGaps() };
}
