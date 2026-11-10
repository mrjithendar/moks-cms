import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { GA4_PAGE_PAIRS_REPORT, GA4_REPORTS, ga4Date, quotaLow, runReport, type PropertyQuota } from "./google/ga4";
import { DEVICE_SEARCH_TYPES, NO_DEVICE, QUERY_SEARCH_TYPES, queryAll, type GscRow } from "./google/gsc";
import { GoogleApiError, type ApiContext } from "./google/http";
import type { SearchType } from "./settings";
import { upsertRows } from "./sqlutil";
import { normalizeUrl, upsertUrlMap, type Normalized } from "./urls";

/**
 * Search Console and GA4 → daily tables. Both are idempotent: rows are upserted on their full dimension key, and
 * after a window has been fetched completely, rows in that window that the API no longer returns (provisional data
 * revised away) are pruned, so re-running a window always leaves exactly what Google reports.
 */
export type SyncResult = { rows: number; partial: boolean; note?: string };

type Agg = { clicks: number; impressions: number; posWeighted: number; posImpr: number };

/** Several raw URLs can normalise to one page (http/www/trailing slash/query): sum them, impression-weight position. */
function aggregate(rows: GscRow[], keyOf: (r: GscRow) => string[] | null): Map<string, { key: string[]; agg: Agg }> {
  const out = new Map<string, { key: string[]; agg: Agg }>();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    const k = JSON.stringify(key);
    const e = out.get(k) ?? { key, agg: { clicks: 0, impressions: 0, posWeighted: 0, posImpr: 0 } };
    e.agg.clicks += r.clicks;
    e.agg.impressions += r.impressions;
    if (typeof r.position === "number" && r.impressions > 0) {
      e.agg.posWeighted += r.position * r.impressions;
      e.agg.posImpr += r.impressions;
    }
    out.set(k, e);
  }
  return out;
}

const metrics = (a: Agg) => [a.clicks, a.impressions, a.impressions > 0 ? a.clicks / a.impressions : 0, a.posImpr > 0 ? a.posWeighted / a.posImpr : null];
const state = (date: string, firstIncomplete: string | null) => (firstIncomplete && date >= firstIncomplete ? "provisional" : "final");

async function prune(db: Db, table: string, window: { start: string; end: string }, searchType: string | null, before: Date) {
  const typeFilter = searchType ? sql` and search_type = ${searchType}` : sql``;
  await db.execute(sql`delete from ${sql.raw(`"${table}"`)} where date between ${window.start} and ${window.end}${typeFilter} and synced_at < ${before.toISOString()}`);
}

export async function syncGscWindow(db: Db, ctx: ApiContext, property: string, searchTypes: readonly SearchType[], window: { start: string; end: string }, rowLimit: number, now = new Date()): Promise<SyncResult> {
  let rows = 0;
  const syncedAt = now.toISOString();
  const urls: Normalized[] = [];
  for (const type of searchTypes) {
    // 1. Site totals (date only): the source of truth for clicks/impressions/CTR/position.
    const totals = await queryAll(ctx, property, { startDate: window.start, endDate: window.end, dimensions: ["date"], type }, rowLimit);
    rows += await upsertRows(
      db,
      "seo_gsc_daily_totals",
      ["date", "search_type", "clicks", "impressions", "ctr", "position", "data_state", "synced_at"],
      ["date", "search_type"],
      totals.rows.map((r) => [r.keys[0], type, r.clicks, r.impressions, r.ctr, typeof r.position === "number" ? r.position : null, state(r.keys[0]!, totals.firstIncompleteDate), syncedAt]),
    );
    await prune(db, "seo_gsc_daily_totals", window, type, now);

    // 2. Pages (date × page × device × country): page totals. Discover has no device breakdown (NO_DEVICE).
    const byDevice = DEVICE_SEARCH_TYPES.includes(type);
    const pages = await queryAll(ctx, property, { startDate: window.start, endDate: window.end, dimensions: byDevice ? ["date", "page", "device", "country"] : ["date", "page", "country"], type }, rowLimit);
    const pageAgg = aggregate(pages.rows, (r) => {
      const n = normalizeUrl(r.keys[1] ?? "");
      if (!n) return null;
      urls.push(n);
      const [device, country] = byDevice ? [(r.keys[2] ?? "").toLowerCase(), r.keys[3]] : [NO_DEVICE, r.keys[2]];
      return [r.keys[0]!, n.url, device, (country ?? "").toLowerCase()];
    });
    rows += await upsertRows(
      db,
      "seo_gsc_page_daily",
      ["date", "page", "search_type", "device", "country", "clicks", "impressions", "ctr", "position", "data_state", "synced_at"],
      ["date", "page", "search_type", "device", "country"],
      [...pageAgg.values()].map(({ key, agg }) => [key[0], key[1], type, key[2], key[3], ...metrics(agg), state(key[0]!, pages.firstIncompleteDate), syncedAt]),
    );
    await prune(db, "seo_gsc_page_daily", window, type, now);

    // 3. Queries (date × page × query × device × country): partial coverage (anonymised queries excluded).
    if (QUERY_SEARCH_TYPES.includes(type)) {
      const queries = await queryAll(ctx, property, { startDate: window.start, endDate: window.end, dimensions: ["date", "page", "query", "device", "country"], type }, rowLimit);
      const queryAgg = aggregate(queries.rows, (r) => {
        const n = normalizeUrl(r.keys[1] ?? "");
        const q = (r.keys[2] ?? "").trim().toLowerCase().slice(0, 500);
        if (!n || !q) return null;
        return [r.keys[0]!, n.url, q, (r.keys[3] ?? "").toLowerCase(), (r.keys[4] ?? "").toLowerCase()];
      });
      rows += await upsertRows(
        db,
        "seo_gsc_query_daily",
        ["date", "page", "query", "search_type", "device", "country", "clicks", "impressions", "ctr", "position", "data_state", "synced_at"],
        ["date", "page", "query", "search_type", "device", "country"],
        [...queryAgg.values()].map(({ key, agg }) => [key[0], key[1], key[2], type, key[3], key[4], ...metrics(agg), state(key[0]!, queries.firstIncompleteDate), syncedAt]),
      );
      await prune(db, "seo_gsc_query_daily", window, type, now);
    }
  }
  await upsertUrlMap(db, urls, now);
  return { rows, partial: false };
}

const int = (v: string | undefined) => Math.round(Number(v) || 0);
const float = (v: string | undefined) => Number(v) || 0;

/** GA4 landing pages for one window. Stops early (partial) when the property's token quota runs low. */
export async function syncGa4Window(db: Db, ctx: ApiContext, propertyId: string, window: { start: string; end: string }, now = new Date(), pageSize = 10_000): Promise<SyncResult & { timeZone: string | null; quota: PropertyQuota | null; thresholded: boolean }> {
  const report = GA4_REPORTS.landingPages;
  const limit = pageSize;
  const syncedAt = now.toISOString();
  type A = { activeUsers: number; newUsers: number; sessions: number; engaged: number; duration: number; views: number; keyEvents: number };
  const agg = new Map<string, { key: string[]; a: A }>();
  const urls: Normalized[] = [];
  let timeZone: string | null = null;
  let quota: PropertyQuota | null = null;
  let thresholded = false;
  let partial = false;
  let note: string | undefined;
  for (let offset = 0; ; offset += limit) {
    const page = await runReport(ctx, propertyId, report, window, offset, limit);
    timeZone ??= page.timeZone;
    quota = page.quota;
    thresholded ||= page.thresholded;
    for (const r of page.rows) {
      const n = normalizeUrl(r.landingPagePlusQueryString ?? "");
      if (n) urls.push(n);
      const landing = n ? n.url : (r.landingPagePlusQueryString || "(not set)").slice(0, 500);
      const key = [ga4Date(r.date ?? ""), landing, r.sessionDefaultChannelGroup || "(not set)", (r.deviceCategory || "(not set)").toLowerCase(), r.country || "(not set)", r.newVsReturning || "(not set)"];
      const k = JSON.stringify(key);
      const e = agg.get(k) ?? { key, a: { activeUsers: 0, newUsers: 0, sessions: 0, engaged: 0, duration: 0, views: 0, keyEvents: 0 } };
      // Users are not strictly additive across merged URL variants; summing is an upper bound and is labelled as such.
      e.a.activeUsers += int(r.activeUsers);
      e.a.newUsers += int(r.newUsers);
      e.a.sessions += int(r.sessions);
      e.a.engaged += int(r.engagedSessions);
      e.a.duration += float(r.userEngagementDuration);
      e.a.views += int(r.screenPageViews);
      e.a.keyEvents += float(r.keyEvents);
      agg.set(k, e);
    }
    if (offset + limit >= page.rowCount || page.rows.length < limit) break;
    const low = quotaLow(page.quota);
    if (low) {
      partial = true;
      note = `Stopped early: GA4 ${low} quota is low.`;
      break;
    }
  }
  const rows = await upsertRows(
    db,
    "seo_ga4_page_daily",
    ["date", "landing_page", "channel_group", "device", "country", "new_vs_returning", "active_users", "new_users", "sessions", "engaged_sessions", "engagement_rate", "user_engagement_duration", "screen_page_views", "key_events", "synced_at"],
    ["date", "landing_page", "channel_group", "device", "country", "new_vs_returning"],
    [...agg.values()].map(({ key, a }) => [...key, a.activeUsers, a.newUsers, a.sessions, a.engaged, a.sessions > 0 ? a.engaged / a.sessions : 0, a.duration, a.views, a.keyEvents, syncedAt]),
  );
  if (!partial) await prune(db, "seo_ga4_page_daily", window, null, now);
  await upsertUrlMap(db, urls.filter((u) => u.internal), now);
  return { rows, partial, note, timeZone, quota, thresholded };
}

/**
 * v5: landing page → page path views in the same sessions over one window (default the last 28 days), replacing
 * `seo_ga4_page_pairs`. Only internal URLs; at most `maxRows`. Returns `unsupported` instead of throwing when the
 * property rejects the dimension pair, so the related-articles model falls back to similarity + queries + category.
 */
export async function syncGa4PagePairs(db: Db, ctx: ApiContext, propertyId: string, window: { start: string; end: string }, now = new Date(), maxRows = 20_000): Promise<{ rows: number; unsupported?: string }> {
  const agg = new Map<string, number>();
  try {
    for (let offset = 0; offset < maxRows; offset += 10_000) {
      const page = await runReport(ctx, propertyId, GA4_PAGE_PAIRS_REPORT, window, offset, 10_000);
      for (const r of page.rows) {
        const from = normalizeUrl(r.landingPagePlusQueryString ?? "");
        const to = normalizeUrl(r.pagePath ?? "");
        if (!from?.internal || !to?.internal || from.path === to.path) continue;
        const k = JSON.stringify([from.path, to.path]);
        agg.set(k, (agg.get(k) ?? 0) + int(r.screenPageViews));
      }
      if (offset + 10_000 >= page.rowCount || page.rows.length < 10_000 || quotaLow(page.quota)) break;
    }
  } catch (e) {
    if (e instanceof GoogleApiError && e.code !== "auth") return { rows: 0, unsupported: e.message.slice(0, 300) };
    throw e;
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from seo_ga4_page_pairs`);
    const rows = [...agg].map(([k, v]) => [...(JSON.parse(k) as [string, string]), v] as const);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await tx.execute(sql`insert into seo_ga4_page_pairs (landing_page, page_path, views, period_start, period_end, synced_at) values ${sql.join(chunk.map(([a, b, v]) => sql`(${a}, ${b}, ${v}, ${window.start}, ${window.end}, ${now.toISOString()})`), sql`, `)}`);
    }
  });
  return { rows: agg.size };
}

export { GoogleApiError };
