import { AgentSettingsGroup } from "@/components/seo/AgentSettingsGroup";
import { loadMlSettings, MlSettingsCard } from "@/components/seo/MlSettingsCard";
import { loadAgentSettings } from "@/lib/seo-agent/settings-client";

/**
 * AI & SEO settings → ML & retrieval: the SEO models, the weights proposal and the retrieval evaluation, then the
 * SEO agent's own groups "retrieval" and "embeddings" (its settings store; an older agent says so).
 */
export default async function MlSection() {
  const [ml, agent] = await Promise.all([loadMlSettings(), loadAgentSettings()]);
  return (
    <>
      <MlSettingsCard data={ml} />
      <AgentSettingsGroup load={agent} groupId="retrieval" title="Retrieval" />
      <AgentSettingsGroup load={agent} groupId="embeddings" title="Embeddings" />
    </>
  );
}
