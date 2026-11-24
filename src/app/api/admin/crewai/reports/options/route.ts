import { getDb } from "@/db";
import { json, seoRoute } from "@/lib/seo-intel/http";
import { CATEGORIES, discoverCrewsFlows, discoverSources } from "@/lib/reports/catalog";
import { PRESETS } from "@/lib/reports/ranges";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/crewai/reports/options — what a report can cover on this site: the categories, every data source with
 * its status as found now (available, empty with what to set up, or not available), the crews and flows, the presets,
 * the configured email recipients and whether email and R2 storage are set up.
 */
export const GET = seoRoute("reports-options", {}, async () => {
  const db = await getDb();
  const [sources, cf] = await Promise.all([discoverSources(db), discoverCrewsFlows(db)]);
  const { getSeoSettings } = await import("@/lib/seo-intel/settings");
  const { mailConfigured } = await import("@/lib/mail");
  const { storageReady } = await import("@/lib/storage");
  const s = await getSeoSettings();
  return json({
    presets: Object.entries(PRESETS).map(([key, label]) => ({ key, label })),
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, description: c.description, sources: c.sources, scoped: !!c.scoped })),
    sources,
    crews: cf.crews,
    flows: cf.flows,
    recipients: s.reports.recipients,
    mailConfigured: await mailConfigured(),
    storageReady: await storageReady().catch(() => false),
  });
});
