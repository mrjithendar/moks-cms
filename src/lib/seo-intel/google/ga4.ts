import { googleJson, type ApiContext } from "./http";

/**
 * GA4 Analytics Data API v1beta: runReport and checkCompatibility.
 * https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
 *
 * The sync only ever requests the dimension/metric combinations in GA4_REPORTS (a tested allowlist).
 * "Test connection" calls checkCompatibility for each, so an incompatible combination is reported before a sync.
 * GA4 sessions are not Search Console clicks; the two are stored and shown separately.
 */
export const GA4_REPORTS = {
  landingPages: {
    dimensions: ["date", "landingPagePlusQueryString", "sessionDefaultChannelGroup", "deviceCategory", "country", "newVsReturning"],
    metrics: ["activeUsers", "newUsers", "sessions", "engagedSessions", "engagementRate", "userEngagementDuration", "screenPageViews", "keyEvents"],
  },
} as const;

export type Ga4Report = { readonly dimensions: readonly string[]; readonly metrics: readonly string[] };

/**
 * v5 (docs/seo/ML.md "Related articles"): views of each page path in sessions that started on a landing page,
 * aggregated over 28 days: the reader co-visitation signal. Kept out of GA4_REPORTS on purpose: a property where this
 * pair isn't available must not make "Test connection" or the daily sync fail; the sync tries it and records the
 * answer (seo_integrations.config.pagePairs).
 */
export const GA4_PAGE_PAIRS_REPORT = { dimensions: ["landingPagePlusQueryString", "pagePath"], metrics: ["screenPageViews"] } as const;

export type QuotaStatus = { consumed?: number; remaining?: number };
export type PropertyQuota = Partial<Record<"tokensPerDay" | "tokensPerHour" | "concurrentRequests" | "serverErrorsPerProjectPerHour" | "potentiallyThresholdedRequestsPerHour" | "tokensPerProjectPerHour", QuotaStatus>>;

type RunReportResponse = {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  rowCount?: number;
  propertyQuota?: PropertyQuota;
  metadata?: { timeZone?: string; currencyCode?: string; dataLossFromOtherRow?: boolean; subjectToThresholding?: boolean };
};

export type Ga4Row = Record<string, string>;
export type Ga4Page = { rows: Ga4Row[]; rowCount: number; quota: PropertyQuota | null; timeZone: string | null; thresholded: boolean };

const base = (propertyId: string) => `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}`;

export async function runReport(ctx: ApiContext, propertyId: string, report: Ga4Report, range: { start: string; end: string }, offset: number, limit: number): Promise<Ga4Page> {
  const res = await googleJson<RunReportResponse>(ctx, `${base(propertyId)}:runReport`, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: report.dimensions.map((name) => ({ name })),
    metrics: report.metrics.map((name) => ({ name })),
    limit,
    offset,
    keepEmptyRows: false,
    returnPropertyQuota: true,
  });
  const dims = (res.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (res.metricHeaders ?? []).map((h) => h.name);
  const rows = (res.rows ?? []).map((r) => {
    const o: Ga4Row = {};
    dims.forEach((d, i) => (o[d] = r.dimensionValues[i]?.value ?? ""));
    mets.forEach((m, i) => (o[m] = r.metricValues[i]?.value ?? "0"));
    return o;
  });
  return { rows, rowCount: res.rowCount ?? rows.length, quota: res.propertyQuota ?? null, timeZone: res.metadata?.timeZone ?? null, thresholded: Boolean(res.metadata?.subjectToThresholding) };
}

type CompatibilityResponse = {
  dimensionCompatibilities?: { dimensionMetadata?: { apiName?: string }; compatibility?: string }[];
  metricCompatibilities?: { metricMetadata?: { apiName?: string }; compatibility?: string }[];
};

/**
 * Names in `report` that GA4 says cannot be combined (empty = compatible).
 *
 * checkCompatibility lists every field in the property's catalogue that could not be *added* to the request
 * (campaign, Google Ads, cohort, item… fields), so the answer is filtered to the fields the report actually asks for.
 */
export async function checkCompatibility(ctx: ApiContext, propertyId: string, report: Ga4Report): Promise<string[]> {
  const res = await googleJson<CompatibilityResponse>(ctx, `${base(propertyId)}:checkCompatibility`, {
    dimensions: report.dimensions.map((name) => ({ name })),
    metrics: report.metrics.map((name) => ({ name })),
    compatibilityFilter: "INCOMPATIBLE",
  });
  const requested = new Set<string>([...report.dimensions, ...report.metrics]);
  return [
    ...(res.dimensionCompatibilities ?? []).map((d) => d.dimensionMetadata?.apiName),
    ...(res.metricCompatibilities ?? []).map((m) => m.metricMetadata?.apiName),
  ].filter((name): name is string => !!name && requested.has(name));
}

/** Stop a sync before the property's token budget is exhausted (other GA4 users share it). */
export function quotaLow(q: PropertyQuota | null): string | null {
  if (!q) return null;
  if ((q.tokensPerDay?.remaining ?? Infinity) < 2000) return "tokensPerDay";
  if ((q.tokensPerHour?.remaining ?? Infinity) < 500) return "tokensPerHour";
  if ((q.tokensPerProjectPerHour?.remaining ?? Infinity) < 500) return "tokensPerProjectPerHour";
  return null;
}

/** "20261108" → "2026-11-08". */
export const ga4Date = (v: string) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v);
