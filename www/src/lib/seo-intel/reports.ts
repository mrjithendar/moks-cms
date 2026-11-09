import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "../log";
import { change } from "./queries";
import { getSeoSettings } from "./settings";
import { addDays } from "./sqlutil";
import { siteOrigin } from "./urls";

/**
 * Weekly (last full Monday–Sunday) and monthly (last full calendar month) SEO reports, compared with the previous
 * equal period. Built only from synced data and recorded decisions; nothing is estimated. Viewable in the
 * dashboard, exportable as CSV and as a printable page (browser "Save as PDF"). Email goes through the site's
 * notification service (sendMail) only when it is enabled AND recipients are configured (off by default).
 */
export type PeriodType = "weekly" | "monthly";

export function reportPeriod(type: PeriodType, now = new Date()): { start: string; end: string; prevStart: string; prevEnd: string } {
  const today = now.toISOString().slice(0, 10);
  if (type === "weekly") {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    const start = addDays(today, -dow - 7);
    return { start, end: addDays(start, 6), prevStart: addDays(start, -7), prevEnd: addDays(start, -1) };
  }
  const first = `${today.slice(0, 7)}-01`;
  const end = addDays(first, -1);
  const start = `${end.slice(0, 7)}-01`;
  const prevEnd = addDays(start, -1);
  return { start, end, prevStart: `${prevEnd.slice(0, 7)}-01`, prevEnd };
}

const q = async <T>(db: Db, query: ReturnType<typeof sql>) => rowsOf<T>(await db.execute(query));

async function gsc(db: Db, start: string, end: string) {
  const [r] = await q<Record<string, unknown>>(db, sql`
    select sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
      sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position,
      count(*)::int as days
    from seo_gsc_daily_totals where search_type = 'web' and date between ${start} and ${end}`);
  const clicks = Number(r?.clicks ?? 0);
  const impressions = Number(r?.impressions ?? 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: r?.position === null || r?.position === undefined ? null : Number(r.position), daysWithData: Number(r?.days ?? 0) };
}

async function ga4(db: Db, start: string, end: string) {
  const [r] = await q<Record<string, unknown>>(db, sql`
    select sum(sessions)::float8 as sessions, sum(sessions) filter (where channel_group = 'Organic Search')::float8 as organic,
      sum(engaged_sessions) filter (where channel_group = 'Organic Search')::float8 as engaged, count(distinct date)::int as days
    from seo_ga4_page_daily where date between ${start} and ${end}`);
  return { sessions: Number(r?.sessions ?? 0), organicSessions: Number(r?.organic ?? 0), engagedOrganicSessions: Number(r?.engaged ?? 0), daysWithData: Number(r?.days ?? 0) };
}

export async function buildReport(type: PeriodType, now = new Date()) {
  const db = await getDb();
  const p = reportPeriod(type, now);
  const [cur, prev, gaCur, gaPrev] = await Promise.all([gsc(db, p.start, p.end), gsc(db, p.prevStart, p.prevEnd), ga4(db, p.start, p.end), ga4(db, p.prevStart, p.prevEnd)]);
  const pages = await q<Record<string, unknown>>(db, sql`
    with c as (select page, sum(clicks)::float8 as clicks from seo_gsc_page_daily where search_type = 'web' and date between ${p.start} and ${p.end} group by page),
    pr as (select page, sum(clicks)::float8 as clicks from seo_gsc_page_daily where search_type = 'web' and date between ${p.prevStart} and ${p.prevEnd} group by page)
    select coalesce(c.page, pr.page) as page, coalesce(c.clicks, 0) as clicks, coalesce(pr.clicks, 0) as prev, post.title
    from c full outer join pr on pr.page = c.page left join seo_url_map m on m.url = coalesce(c.page, pr.page) left join post on post.id = m.article_id`);
  const rows = pages.map((r) => ({ page: String(r.page), title: (r.title as string | null) ?? null, clicks: Number(r.clicks), previous: Number(r.prev), delta: Number(r.clicks) - Number(r.prev) }));
  const recs = await q<Record<string, unknown>>(db, sql`select id, category, priority_band, problem, proposed_action, url, review_status, implementation_status, created_at, implemented_at, baseline_metrics, post_metrics_28d, post_metrics_56d from seo_recommendations`);
  const inPeriod = (d: unknown) => d && String(new Date(String(d)).toISOString()).slice(0, 10) >= p.start && new Date(String(d)).toISOString().slice(0, 10) <= p.end;
  const [scan] = await q<Record<string, unknown>>(db, sql`select id, started_at, pages_crawled, summary from seo_technical_scans where status = 'succeeded' order by started_at desc limit 1`);
  const techTop = scan ? await q<{ check_key: string; severity: string; n: number }>(db, sql`select check_key, severity, count(*)::int as n from seo_technical_issues where scan_id = ${scan.id} and severity in ('error', 'warning') group by 1, 2 order by 3 desc limit 10`) : [];
  const accepted = await q<{ n: number }>(db, sql`select count(*)::int as n from seo_article_optimizations where status = 'accepted' and decided_at::date between ${p.start} and ${p.end}`);
  const shortRec = (r: Record<string, unknown>) => ({ id: String(r.id), category: String(r.category), band: String(r.priority_band), problem: String(r.problem), action: String(r.proposed_action), url: (r.url as string | null) ?? null });
  return {
    type,
    period: p,
    generatedAt: now.toISOString(),
    sources: { gsc: "Google Search Console, web search, site totals", ga4: "Google Analytics 4 landing pages (sessions are not clicks)" },
    organic: {
      gsc: { current: cur, previous: prev, change: { clicks: change(cur.clicks, prev.clicks), impressions: change(cur.impressions, prev.impressions), ctr: change(cur.ctr, prev.ctr), position: change(cur.position, prev.position) } },
      ga4: { current: gaCur, previous: gaPrev, change: { organicSessions: change(gaCur.organicSessions, gaPrev.organicSessions) } },
      dataComplete: cur.daysWithData >= (type === "weekly" ? 7 : 28),
    },
    bestArticles: [...rows].sort((a, b) => b.clicks - a.clicks).slice(0, 10),
    growing: rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10),
    declining: rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10),
    newOpportunities: recs.filter((r) => inPeriod(r.created_at) && ["low_ctr", "striking_distance", "content_gap"].includes(String(r.category))).slice(0, 10).map(shortRec),
    decayAlerts: recs.filter((r) => r.category === "content_decay" && r.review_status === "pending").slice(0, 10).map(shortRec),
    technical: scan ? { scannedAt: new Date(String(scan.started_at)).toISOString(), pagesCrawled: Number(scan.pages_crawled), summary: scan.summary, top: techTop.map((t) => ({ check: t.check_key, severity: t.severity, count: Number(t.n) })) } : null,
    recommendations: {
      pending: recs.filter((r) => r.review_status === "pending").length,
      approved: recs.filter((r) => r.review_status === "approved").length,
      rejected: recs.filter((r) => r.review_status === "rejected").length,
      implementedInPeriod: recs.filter((r) => inPeriod(r.implemented_at)).length,
      proposalsAcceptedInPeriod: Number(accepted[0]?.n ?? 0),
    },
    completedOptimizations: recs.filter((r) => r.implementation_status === "implemented").slice(0, 20).map((r) => ({ ...shortRec(r), implementedAt: r.implemented_at ? new Date(String(r.implemented_at)).toISOString() : null, baseline: r.baseline_metrics ?? null, after28: r.post_metrics_28d ?? null, after56: r.post_metrics_56d ?? null })),
    nextActions: recs.filter((r) => r.review_status !== "rejected" && r.implementation_status !== "implemented" && r.priority_band === "high").slice(0, 5).map(shortRec),
  };
}

export type Report = Awaited<ReturnType<typeof buildReport>>;

export async function generateReport(type: PeriodType, trigger: "schedule" | "manual", now = new Date(), deps: { send?: (to: string, subject: string, text: string) => Promise<boolean>; mailReady?: () => Promise<boolean> } = {}) {
  const db = await getDb();
  const report = await buildReport(type, now);
  const [row] = await q<{ id: string; emailed_at: string | null }>(db, sql`
    insert into seo_reports (period_type, period_start, period_end, payload, trigger) values (${type}, ${report.period.start}, ${report.period.end}, ${JSON.stringify(report)}::jsonb, ${trigger})
    on conflict (period_type, period_start) do update set payload = excluded.payload, generated_at = now(), trigger = excluded.trigger
    returning id, emailed_at`);
  const s = await getSeoSettings();
  let emailed = 0;
  if (s.reports.emailEnabled && s.reports.recipients.length && !row!.emailed_at) {
    const mail = await import("../mail");
    const ready = await (deps.mailReady ?? mail.mailConfigured)();
    if (ready) {
      const send = deps.send ?? mail.sendMail;
      const text = reportText(report, `${siteOrigin().origin}/admin/seo/reports/${row!.id}`);
      for (const to of s.reports.recipients) if (await send(to, `SEO ${type} report ${report.period.start} – ${report.period.end}`, text)) emailed++;
      if (emailed) await db.execute(sql`update seo_reports set emailed_at = now() where id = ${row!.id}`);
    } else log.warn("seo report email skipped: email is not configured", { operation: "seo_report_email", outcome: "skipped" });
  }
  return { id: row!.id, emailed };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

export function reportText(r: Report, link: string): string {
  const g = r.organic.gsc;
  const lines = [
    `SEO ${r.type} report, ${r.period.start} – ${r.period.end} (vs ${r.period.prevStart} – ${r.period.prevEnd})`,
    r.organic.dataComplete ? "" : "Note: Search Console data for this period is incomplete.",
    "",
    `Search Console: ${g.current.clicks} clicks (${pct(g.change.clicks)}), ${g.current.impressions} impressions (${pct(g.change.impressions)}), avg position ${g.current.position?.toFixed(1) ?? "n/a"}.`,
    `GA4: ${r.organic.ga4.current.organicSessions} organic sessions (${pct(r.organic.ga4.change.organicSessions)}).`,
    "",
    "Top pages:",
    ...r.bestArticles.slice(0, 5).map((a) => `  - ${a.title ?? a.page}: ${a.clicks} clicks`),
    "",
    `Recommendations: ${r.recommendations.pending} pending, ${r.recommendations.implementedInPeriod} implemented this period.`,
    r.decayAlerts.length ? `Decay alerts: ${r.decayAlerts.length}.` : "",
    r.technical ? `Technical issues (latest scan): ${r.technical.top.map((t) => `${t.check} ${t.count}`).join(", ") || "none"}.` : "",
    "",
    "Next actions:",
    ...(r.nextActions.length ? r.nextActions.map((a) => `  - [${a.category}] ${a.action}`) : ["  - none"]),
    "",
    `Full report: ${link}`,
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/** CSV with one section per block (spreadsheet-safe: cells starting with = + - @ are prefixed with '). */
export function reportCsv(r: Report): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out: unknown[][] = [
    ["section", "key", "value", "previous", "change"],
    ["period", r.type, `${r.period.start}..${r.period.end}`, `${r.period.prevStart}..${r.period.prevEnd}`, ""],
    ["gsc", "clicks", r.organic.gsc.current.clicks, r.organic.gsc.previous.clicks, r.organic.gsc.change.clicks],
    ["gsc", "impressions", r.organic.gsc.current.impressions, r.organic.gsc.previous.impressions, r.organic.gsc.change.impressions],
    ["gsc", "ctr", r.organic.gsc.current.ctr, r.organic.gsc.previous.ctr, r.organic.gsc.change.ctr],
    ["gsc", "position", r.organic.gsc.current.position, r.organic.gsc.previous.position, r.organic.gsc.change.position],
    ["ga4", "organic_sessions", r.organic.ga4.current.organicSessions, r.organic.ga4.previous.organicSessions, r.organic.ga4.change.organicSessions],
    ...r.bestArticles.map((a) => ["best_article", a.title ?? a.page, a.clicks, a.previous, a.delta]),
    ...r.declining.map((a) => ["declining", a.title ?? a.page, a.clicks, a.previous, a.delta]),
    ...r.newOpportunities.map((o) => ["new_opportunity", o.category, o.problem, o.url, o.band]),
    ...r.decayAlerts.map((o) => ["decay_alert", o.url, o.problem, "", o.band]),
    ...(r.technical?.top ?? []).map((t) => ["technical", t.check, t.count, "", t.severity]),
    ...r.completedOptimizations.map((o) => ["completed", o.category, o.url, o.baseline, o.after28]),
    ...r.nextActions.map((o) => ["next_action", o.category, o.action, o.url, o.band]),
  ];
  return out.map((row) => row.map(cell).join(",")).join("\r\n");
}

export async function listReports(limit = 50) {
  const db = await getDb();
  return (await q<Record<string, unknown>>(db, sql`select id, period_type, period_start::text, period_end::text, generated_at, emailed_at, trigger from seo_reports order by period_start desc, period_type limit ${limit}`)).map((r) => ({
    id: String(r.id),
    type: String(r.period_type),
    start: String(r.period_start),
    end: String(r.period_end),
    generatedAt: new Date(String(r.generated_at)).toISOString(),
    emailedAt: r.emailed_at ? new Date(String(r.emailed_at)).toISOString() : null,
    trigger: String(r.trigger),
  }));
}

export async function getReport(id: string): Promise<Report | null> {
  const db = await getDb();
  const [r] = await q<{ payload: Report }>(db, sql`select payload from seo_reports where id = ${id}`);
  return r?.payload ?? null;
}
