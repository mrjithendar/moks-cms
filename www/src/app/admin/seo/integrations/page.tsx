import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { fmtWhen, Section } from "@/components/seo/ui";
import { integrationsView } from "@/lib/seo-intel/queries";

export const metadata = { title: "Integrations" };

const pill = (s: string) => (s === "ok" || s === "connected" ? "ok" : s === "disconnected" || s === "not_configured" ? "not configured" : s === "stale" || s === "never_synced" ? "degraded" : "down");

export default async function IntegrationsPage() {
  const d = await integrationsView();
  return (
    <>
      <AdminHeader
        title="Integrations"
        description="Google Search Console and GA4 are read with a service account. The key lives only in the cluster Secret (GOOGLE_SEO_SERVICE_ACCOUNT_JSON); it is never stored in the database or shown here. Setup: docs/seo/MANUAL_SETUP.md."
        actions={<ApiButton url="/api/admin/seo/integrations/test" label="Test connection" variant="primary" />}
      />
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
