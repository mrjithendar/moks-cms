import { AdminHeader } from "@/components/admin/ui";
import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { IntegrationStatusCard, loadConnections } from "@/components/seo/IntegrationStatus";
import { loadMlSettings, MlSettingsCard } from "@/components/seo/MlSettingsCard";
import { SettingsForm } from "@/components/seo/SettingsForm";
import { DEFAULT_SEO_SETTINGS, getSeoSettings, publicSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Automation & AI" };

export default async function SeoSettingsPage() {
  const [s, usage, connections, ml] = await Promise.all([getSeoSettings().then(publicSettings), loadClaudeUsage(), loadConnections(), loadMlSettings()]);
  return (
    <>
      <AdminHeader title="Automation & AI" description="Search and analytics connections, Claude usage, ML models and retrieval, then the settings by area: data sources, schedules (UTC), scoring, content and links, AI, crawler and reports. Saved changes are audit-logged." />
      <IntegrationStatusCard rows={connections} />
      <ClaudeUsageCard data={usage} />
      <MlSettingsCard data={ml} />
      <SettingsForm initial={s} defaults={publicSettings(DEFAULT_SEO_SETTINGS)} />
    </>
  );
}
