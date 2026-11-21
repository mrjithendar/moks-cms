import { JobSettingsCard } from "@/components/news/JobSettingsCard";
import { AgentSettingsGroup } from "@/components/seo/AgentSettingsGroup";
import { loadMlSettings, MlSettingsCard } from "@/components/seo/MlSettingsCard";
import { getNewsSettings } from "@/lib/news/service";
import { loadAgentSettings } from "@/lib/seo-agent/settings-client";

/**
 * AI & SEO settings → ML & retrieval: the SEO models, the weights proposal and the retrieval evaluation, then the
 * SEO agent's own groups "retrieval" and "embeddings" (its settings store; an older agent says so), then how crew jobs
 * classify content topics and when their ranker trains (setting row `news`).
 */
export default async function MlSection() {
  const [ml, agent, jobs] = await Promise.all([loadMlSettings(), loadAgentSettings(), getNewsSettings()]);
  return (
    <>
      <MlSettingsCard data={ml} />
      <AgentSettingsGroup load={agent} groupId="retrieval" title="Retrieval" />
      <AgentSettingsGroup load={agent} groupId="embeddings" title="Embeddings" />
      <JobSettingsCard group="ranking" initial={JSON.parse(JSON.stringify(jobs))} />
    </>
  );
}
