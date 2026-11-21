import { AgentSettingsGroup } from "@/components/seo/AgentSettingsGroup";
import { loadAgentSettings } from "@/lib/seo-agent/settings-client";

/** AI & SEO settings → Agent limits: drawn from the SEO agent's own settings store (its group "agent-limits"). */
export default async function AgentLimitsSection() {
  return <AgentSettingsGroup load={await loadAgentSettings()} groupId="agent-limits" title="Agent limits" />;
}
