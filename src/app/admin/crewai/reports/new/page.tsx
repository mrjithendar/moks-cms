import Link from "next/link";
import { getDb } from "@/db";
import { AdminHeader, Card } from "@/components/admin/ui";
import { ReportForm, type ReportDefaults } from "@/components/crewai/reports/ReportForm";
import { CATEGORIES, discoverCrewsFlows, discoverSources } from "@/lib/reports/catalog";
import { istToday, PRESETS } from "@/lib/reports/ranges";
import { getReportRow } from "@/lib/reports/service";

export const metadata = { title: "New report" };
export const dynamic = "force-dynamic";

/** New report: what the site has is discovered now (sources, crews, flows), so the form only offers what exists. */
export default async function NewReportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const db = await getDb();
  const [sources, cf] = await Promise.all([discoverSources(db), discoverCrewsFlows(db)]);
  const { getSeoSettings } = await import("@/lib/seo-intel/settings");
  const { mailConfigured } = await import("@/lib/mail");
  const { storageReady } = await import("@/lib/storage");
  const { agentStatus } = await import("@/lib/seo-agent/endpoint");
  const [s, mail, storage, agent] = await Promise.all([getSeoSettings(), mailConfigured(), storageReady().catch(() => false), agentStatus().catch(() => ({ enabled: false }))]);
  const from = sp.from ? await getReportRow(sp.from) : null;
  const req = from?.request;
  const defaults: ReportDefaults = req ? { title: from.title, preset: req.range.preset, start: req.range.start, end: req.range.end, categories: req.categories, crews: req.crews, flows: req.flows, sources: req.sources } : { email: sp.email === "1", ...(sp.category && CATEGORIES.some((c) => c.key === sp.category) ? { categories: [sp.category] } : {}) };
  const flowLabel = (f: { key: string; label: string }) => (f.key === "news_job_flow" ? "Content flows" : f.key === "custom_flow" ? "Custom flows (made in the admin)" : f.label);
  return (
    <>
      <AdminHeader title="New report" description={<>Choose the dates and what the report covers. It is built in the background, analysed by the Report crew and stored in R2; its page follows the progress. <Link className="link" href="/admin/crewai/reports">All reports</Link></>} />
      <Card>
        <ReportForm
          defaults={defaults}
          options={{
            presets: Object.entries(PRESETS).map(([key, label]) => ({ key, label })),
            categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, description: c.description, sources: c.sources, scoped: !!c.scoped })),
            sources: sources.map((x) => ({ key: x.key, label: x.label, status: x.status, detail: x.detail, categories: x.categories })),
            crews: cf.crews,
            flows: cf.flows.map((f) => ({ ...f, label: flowLabel(f) })),
            recipients: s.reports.recipients,
            mailConfigured: mail,
            storageReady: storage,
            agentOn: agent.enabled,
            today: istToday(),
          }}
        />
      </Card>
    </>
  );
}
