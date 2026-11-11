import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { readServiceAccount } from "./google/auth";
import { getSeoSettings, SEARCH_TYPES, type SeoSettings } from "./settings";
import { addDays, daysBetween, isDay } from "./sqlutil";

/**
 * Read models for the search/analytics admin pages. Every number comes from the synced tables; nothing is estimated or invented.
 * Search Console site totals come from seo_gsc_daily_totals (the source of truth); when a page/device/country/
 * category filter is applied they come from the page-level table and are labelled so. Query tables are partial
 * coverage (anonymised queries are excluded by Google) and are labelled so. GA4 sessions are never mixed with
 * GSC clicks.
 */

// --- Filters and periods ----------------------------------------------------------------------------------------

export const RANGES = ["7", "28", "90", "custom"] as const;
const text = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);

export const filterSchema = z.object({
  range: z.enum(RANGES).catch("28"),
  start: z.string().optional().refine((v) => v === undefined || v === "" || isDay(v)).transform((v) => v || undefined).catch(undefined),
  end: z.string().optional().refine((v) => v === undefined || v === "" || isDay(v)).transform((v) => v || undefined).catch(undefined),
  page: text(300).catch(undefined),
  category: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional().catch(undefined),
  query: text(200).catch(undefined),
  device: z.enum(["desktop", "mobile", "tablet"]).optional().catch(undefined),
  country: z.string().trim().max(60).regex(/^[A-Za-z ()'.,-]*$/).optional().transform((v) => v || undefined).catch(undefined),
  searchType: z.enum(SEARCH_TYPES).catch("web"),
  sort: z.enum(["clicks", "impressions", "ctr", "position", "sessions", "change"]).catch("clicks"),
  limit: z.coerce.number().int().min(1).max(100).catch(25),
  offset: z.coerce.number().int().min(0).max(100_000).catch(0),
});
export type Filters = z.output<typeof filterSchema>;

export function parseFilters(input: Record<string, string | string[] | undefined> | URLSearchParams): Filters {
  const obj = input instanceof URLSearchParams ? Object.fromEntries(input) : Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return filterSchema.parse(obj);
}

export type Period = { start: string; end: string; days: number; prevStart: string; prevEnd: string };

/** The selected period ending at the latest date with data (Search Console lags 2–3 days), and the equal period before it. */
export function periodFor(f: Filters, latest: string | null, today: string): Period {
  let start: string;
  let end: string;
  if (f.range === "custom" && f.start && f.end && f.start <= f.end) {
    start = f.start;
    end = f.end;
  } else {
    end = latest && latest < today ? latest : addDays(today, -1);
    start = addDays(end, -(Number(f.range === "custom" ? "28" : f.range) - 1));
  }
  const days = daysBetween(start, end) + 1;
  return { start, end, days, prevEnd: addDays(start, -1), prevStart: addDays(start, -days) };
}

const q = async <T>(db: Db, query: SQL) => rowsOf<T>(await db.execute(query));
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export const change = (cur: number | null, prev: number | null) => (cur === null || prev === null || prev === 0 ? null : (cur - prev) / prev);

// --- Source status (disconnected / stale / error) ---------------------------------------------------------------

export type SourceState = "disconnected" | "never_synced" | "error" | "stale" | "ok";
export type SourceStatus = { source: "gsc" | "ga4"; state: SourceState; message: string; lastSuccessAt: string | null; lastError: string | null; latestDate: string | null };

export async function sourceStatus(db: Db, s: SeoSettings, source: "gsc" | "ga4", now = new Date(), env: Record<string, string | undefined> = process.env): Promise<SourceStatus> {
  const property = source === "gsc" ? s.google.gscProperty : s.google.ga4PropertyId;
  let creds = false;
  try {
    creds = readServiceAccount(env) !== null;
  } catch {
    creds = false;
  }
  const jobType = source === "gsc" ? "gsc_%" : "ga4_%";
  const [last] = await q<{ finished_at: string | null }>(db, sql`select finished_at from seo_sync_jobs where job_type like ${jobType} and status in ('succeeded', 'partial') order by finished_at desc nulls last limit 1`);
  const [integ] = await q<{ status: string; last_error: string | null }>(db, sql`select status, last_error from seo_integrations where provider = ${source}`);
  const table = source === "gsc" ? sql`seo_gsc_daily_totals` : sql`seo_ga4_page_daily`;
  const [latest] = await q<{ d: string | null }>(db, sql`select max(date)::text as d from ${table}`);
  const lastSuccessAt = last?.finished_at ? new Date(last.finished_at).toISOString() : null;
  const base = { source, lastSuccessAt, lastError: integ?.last_error ?? null, latestDate: latest?.d ?? null };
  const label = source === "gsc" ? "Search Console" : "Google Analytics 4";
  if (!creds || !property) return { ...base, state: "disconnected", message: `${label} is not connected: ${!creds ? "service-account credentials are not configured" : "no property id is set"}. See Integrations.` };
  if (integ?.status === "auth_error" || integ?.status === "error") return { ...base, state: "error", message: `${label}: the last sync failed (${integ.status === "auth_error" ? "access denied" : "API error"}).` };
  if (!lastSuccessAt) return { ...base, state: "never_synced", message: `${label} is configured but has not synced yet. Run a sync or backfill from Sync history.` };
  const ageH = (now.getTime() - new Date(lastSuccessAt).getTime()) / 3_600_000;
  if (ageH > s.sync.staleAfterHours) return { ...base, state: "stale", message: `${label} data is stale: last successful sync ${Math.round(ageH)} hours ago.` };
  return { ...base, state: "ok", message: `${label} last synced ${lastSuccessAt}.` };
}

// --- Filter SQL -------------------------------------------------------------------------------------------------

function gscWhere(f: Filters, alias = ""): SQL {
  const c = (col: string) => sql.raw(alias ? `${alias}.${col}` : col);
  const parts: SQL[] = [sql`${c("search_type")} = ${f.searchType}`];
  if (f.page) parts.push(sql`${c("page")} ilike ${`%${f.page.replace(/[%_\\]/g, "\\$&")}%`}`);
  if (f.device) parts.push(sql`${c("device")} = ${f.device}`);
  if (f.country) parts.push(sql`${c("country")} = ${f.country.toLowerCase()}`);
  if (f.category) parts.push(sql`${c("page")} in (select m.url from seo_url_map m join post p on p.id = m.article_id where p.category = ${f.category})`);
  return sql.join(parts, sql` and `);
}

function ga4Where(f: Filters): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.page) parts.push(sql`landing_page ilike ${`%${f.page.replace(/[%_\\]/g, "\\$&")}%`}`);
  if (f.device) parts.push(sql`device = ${f.device}`);
  if (f.country) parts.push(sql`country = ${f.country}`);
  if (f.category) parts.push(sql`landing_page in (select m.url from seo_url_map m join post p on p.id = m.article_id where p.category = ${f.category})`);
  return sql.join(parts, sql` and `);
}

const pageFiltered = (f: Filters) => Boolean(f.page || f.device || f.country || f.category);

type Totals = { clicks: number; impressions: number; ctr: number | null; position: number | null };

async function gscTotals(db: Db, f: Filters, start: string, end: string): Promise<Totals> {
  const [r] = pageFiltered(f)
    ? await q<Record<string, unknown>>(db, sql`
        select sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
          sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
        from seo_gsc_page_daily where date between ${start} and ${end} and ${gscWhere(f)}`)
    : await q<Record<string, unknown>>(db, sql`
        select sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
          sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
        from seo_gsc_daily_totals where date between ${start} and ${end} and search_type = ${f.searchType}`);
  const clicks = Number(r?.clicks ?? 0);
  const impressions = Number(r?.impressions ?? 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: n(r?.position) };
}

async function ga4Totals(db: Db, f: Filters, start: string, end: string) {
  const [r] = await q<Record<string, unknown>>(db, sql`
    select sum(sessions) filter (where channel_group = 'Organic Search')::float8 as organic_sessions,
      sum(engaged_sessions) filter (where channel_group = 'Organic Search')::float8 as organic_engaged,
      sum(sessions)::float8 as sessions, sum(active_users)::float8 as users
    from seo_ga4_page_daily where date between ${start} and ${end} and ${ga4Where(f)}`);
  return { organicSessions: Number(r?.organic_sessions ?? 0), organicEngaged: Number(r?.organic_engaged ?? 0), sessions: Number(r?.sessions ?? 0), users: Number(r?.users ?? 0) };
}

async function latestDate(db: Db, table: "seo_gsc_daily_totals" | "seo_ga4_page_daily"): Promise<string | null> {
  const [r] = await q<{ d: string | null }>(db, sql`select max(date)::text as d from ${sql.raw(table)}`);
  return r?.d ?? null;
}

// --- Overview ---------------------------------------------------------------------------------------------------

export type Kpi = { key: string; label: string; value: number | null; previous: number | null; change: number | null; format: "int" | "pct" | "pos"; source: string; period: string; lastSync: string | null; note?: string; lowerIsBetter?: boolean };

export async function overview(f: Filters, now = new Date()) {
  const db = await getDb();
  const s = await getSeoSettings();
  const today = now.toISOString().slice(0, 10);
  const [gsc, ga4] = await Promise.all([sourceStatus(db, s, "gsc", now), sourceStatus(db, s, "ga4", now)]);
  const gp = periodFor(f, await latestDate(db, "seo_gsc_daily_totals"), today);
  const ap = periodFor(f, await latestDate(db, "seo_ga4_page_daily"), today);
  const [cur, prev, gaCur, gaPrev] = await Promise.all([gscTotals(db, f, gp.start, gp.end), gscTotals(db, f, gp.prevStart, gp.prevEnd), ga4Totals(db, f, ap.start, ap.end), ga4Totals(db, f, ap.prevStart, ap.prevEnd)]);
  const [counts] = await q<Record<string, unknown>>(db, sql`
    select
      (select count(*) from seo_recommendations where review_status = 'pending')::int as pending,
      (select count(*) from seo_recommendations where review_status in ('pending', 'approved') and implementation_status <> 'implemented' and category in ('low_ctr', 'striking_distance', 'content_gap', 'content_decay'))::int as opportunities,
      (select count(*) from seo_technical_issues where severity in ('error', 'warning') and scan_id = (select id from seo_technical_scans where status = 'succeeded' order by started_at desc limit 1))::int as issues`);
  const gLabel = `${gp.start} – ${gp.end}`;
  const aLabel = `${ap.start} – ${ap.end}`;
  const gNote = pageFiltered(f) ? "Filtered: summed from page-level rows" : undefined;
  const kpis: Kpi[] = [
    { key: "clicks", label: "Organic clicks", value: cur.clicks, previous: prev.clicks, change: change(cur.clicks, prev.clicks), format: "int", source: "Search Console", period: gLabel, lastSync: gsc.lastSuccessAt, note: gNote },
    { key: "impressions", label: "Impressions", value: cur.impressions, previous: prev.impressions, change: change(cur.impressions, prev.impressions), format: "int", source: "Search Console", period: gLabel, lastSync: gsc.lastSuccessAt, note: gNote },
    { key: "ctr", label: "CTR", value: cur.ctr, previous: prev.ctr, change: change(cur.ctr, prev.ctr), format: "pct", source: "Search Console", period: gLabel, lastSync: gsc.lastSuccessAt, note: gNote },
    { key: "position", label: "Average position", value: cur.position, previous: prev.position, change: change(cur.position, prev.position), format: "pos", source: "Search Console", period: gLabel, lastSync: gsc.lastSuccessAt, lowerIsBetter: true, note: gNote },
    { key: "organicSessions", label: "Organic sessions", value: gaCur.organicSessions, previous: gaPrev.organicSessions, change: change(gaCur.organicSessions, gaPrev.organicSessions), format: "int", source: "GA4 (Organic Search channel)", period: aLabel, lastSync: ga4.lastSuccessAt },
    { key: "engagedSessions", label: "Engaged organic sessions", value: gaCur.organicEngaged, previous: gaPrev.organicEngaged, change: change(gaCur.organicEngaged, gaPrev.organicEngaged), format: "int", source: "GA4 (Organic Search channel)", period: aLabel, lastSync: ga4.lastSuccessAt },
    { key: "opportunities", label: "Open opportunities", value: Number(counts?.opportunities ?? 0), previous: null, change: null, format: "int", source: "Recommendation engine", period: "current", lastSync: null },
    { key: "issues", label: "SEO issues", value: Number(counts?.issues ?? 0), previous: null, change: null, format: "int", source: "Technical audit (latest scan)", period: "current", lastSync: null },
    { key: "pending", label: "Pending recommendations", value: Number(counts?.pending ?? 0), previous: null, change: null, format: "int", source: "Recommendation engine", period: "current", lastSync: null },
  ];
  const trend = await q<{ date: string; clicks: number; impressions: number }>(db, sql`
    select date::text as date, clicks::float8 as clicks, impressions::float8 as impressions from seo_gsc_daily_totals
    where search_type = ${f.searchType} and date between ${gp.start} and ${gp.end} order by date`);
  return { status: { gsc, ga4 }, gscPeriod: gp, ga4Period: ap, kpis, trend: trend.map((t) => ({ date: t.date, clicks: Number(t.clicks), impressions: Number(t.impressions) })) };
}

// --- Search performance -----------------------------------------------------------------------------------------

type PageRow = { page: string; clicks: number; impressions: number; ctr: number; position: number | null; prev_clicks: number | null; title: string | null; article_id: string | null };

export async function searchPerformance(f: Filters, now = new Date()) {
  const db = await getDb();
  const s = await getSeoSettings();
  const status = await sourceStatus(db, s, "gsc", now);
  const p = periodFor(f, await latestDate(db, "seo_gsc_daily_totals"), now.toISOString().slice(0, 10));
  const where = gscWhere(f);
  const pageAgg = (start: string, end: string) => sql`
    select page, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
      sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
    from seo_gsc_page_daily where date between ${start} and ${end} and ${where} group by page`;
  const pages = await q<PageRow>(db, sql`
    with c as (${pageAgg(p.start, p.end)}), pr as (${pageAgg(p.prevStart, p.prevEnd)})
    select c.page, c.clicks, c.impressions, case when c.impressions > 0 then c.clicks / c.impressions else 0 end as ctr, c.position,
      pr.clicks as prev_clicks, post.title, m.article_id
    from c left join pr on pr.page = c.page left join seo_url_map m on m.url = c.page left join post on post.id = m.article_id
    order by c.clicks desc, c.impressions desc limit 500`);
  const lost = await q<PageRow>(db, sql`
    with c as (${pageAgg(p.start, p.end)}), pr as (${pageAgg(p.prevStart, p.prevEnd)})
    select pr.page, coalesce(c.clicks, 0) as clicks, coalesce(c.impressions, 0) as impressions, 0 as ctr, c.position, pr.clicks as prev_clicks, post.title, m.article_id
    from pr left join c on c.page = pr.page left join seo_url_map m on m.url = pr.page left join post on post.id = m.article_id
    where coalesce(c.clicks, 0) < pr.clicks order by (pr.clicks - coalesce(c.clicks, 0)) desc limit 10`);
  const norm = (r: PageRow) => ({ page: r.page, title: r.title, articleId: r.article_id, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.ctr), position: n(r.position), prevClicks: n(r.prev_clicks), delta: Number(r.clicks) - Number(r.prev_clicks ?? 0) });
  const pageRows = pages.map(norm);
  const gaining = [...pageRows].filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10);
  const losing = lost.map(norm).sort((a, b) => a.delta - b.delta).slice(0, 10);

  const qWhere = sql.join([gscWhere(f), ...(f.query ? [sql`query ilike ${`%${f.query.replace(/[%_\\]/g, "\\$&")}%`}`] : [])], sql` and `);
  const queries = await q<{ query: string; clicks: number; impressions: number; position: number | null }>(db, sql`
    select query, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
      sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
    from seo_gsc_query_daily where date between ${p.start} and ${p.end} and ${qWhere} group by query order by clicks desc, impressions desc limit 500`);
  const qRows = queries.map((r) => ({ query: r.query, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.impressions) ? Number(r.clicks) / Number(r.impressions) : 0, position: n(r.position) }));
  const t = s.thresholds;
  const lowCtr = qRows
    .filter((r) => r.impressions >= t.lowCtrMinImpressions && r.position !== null && r.ctr < expectedCtr(r.position) * t.lowCtrRatio && !t.brandTerms.some((b) => r.query.includes(b)))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);
  const striking = qRows.filter((r) => r.position !== null && r.position >= t.strikingPositionMin && r.position <= t.strikingPositionMax && r.impressions >= t.strikingMinImpressions).sort((a, b) => b.impressions - a.impressions).slice(0, 25);
  const split = async (col: "device" | "country") =>
    (await q<{ k: string; clicks: number; impressions: number }>(db, sql`select ${sql.raw(col)} as k, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions from seo_gsc_page_daily where date between ${p.start} and ${p.end} and ${where} group by 1 order by 2 desc limit 15`)).map((r) => ({ key: r.k, clicks: Number(r.clicks), impressions: Number(r.impressions) }));
  const trend = (await q<{ date: string; clicks: number; impressions: number; position: number | null }>(db, sql`select date::text as date, clicks::float8 as clicks, impressions::float8 as impressions, position from seo_gsc_daily_totals where search_type = ${f.searchType} and date between ${p.start} and ${p.end} order by date`)).map((r) => ({ date: r.date, clicks: Number(r.clicks), impressions: Number(r.impressions), position: n(r.position) }));
  return {
    status,
    period: p,
    trend,
    topPages: pageRows.slice(0, 25),
    topQueries: qRows.slice(0, 25),
    devices: await split("device"),
    countries: await split("country"),
    gaining,
    losing,
    lowCtr,
    striking,
    coverageNote: "Query rows exclude anonymised queries, so they add up to less than the site totals (partial coverage).",
  };
}

/**
 * Expected CTR by position band, used only as a *relative* yardstick for the low-CTR rule. A conservative curve
 * in line with published industry CTR studies; it is configurable through the low-CTR ratio and documented in
 * docs/seo/SCORING.md. It is never shown as a forecast.
 */
export function expectedCtr(position: number): number {
  if (position < 1.5) return 0.25;
  if (position < 2.5) return 0.15;
  if (position < 3.5) return 0.1;
  if (position < 5.5) return 0.06;
  if (position < 10.5) return 0.03;
  if (position < 20.5) return 0.01;
  return 0.005;
}

// --- Visitor analytics ------------------------------------------------------------------------------------------

export async function visitorAnalytics(f: Filters, now = new Date()) {
  const db = await getDb();
  const s = await getSeoSettings();
  const status = await sourceStatus(db, s, "ga4", now);
  const p = periodFor(f, await latestDate(db, "seo_ga4_page_daily"), now.toISOString().slice(0, 10));
  const where = ga4Where(f);
  const inPeriod = sql`date between ${p.start} and ${p.end} and ${where}`;
  const trend = (await q<Record<string, unknown>>(db, sql`
    select date::text as date, sum(active_users)::float8 as users, sum(sessions)::float8 as sessions,
      sum(sessions) filter (where channel_group = 'Organic Search')::float8 as organic
    from seo_ga4_page_daily where ${inPeriod} group by date order by date`)).map((r) => ({ date: String(r.date), users: Number(r.users ?? 0), sessions: Number(r.sessions ?? 0), organic: Number(r.organic ?? 0) }));
  const group = async (col: string, limit = 15) =>
    (await q<Record<string, unknown>>(db, sql`
      select ${sql.raw(col)} as k, sum(sessions)::float8 as sessions, sum(engaged_sessions)::float8 as engaged, sum(active_users)::float8 as users
      from seo_ga4_page_daily where ${inPeriod} group by 1 order by 2 desc limit ${limit}`)).map((r) => ({ key: String(r.k), sessions: Number(r.sessions), engaged: Number(r.engaged), users: Number(r.users), engagementRate: Number(r.sessions) ? Number(r.engaged) / Number(r.sessions) : 0 }));
  const landing = (await q<Record<string, unknown>>(db, sql`
    select g.landing_page, sum(g.sessions)::float8 as sessions, sum(g.engaged_sessions)::float8 as engaged, sum(g.user_engagement_duration)::float8 as duration,
      sum(g.screen_page_views)::float8 as views, sum(g.sessions) filter (where g.channel_group = 'Organic Search')::float8 as organic, post.title, m.article_id
    from seo_ga4_page_daily g left join seo_url_map m on m.url = g.landing_page left join post on post.id = m.article_id
    where g.date between ${p.start} and ${p.end} and ${where}
    group by g.landing_page, post.title, m.article_id order by sessions desc limit 50`)).map((r) => ({
    page: String(r.landing_page),
    title: (r.title as string | null) ?? null,
    articleId: (r.article_id as string | null) ?? null,
    sessions: Number(r.sessions),
    organic: Number(r.organic ?? 0),
    engagementRate: Number(r.sessions) ? Number(r.engaged) / Number(r.sessions) : 0,
    avgEngagementSeconds: Number(r.sessions) ? Number(r.duration) / Number(r.sessions) : 0,
    views: Number(r.views),
  }));
  return {
    status,
    period: p,
    trend,
    landing,
    articles: landing.filter((l) => l.articleId),
    channels: await group("channel_group"),
    devices: await group("device"),
    countries: await group("country"),
    newVsReturning: await group("new_vs_returning", 5),
    note: "GA4 sessions are visits measured on the site (consent-dependent); they are not Search Console clicks. Users summed across days/pages are an upper bound.",
  };
}

// --- Page intelligence / keywords -------------------------------------------------------------------------------

export async function pageIntelligence(f: Filters, now = new Date()) {
  const db = await getDb();
  const p = periodFor(f, await latestDate(db, "seo_gsc_daily_totals"), now.toISOString().slice(0, 10));
  const where = gscWhere(f);
  const order = { clicks: "clicks desc", impressions: "impressions desc", ctr: "ctr asc", position: "position asc nulls last", sessions: "sessions desc nulls last", change: "change asc nulls last" }[f.sort];
  const rows = await q<Record<string, unknown>>(db, sql`
    with c as (
      select page, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
        sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
      from seo_gsc_page_daily where date between ${p.start} and ${p.end} and ${where} group by page),
    pr as (select page, sum(clicks)::float8 as clicks from seo_gsc_page_daily where date between ${p.prevStart} and ${p.prevEnd} and ${where} group by page),
    a as (select landing_page, sum(sessions)::float8 as sessions, sum(engaged_sessions)::float8 as engaged from seo_ga4_page_daily where date between ${p.start} and ${p.end} group by landing_page),
    j as (
      select c.page, c.clicks, c.impressions, case when c.impressions > 0 then c.clicks / c.impressions else 0 end as ctr, c.position,
        pr.clicks as prev_clicks, case when pr.clicks > 0 then (c.clicks - pr.clicks) / pr.clicks end as change,
        a.sessions, case when a.sessions > 0 then a.engaged / a.sessions end as engagement_rate,
        post.id as article_id, post.title, post.category,
        (select count(*) from seo_recommendations r where r.url = c.page and r.review_status = 'pending')::int as open_recs
      from c left join pr on pr.page = c.page left join a on a.landing_page = c.page
      left join seo_url_map m on m.url = c.page left join post on post.id = m.article_id)
    select *, count(*) over ()::int as total from j order by ${sql.raw(order)} limit ${f.limit} offset ${f.offset}`);
  return {
    period: p,
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map((r) => ({
      page: String(r.page),
      title: (r.title as string | null) ?? null,
      articleId: (r.article_id as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      ctr: Number(r.ctr),
      position: n(r.position),
      prevClicks: n(r.prev_clicks),
      change: n(r.change),
      sessions: n(r.sessions),
      engagementRate: n(r.engagement_rate),
      openRecommendations: Number(r.open_recs ?? 0),
    })),
  };
}

export async function keywordOpportunities(f: Filters, now = new Date()) {
  const db = await getDb();
  const s = await getSeoSettings();
  const p = periodFor(f, await latestDate(db, "seo_gsc_daily_totals"), now.toISOString().slice(0, 10));
  const parts = [gscWhere(f), ...(f.query ? [sql`query ilike ${`%${f.query.replace(/[%_\\]/g, "\\$&")}%`}`] : [])];
  const order = { clicks: "clicks desc", impressions: "impressions desc", ctr: "ctr asc", position: "position asc nulls last", sessions: "impressions desc", change: "impressions desc" }[f.sort];
  const rows = await q<Record<string, unknown>>(db, sql`
    with c as (
      select query, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
        sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position,
        count(distinct page)::int as pages, (array_agg(page order by impressions desc))[1] as top_page
      from seo_gsc_query_daily where date between ${p.start} and ${p.end} and ${sql.join(parts, sql` and `)} group by query)
    select *, case when impressions > 0 then clicks / impressions else 0 end as ctr, count(*) over ()::int as total
    from c order by ${sql.raw(order)} limit ${f.limit} offset ${f.offset}`);
  const t = s.thresholds;
  return {
    period: p,
    total: Number(rows[0]?.total ?? 0),
    coverageNote: "Partial coverage: Search Console omits anonymised queries from query-level data.",
    rows: rows.map((r) => {
      const position = n(r.position);
      const impressions = Number(r.impressions);
      const ctr = Number(r.ctr);
      const query = String(r.query);
      const flags: string[] = [];
      if (position !== null && position >= t.strikingPositionMin && position <= t.strikingPositionMax && impressions >= t.strikingMinImpressions) flags.push("striking distance");
      if (position !== null && impressions >= t.lowCtrMinImpressions && ctr < expectedCtr(position) * t.lowCtrRatio && !t.brandTerms.some((b) => query.includes(b))) flags.push("low CTR for position");
      if (Number(r.pages) > 1) flags.push("several pages rank");
      return { query, clicks: Number(r.clicks), impressions, ctr, position, pages: Number(r.pages), topPage: String(r.top_page), flags };
    }),
  };
}

// --- Sync history -----------------------------------------------------------------------------------------------

export async function syncHistory(limit = 50, offset = 0, jobType?: string) {
  const db = await getDb();
  const filter = jobType && /^[a-z0-9_]{1,40}$/.test(jobType) ? sql`where job_type = ${jobType}` : sql``;
  const rows = await q<Record<string, unknown>>(db, sql`
    select id, job_type, trigger, window_start::text, window_end::text, status, started_at, finished_at, rows_written, api_requests, retries, error, error_code, correlation_id, actor, count(*) over ()::int as total
    from seo_sync_jobs ${filter} order by started_at desc limit ${Math.min(100, Math.max(1, limit))} offset ${Math.max(0, offset)}`);
  return {
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map((r) => ({
      id: String(r.id),
      jobType: String(r.job_type),
      trigger: String(r.trigger),
      window: r.window_start ? `${r.window_start} – ${r.window_end}` : null,
      status: String(r.status),
      startedAt: new Date(String(r.started_at)).toISOString(),
      finishedAt: r.finished_at ? new Date(String(r.finished_at)).toISOString() : null,
      rows: Number(r.rows_written),
      apiRequests: Number(r.api_requests),
      retries: Number(r.retries),
      error: (r.error as string | null) ?? null,
      errorCode: (r.error_code as string | null) ?? null,
      correlationId: String(r.correlation_id),
      actor: (r.actor as string | null) ?? null,
    })),
  };
}

export async function integrationsView(now = new Date()) {
  const db = await getDb();
  const s = await getSeoSettings();
  let credentials: { configured: boolean; clientEmail: string | null; error: string | null } = { configured: false, clientEmail: null, error: null };
  try {
    const sa = readServiceAccount();
    credentials = { configured: Boolean(sa), clientEmail: sa?.clientEmail ?? null, error: null };
  } catch (e) {
    credentials = { configured: false, clientEmail: null, error: (e as Error).message };
  }
  const rows = await q<Record<string, unknown>>(db, sql`select provider, property_id, status, last_verified_at, last_error, config from seo_integrations order by provider`);
  return {
    credentials,
    gscProperty: s.google.gscProperty,
    ga4PropertyId: s.google.ga4PropertyId,
    searchTypes: s.google.searchTypes,
    urlInspection: s.google.urlInspection,
    pageSpeed: { enabled: s.google.pageSpeed.enabled, keyConfigured: Boolean(process.env.PAGESPEED_API_KEY?.trim()) },
    status: { gsc: await sourceStatus(db, s, "gsc", now), ga4: await sourceStatus(db, s, "ga4", now) },
    integrations: rows.map((r) => ({ provider: String(r.provider), propertyId: (r.property_id as string | null) ?? null, status: String(r.status), lastVerifiedAt: r.last_verified_at ? new Date(String(r.last_verified_at)).toISOString() : null, lastError: (r.last_error as string | null) ?? null, timeZone: ((r.config as { timeZone?: string } | null)?.timeZone) ?? null })),
  };
}

/** Distinct values for filter dropdowns (countries are GSC ISO-3166 alpha-3 codes or GA4 country names). */
export async function filterOptions(source: "gsc" | "ga4") {
  const db = await getDb();
  const table = source === "gsc" ? sql`seo_gsc_page_daily` : sql`seo_ga4_page_daily`;
  const countries = await q<{ c: string }>(db, sql`select country as c from ${table} where date > current_date - 120 group by 1 order by sum(${source === "gsc" ? sql`clicks` : sql`sessions`}) desc limit 60`);
  return { countries: countries.map((r) => r.c) };
}
