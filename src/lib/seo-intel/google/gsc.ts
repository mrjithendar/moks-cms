import type { SearchType } from "../settings";
import { googleJson, type ApiContext } from "./http";

/**
 * Search Console Search Analytics: POST sites/{siteUrl}/searchAnalytics/query
 * https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 *
 * - `type` (web, image, video, news, discover, googleNews) is a request parameter, not a dimension: one request
 *   per search type.
 * - Paginated with startRow / rowLimit (≤ 25,000).
 * - `dataState: "all"` includes fresh (provisional) data; `metadata.firstIncompleteDate` says from which date on.
 * - Dates are in Pacific Time (Search Console's reporting zone).
 * - Rows that group by query exclude anonymised queries, so totals come from the date-only request and page totals
 *   from the page request, never from summing query rows.
 */
export const GSC_TIME_ZONE = "America/Los_Angeles";
/** Discover and Google News do not support the `query` dimension. */
export const QUERY_SEARCH_TYPES: readonly SearchType[] = ["web", "image", "video", "news"];
/** Discover rejects the `device` dimension (HTTP 400 "Requests for Discover cannot be grouped by device"). */
export const DEVICE_SEARCH_TYPES: readonly SearchType[] = ["web", "image", "video", "news", "googleNews"];
/** Stored in the `device` key column when a search type has no device breakdown. */
export const NO_DEVICE = "(not set)";

export type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position?: number };
type GscResponse = { rows?: GscRow[]; metadata?: { firstIncompleteDate?: string } };

export type GscRequest = { startDate: string; endDate: string; dimensions: string[]; type: SearchType };

export function gscUrl(property: string): string {
  return `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
}

/** Every row of one report, page by page. `complete` is false when the request budget ran out mid-way. */
export async function queryAll(ctx: ApiContext, property: string, req: GscRequest, rowLimit: number): Promise<{ rows: GscRow[]; firstIncompleteDate: string | null }> {
  const rows: GscRow[] = [];
  let firstIncompleteDate: string | null = null;
  for (let startRow = 0; ; startRow += rowLimit) {
    const res = await googleJson<GscResponse>(ctx, gscUrl(property), { ...req, rowLimit, startRow, dataState: "all" });
    const page = res.rows ?? [];
    rows.push(...page);
    firstIncompleteDate ??= res.metadata?.firstIncompleteDate ?? null;
    if (page.length < rowLimit) break;
  }
  return { rows, firstIncompleteDate };
}

/** Verify access with a 1-row request over the last week. */
export async function testGsc(ctx: ApiContext, property: string, today: string): Promise<{ rows: number }> {
  const end = today;
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 7);
  const res = await googleJson<GscResponse>(ctx, gscUrl(property), { startDate: start.toISOString().slice(0, 10), endDate: end, dimensions: ["date"], type: "web", rowLimit: 1, dataState: "all" });
  return { rows: res.rows?.length ?? 0 };
}
