import { AdminHeader } from "@/components/admin/ui";
import { AskBlogSettingsCard } from "@/components/seo/AskBlogSettingsCard";
import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { IntegrationStatusCard, loadConnections } from "@/components/seo/IntegrationStatus";
import { loadMlSettings, MlSettingsCard } from "@/components/seo/MlSettingsCard";
import { SettingsForm } from "@/components/seo/SettingsForm";
import { DEFAULT_ASK_SETTINGS, getAskSettings, loadAskStatus } from "@/lib/seo-agent/ask-settings";
import { askEnabled } from "@/lib/seo-agent/config";
import { DEFAULT_SEO_SETTINGS, getSeoSettings, publicSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Automation & AI" };

export default async function SeoSettingsPage() {
  const [s, usage, connections, ml, ask, askStatus] = await Promise.all([getSeoSettings().then(publicSettings), loadClaudeUsage(), loadConnections(), loadMlSettings(), getAskSettings(), loadAskStatus()]);
  const recall3 = ml.ragEval?.metrics["recall@3"];
  return (
    <>
      <AdminHeader title="Automation & AI" description="Search and analytics connections, Claude usage, ML models and retrieval, Ask the Blog, then the settings by area: data sources, schedules (UTC), scoring, content and links, AI, crawler and reports. Saved changes are audit-logged." />
      <IntegrationStatusCard rows={connections} />
      <ClaudeUsageCard data={usage} />
      <MlSettingsCard data={ml} />
      <AskBlogSettingsCard initial={ask} defaults={DEFAULT_ASK_SETTINGS} envEnabled={askEnabled()} status={askStatus} recall3={typeof recall3 === "number" ? recall3 : null} />
      <SettingsForm initial={s} defaults={publicSettings(DEFAULT_SEO_SETTINGS)} />
    </>
  );
}
