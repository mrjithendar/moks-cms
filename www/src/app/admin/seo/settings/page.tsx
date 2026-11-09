import { AdminHeader } from "@/components/admin/ui";
import { SettingsForm } from "@/components/seo/SettingsForm";
import { getSeoSettings, publicSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Settings" };

export default async function SeoSettingsPage() {
  const s = publicSettings(await getSeoSettings());
  return (
    <>
      <AdminHeader title="SEO settings" description="Properties, schedules (UTC), scoring weights, rule thresholds, crawler limits, optional LLM enrichment and report recipients. Saved changes are audit-logged." />
      <SettingsForm initial={s} />
    </>
  );
}
