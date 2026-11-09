/**
 * FIXTURE / DEMO DATA ONLY — a fake Google (OAuth token endpoint, Search Console Search Analytics, GA4 Data API)
 * for tests. Every number below is invented and deterministic; none of it is jithendar.com's real traffic.
 */
import { generateKeyPairSync } from "node:crypto";
import type { SeoSettingsInput } from "@/lib/seo-intel/settings";
import { DEFAULT_SEO_SETTINGS, publicSettings } from "@/lib/seo-intel/settings";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** A throwaway service-account key generated per test run (never a real credential). */
export const FAKE_SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "fixture-project",
  client_email: "seo-fixture@fixture-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
});

export const FIXTURE_ENV = { GOOGLE_SEO_SERVICE_ACCOUNT_JSON: FAKE_SA_JSON, SITE_URL: "https://jithendar.com" };

export function settingsInput(overrides: Partial<SeoSettingsInput> = {}): SeoSettingsInput {
  const { llmKeySet: _k, ...base } = publicSettings(DEFAULT_SEO_SETTINGS);
  void _k;
  return {
    ...base,
    google: { ...base.google, gscProperty: "sc-domain:jithendar.com", ga4PropertyId: "123456789" },
    ...overrides,
  } as SeoSettingsInput;
}

// --- Fixture site: pages and queries ------------------------------------------------------------------------

export const FIXTURE_PAGES = [
  // Raw URL variants on purpose: http, www, trailing slash and query string all normalise to one page.
  { raw: "https://jithendar.com/blog/argo-cd-gitops", base: 40 },
  { raw: "http://www.jithendar.com/blog/argo-cd-gitops/", base: 2 },
  { raw: "https://jithendar.com/blog/terraform-state", base: 25 },
  { raw: "https://jithendar.com/news/eks-upgrade?utm_source=x", base: 8 },
  { raw: "https://jithendar.com/", base: 10 },
];

export const FIXTURE_QUERIES = ["argo cd gitops", "argocd sync waves", "terraform state lock", "eks 1.34 upgrade", "jithendar"];

type Options = {
  /** Status codes to return (in order) for Google data requests before answering normally. */
  failures?: number[];
  /** Drop this page from page/query responses (simulates provisional data revised away). */
  dropPage?: string;
  /** GA4 quota remaining per day (default plenty). */
  ga4TokensRemaining?: number;
  /** Extra synthetic pages so a report needs several pages of results. */
  extraPages?: number;
};

export type FakeGoogle = { fetch: typeof fetch; calls: { url: string; body: Record<string, unknown> }[] };

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

const dayNum = (d: string) => Number(d.slice(8, 10));

export function fakeGoogle(opts: Options = {}): FakeGoogle {
  const failures = [...(opts.failures ?? [])];
  const calls: FakeGoogle["calls"] = [];
  const pages = [...FIXTURE_PAGES, ...Array.from({ length: opts.extraPages ?? 0 }, (_, i) => ({ raw: `https://jithendar.com/blog/extra-${i}`, base: 1 }))];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body && typeof init.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    const failure = failures.shift();
    if (failure) return Response.json({ error: { message: `fixture failure ${failure}` } }, { status: failure });

    if (url.includes("/searchAnalytics/query")) {
      const dims = body.dimensions as string[];
      const days = datesBetween(String(body.startDate), String(body.endDate));
      const rowLimit = Number(body.rowLimit);
      const startRow = Number(body.startRow ?? 0);
      const type = String(body.type);
      const typeFactor = type === "web" ? 1 : 0.1;
      const rows: { keys: string[]; clicks: number; impressions: number; ctr: number; position?: number }[] = [];
      for (const day of days) {
        if (dims.length === 1) {
          // Site totals: deliberately larger than the sum of query rows (anonymised queries).
          const clicks = Math.round(5000 * typeFactor + dayNum(day));
          const impressions = clicks * 20;
          rows.push({ keys: [day], clicks, impressions, ctr: clicks / impressions, position: 9.5 });
          continue;
        }
        for (const p of pages) {
          if (opts.dropPage && p.raw === opts.dropPage) continue;
          for (const device of ["MOBILE", "DESKTOP"]) {
            const clicks = Math.round(p.base * typeFactor * (device === "MOBILE" ? 2 : 1));
            const impressions = clicks * 15 + 30;
            if (dims.includes("query")) {
              for (const [qi, q] of FIXTURE_QUERIES.entries()) {
                if ((qi + p.base) % 2 !== 0) continue;
                rows.push({ keys: [day, p.raw, q, device, "ind"], clicks: Math.max(0, clicks - qi), impressions: impressions + qi * 10, ctr: 0, position: 4 + qi * 3 });
              }
            } else {
              rows.push({ keys: [day, p.raw, device, "ind"], clicks, impressions, ctr: clicks / impressions, position: 6.5 });
            }
          }
        }
      }
      for (const r of rows) r.ctr = r.impressions ? r.clicks / r.impressions : 0;
      if (type === "discover") for (const r of rows) delete r.position;
      return Response.json({ rows: rows.slice(startRow, startRow + rowLimit), responseAggregationType: "byPage", metadata: { firstIncompleteDate: String(body.endDate) } });
    }

    if (url.endsWith(":runReport")) {
      const range = (body.dateRanges as { startDate: string; endDate: string }[])[0]!;
      const limit = Number(body.limit);
      const offset = Number(body.offset ?? 0);
      const all: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] = [];
      for (const day of datesBetween(range.startDate, range.endDate)) {
        for (const p of pages) {
          const path = new URL(p.raw).pathname + new URL(p.raw).search;
          for (const channel of ["Organic Search", "Direct"]) {
            const sessions = p.base * (channel === "Organic Search" ? 3 : 1);
            all.push({
              dimensionValues: [day.replace(/-/g, ""), path, channel, "mobile", "India", "new"].map((value) => ({ value })),
              metricValues: [sessions, sessions, sessions, Math.round(sessions * 0.6), 0.6, sessions * 40, sessions * 2, 0].map((v) => ({ value: String(v) })),
            });
          }
        }
      }
      return Response.json({
        dimensionHeaders: ["date", "landingPagePlusQueryString", "sessionDefaultChannelGroup", "deviceCategory", "country", "newVsReturning"].map((name) => ({ name })),
        metricHeaders: ["activeUsers", "newUsers", "sessions", "engagedSessions", "engagementRate", "userEngagementDuration", "screenPageViews", "keyEvents"].map((name) => ({ name })),
        rows: all.slice(offset, offset + limit),
        rowCount: all.length,
        propertyQuota: { tokensPerDay: { consumed: 10, remaining: opts.ga4TokensRemaining ?? 190_000 }, tokensPerHour: { consumed: 10, remaining: 39_000 } },
        metadata: { timeZone: "Asia/Kolkata", currencyCode: "INR" },
      });
    }

    if (url.endsWith(":checkCompatibility")) return Response.json({ dimensionCompatibilities: [], metricCompatibilities: [] });
    return new Response("not found", { status: 404 });
  };
  return { fetch: impl as typeof fetch, calls };
}
