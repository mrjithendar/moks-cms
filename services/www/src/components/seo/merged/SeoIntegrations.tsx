import { Card, StatusPill } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { fmtWhen, Section } from "@/components/seo/ui";
import { dataForSeoStatus } from "@/lib/seo-intel/dataforseo";
import { integrationsView } from "@/lib/seo-intel/queries";
import { getSeoSettings } from "@/lib/seo-intel/settings";

const pill = (s: string) => (s === "ok" || s === "connected" ? "ok" : s === "disconnected" || s === "not_configured" ? "not configured" : s === "stale" || s === "never_synced" ? "degraded" : "down");

/** Search Console + GA4, shown as a section of Admin → Integrations. */
export async function SeoIntegrations() {
  const [d, settings] = await Promise.all([integrationsView(), getSeoSettings()]);
  const dfs = await dataForSeoStatus(settings);
  const dfsJobs = [
    ["dataforseo_keywords", "Volume and difficulty", settings.dataforseo.keywordMetrics.enabled],
    ["serp_ranks", "Live Google ranks (tracked keywords)", settings.dataforseo.rankTracking.enabled],
    ["backlinks", "Backlinks", settings.dataforseo.backlinks.enabled],
  ] as const;
  return (
    <>
      <Section
        title="Search Console and Google Analytics"
        description="Read with a service account. The key lives only in the cluster Secret (GOOGLE_SEO_SERVICE_ACCOUNT_JSON); it is never stored in the database or shown here. Setup: docs/seo/MANUAL_SETUP.md."
      >
        <ApiButton url="/api/admin/seo/integrations/test" label="Test connection" variant="primary" />
      </Section>
      <Section title="Credentials">
        <Card>
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg">
            <StatusPill status={d.credentials.configured ? "configured" : "not configured"} />
            {d.credentials.configured ? <>Service account <code className="[overflow-wrap:anywhere]">{d.credentials.clientEmail}</code></> : "GOOGLE_SEO_SERVICE_ACCOUNT_JSON is not set."}
          </p>
          {d.credentials.error && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{d.credentials.error}</p>}
          <p className="mt-2 text-xs text-fg-subtle">Add this email as a user on the Search Console property (Restricted is enough) and as a Viewer in GA4 Property access management.</p>
        </Card>
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        {(["gsc", "ga4"] as const).map((p) => {
          const st = d.status[p];
          const row = d.integrations.find((i) => i.provider === p);
          return (
            <Card key={p}>
              <h3 className="flex items-center gap-2 font-semibold text-fg">{p === "gsc" ? "Search Console" : "Google Analytics 4"} <StatusPill status={pill(row?.status ?? st.state)} /></h3>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-subtle">Property</dt><dd className="[overflow-wrap:anywhere]">{(p === "gsc" ? d.gscProperty : d.ga4PropertyId) || "not set (Settings or SEO_GSC_PROPERTY / SEO_GA4_PROPERTY_ID)"}</dd>
                {p === "gsc" && <><dt className="text-fg-subtle">Search types</dt><dd>{d.searchTypes.join(", ")}</dd></>}
                {p === "ga4" && <><dt className="text-fg-subtle">Time zone</dt><dd>{row?.timeZone ?? "learned on first test or sync"}</dd></>}
                <dt className="text-fg-subtle">Verified</dt><dd>{fmtWhen(row?.lastVerifiedAt ?? null)}</dd>
                <dt className="text-fg-subtle">Last good sync</dt><dd>{fmtWhen(st.lastSuccessAt)}</dd>
                <dt className="text-fg-subtle">Latest data</dt><dd>{st.latestDate ?? "none"}</dd>
              </dl>
              <p className="mt-3 text-sm text-fg-muted">{st.message}</p>
              {row?.lastError && <p className="mt-2 text-sm text-red-700 [overflow-wrap:anywhere] dark:text-red-300">Last error: {row.lastError}</p>}
            </Card>
          );
        })}
      </div>
      <Section
        title="DataForSEO"
        description="Pay as you go: search volume and keyword difficulty, live Google rankings and backlinks. Credentials live only in the cluster Secret (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD); switches, market and the monthly cap are in Settings → Data sources. Setup: docs/seo/DATAFORSEO.md."
      >
        <Card>
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg">
            <StatusPill status={!dfs.credentials ? "not configured" : dfs.enabled ? "ok" : "degraded"} />
            {!dfs.credentials ? "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set." : dfs.enabled ? "On." : "Credentials set; switched off in Settings."}
            <span className="text-fg-muted">This month: ${dfs.spentUsd.toFixed(2)} of ${dfs.budgetUsd} cap.</span>
          </p>
          <ul className="mt-3 grid gap-2 text-sm">
            {dfsJobs.map(([job, label, on]) => {
              const last = dfs.lastRuns.find((r) => r.job_type === job);
              return (
                <li key={job} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{label}</strong>: {on ? "on" : "off"}
                    {last && <span className="text-fg-subtle"> · last run {last.status} {fmtWhen(last.finished_at)}{last.error ? ` (${last.error.slice(0, 120)})` : ""}</span>}
                  </span>
                  {dfs.enabled && dfs.credentials && on && <ApiButton url="/api/admin/seo/dataforseo/run" body={{ job }} label="Run now" />}
                </li>
              );
            })}
          </ul>
        </Card>
      </Section>
      <Section title="Optional services" description="Off by default. Neither is a paid service at this site's volume, but both stay off until enabled in Settings.">
        <Card>
          <ul className="space-y-2 text-sm">
            <li><strong>URL Inspection API</strong>: {d.urlInspection.enabled ? `on (up to ${d.urlInspection.dailyLimit} URLs/day)` : "off"}. Results are Google&apos;s last-known state, not a live indexing guarantee. Needs Full user permission on the property.</li>
            <li><strong>PageSpeed Insights / CrUX</strong>: {d.pageSpeed.enabled ? "on" : "off"}; API key {d.pageSpeed.keyConfigured ? "set" : "not set"} (PAGESPEED_API_KEY).</li>
          </ul>
        </Card>
      </Section>
    </>
  );
}
