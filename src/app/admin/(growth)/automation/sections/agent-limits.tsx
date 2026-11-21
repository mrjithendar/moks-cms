import { JobSettingsCard } from "@/components/news/JobSettingsCard";
import { AgentSettingsGroup } from "@/components/seo/AgentSettingsGroup";
import { getNewsSettings } from "@/lib/news/service";
import { loadAgentSettings } from "@/lib/seo-agent/settings-client";

/**
 * AI & SEO settings → Agent limits: the SEO agent's own settings store (its group "agent-limits"), then the limits
 * every crew job shares (setting row `news`, lib/news/settings-fields.ts).
 */
export default async function AgentLimitsSection() {
  const [agent, jobs] = await Promise.all([loadAgentSettings(), getNewsSettings()]);
  return (
    <>
      <AgentSettingsGroup load={agent} groupId="agent-limits" title="Agent limits" />
      <JobSettingsCard group="limits" initial={JSON.parse(JSON.stringify(jobs))} />
    </>
  );
}
