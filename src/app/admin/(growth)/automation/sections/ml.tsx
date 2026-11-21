import { loadMlSettings, MlSettingsCard } from "@/components/seo/MlSettingsCard";

/** AI & SEO settings → ML & retrieval: the SEO models, the weights proposal and the retrieval evaluation. */
export default async function MlSection() {
  return <MlSettingsCard data={await loadMlSettings()} />;
}
