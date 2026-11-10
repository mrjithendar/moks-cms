import { AdminHeader } from "@/components/admin/ui";
import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { SettingsForm } from "@/components/seo/SettingsForm";
import { getSeoSettings, publicSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Settings" };

export default async function SeoSettingsPage() {
  const [s, usage] = await Promise.all([getSeoSettings().then(publicSettings), loadClaudeUsage()]);
  return (
    <>
      <AdminHeader title="SEO settings" description="Properties, schedules (UTC), scoring weights, rule thresholds, crawler limits, optional LLM enrichment and report recipients. Saved changes are audit-logged." />
      <ClaudeUsageCard data={usage} />
      <SettingsForm initial={s} />
    </>
  );
}
