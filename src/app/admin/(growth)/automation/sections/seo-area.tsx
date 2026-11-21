import { SettingsForm } from "@/components/seo/SettingsForm";
import { DEFAULT_SEO_SETTINGS, getSeoSettings, publicSettings } from "@/lib/seo-intel/settings";

/**
 * One area of the SEO settings document (a tab id from lib/seo-intel/settings-meta.ts) as a section of its own. It
 * saves only that area's fields. The files next to this one name the area each; add a field in settings.ts, not here.
 */
export async function SeoArea({ area }: { area: string }) {
  const s = publicSettings(await getSeoSettings());
  return <SettingsForm key={area} initial={s} defaults={publicSettings(DEFAULT_SEO_SETTINGS)} only={area} />;
}
