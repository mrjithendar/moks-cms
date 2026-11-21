import { JobSettingsCard } from "@/components/news/JobSettingsCard";
import { getNewsSettings } from "@/lib/news/service";
import { SeoArea } from "./seo-area";

/**
 * AI & SEO settings → AI and drafts: the "ai" area of the SEO settings document, then the models and quality gates
 * every crew job starts from (setting row `news`, lib/news/settings-fields.ts; a job can name its own models).
 */
export default async function SeoAiSection() {
  const jobs = JSON.parse(JSON.stringify(await getNewsSettings())) as Record<string, unknown>;
  const env = process.env.NEWS_IMAGE_PROVIDER;
  return (
    <>
      {await SeoArea({ area: "ai" })}
      <JobSettingsCard group="models" initial={jobs} hints={env ? { image_provider: `NEWS_IMAGE_PROVIDER=${env} in the deployment overrides this.` } : {}} />
      <JobSettingsCard group="quality" initial={jobs} />
    </>
  );
}
