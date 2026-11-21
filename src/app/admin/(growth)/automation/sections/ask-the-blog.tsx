import { AskBlogSettingsCard } from "@/components/seo/AskBlogSettingsCard";
import { loadMlSettings } from "@/components/seo/MlSettingsCard";
import { DEFAULT_ASK_SETTINGS, getAskSettings, loadAskStatus } from "@/lib/seo-agent/ask-settings";
import { askEnabled } from "@/lib/seo-agent/config";

/** AI & SEO settings → Ask the Blog: the assistant's switch, who may use it, its limits and wording. */
export default async function AskTheBlogSection() {
  const [ask, status, ml] = await Promise.all([getAskSettings(), loadAskStatus(), loadMlSettings()]);
  const recall3 = ml.ragEval?.metrics["recall@3"];
  return <AskBlogSettingsCard initial={ask} defaults={DEFAULT_ASK_SETTINGS} envEnabled={askEnabled()} status={status} recall3={typeof recall3 === "number" ? recall3 : null} />;
}
