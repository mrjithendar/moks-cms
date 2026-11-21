import { JobSettingsCard } from "@/components/news/JobSettingsCard";
import { getNewsSettings } from "@/lib/news/service";
import { SeoArea } from "./seo-area";

/** AI & SEO settings → Run history: the "runs" area of the SEO settings document, then how long job run logs are kept. */
export default async function SeoRunsSection() {
  return (
    <>
      {await SeoArea({ area: "runs" })}
      <JobSettingsCard group="logs" initial={JSON.parse(JSON.stringify(await getNewsSettings()))} />
    </>
  );
}
