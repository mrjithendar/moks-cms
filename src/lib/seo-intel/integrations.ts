import { getDb } from "@/db";
import { CredentialsError, readServiceAccount, SCOPES } from "./google/auth";
import { checkCompatibility, GA4_REPORTS, runReport } from "./google/ga4";
import { GSC_TIME_ZONE, testGsc } from "./google/gsc";
import { GoogleApiError, type ApiContext } from "./google/http";
import { setIntegration } from "./jobs";
import { getSeoSettings } from "./settings";
import { addDays, dateIn } from "./sqlutil";

/**
 * "Test connection" in Settings → Search & SEO → Search Console & GA4: one cheap, real request per provider. A provider is reported as
 * connected only after Google answered successfully; nothing is simulated.
 */
export type TestResult = { provider: "gsc" | "ga4"; ok: boolean; status: "connected" | "auth_error" | "error" | "not_configured"; message: string };

export async function testIntegrations(deps: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; now?: Date } = {}): Promise<TestResult[]> {
  const db = await getDb();
  const s = await getSeoSettings();
  const now = deps.now ?? new Date();
  let sa;
  try {
    sa = readServiceAccount(deps.env);
  } catch (e) {
    const message = e instanceof CredentialsError ? e.message : "The service-account key could not be read.";
    return [
      { provider: "gsc", ok: false, status: "not_configured", message },
      { provider: "ga4", ok: false, status: "not_configured", message },
    ];
  }
  const results: TestResult[] = [];
  const ctx = (provider: ApiContext["provider"], scope: string): ApiContext | null =>
    sa ? { sa, scope, provider, stats: { apiRequests: 0, retries: 0 }, maxRequests: 5, fetchImpl: deps.fetchImpl, maxRetries: 1, timeoutMs: 20_000 } : null;

  const fail = (provider: "gsc" | "ga4", e: unknown): TestResult => {
    if (e instanceof GoogleApiError) return { provider, ok: false, status: e.code === "auth" ? "auth_error" : "error", message: e.message };
    return { provider, ok: false, status: "error", message: "Unexpected error while testing; see the logs." };
  };

  // Search Console
  const gscCtx = ctx("gsc", SCOPES.searchConsole);
  if (!gscCtx || !s.google.gscProperty) {
    results.push({ provider: "gsc", ok: false, status: "not_configured", message: !gscCtx ? "GOOGLE_SEO_SERVICE_ACCOUNT_JSON is not set." : "No Search Console property is set." });
  } else {
    try {
      const r = await testGsc(gscCtx, s.google.gscProperty, dateIn(GSC_TIME_ZONE, now));
      results.push({ provider: "gsc", ok: true, status: "connected", message: `Search Console answered (${r.rows} row${r.rows === 1 ? "" : "s"} in the sample).` });
      await setIntegration(db, "gsc", s.google.gscProperty, "connected", null);
    } catch (e) {
      const r = fail("gsc", e);
      results.push(r);
      await setIntegration(db, "gsc", s.google.gscProperty, r.status, r.message);
    }
  }

  // GA4: compatibility of every report the sync uses, plus a 1-row report to learn the property's time zone.
  const gaCtx = ctx("ga4", SCOPES.analytics);
  if (!gaCtx || !s.google.ga4PropertyId) {
    results.push({ provider: "ga4", ok: false, status: "not_configured", message: !gaCtx ? "GOOGLE_SEO_SERVICE_ACCOUNT_JSON is not set." : "No GA4 property id is set." });
  } else {
    try {
      const incompatible: string[] = [];
      for (const report of Object.values(GA4_REPORTS)) incompatible.push(...(await checkCompatibility(gaCtx, s.google.ga4PropertyId, report)));
      const yesterday = addDays(now.toISOString().slice(0, 10), -1);
      const sample = await runReport(gaCtx, s.google.ga4PropertyId, GA4_REPORTS.landingPages, { start: yesterday, end: yesterday }, 0, 1);
      if (incompatible.length) {
        const message = `GA4 reports these fields as incompatible: ${incompatible.join(", ")}.`;
        results.push({ provider: "ga4", ok: false, status: "error", message });
        await setIntegration(db, "ga4", s.google.ga4PropertyId, "error", message, sample.timeZone ? { timeZone: sample.timeZone } : {});
      } else {
        results.push({ provider: "ga4", ok: true, status: "connected", message: `GA4 answered; property time zone ${sample.timeZone ?? "unknown"}.` });
        await setIntegration(db, "ga4", s.google.ga4PropertyId, "connected", null, sample.timeZone ? { timeZone: sample.timeZone } : {});
      }
    } catch (e) {
      const r = fail("ga4", e);
      results.push(r);
      await setIntegration(db, "ga4", s.google.ga4PropertyId, r.status, r.message);
    }
  }
  return results;
}
