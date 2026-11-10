import { AdminHeader } from "@/components/admin/ui";
<<<<<<< HEAD
import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
import { SettingsForm } from "@/components/seo/SettingsForm";
import { getSeoSettings, publicSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Settings" };

export default async function SeoSettingsPage() {
<<<<<<< HEAD
  const [s, usage] = await Promise.all([getSeoSettings().then(publicSettings), loadClaudeUsage()]);
  return (
    <>
      <AdminHeader title="SEO settings" description="Properties, schedules (UTC), scoring weights, rule thresholds, crawler limits, optional LLM enrichment and report recipients. Saved changes are audit-logged." />
      <ClaudeUsageCard data={usage} />
=======
  const s = publicSettings(await getSeoSettings());
  return (
    <>
      <AdminHeader title="SEO settings" description="Properties, schedules (UTC), scoring weights, rule thresholds, crawler limits, optional LLM enrichment and report recipients. Saved changes are audit-logged." />
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
      <SettingsForm initial={s} />
    </>
  );
}
