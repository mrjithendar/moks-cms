import { AdminHeader } from "@/components/admin/ui";
import { NewsAgentCard } from "@/components/news/NewsAgentCard";
import { NewsSettingsForm } from "@/components/news/NewsSettingsForm";
import { AgentSettingsGroup, NEWS_AGENT_SETTINGS } from "@/components/seo/AgentSettingsGroup";
import { newsAgentStatus } from "@/lib/news-agent/endpoint";
import { loadNewsAgentSettings } from "@/lib/news-agent/settings-client";
import { getNewsSettings } from "@/lib/news/service";
import { newsDeskState, newsDeskStateText } from "@/lib/news/schema";

export const metadata = { title: "Settings" };

export default async function NewsSettingsPage() {
  const [s, agent] = await Promise.all([getNewsSettings(), newsAgentStatus()]);
  const agentSettings = agent.enabled ? await loadNewsAgentSettings() : null;
  return (
    <>
      <AdminHeader title="News desk settings" description="Global caps apply on top of each job's own budget. Defaults keep spend small (the news agent's docs/COSTS.md)." />
      <NewsAgentCard initial={JSON.parse(JSON.stringify(agent))} />
      {agentSettings?.view?.groups.map((g) => <AgentSettingsGroup key={g.id} load={agentSettings} groupId={g.id} title={`News agent · ${g.title}`} agent={NEWS_AGENT_SETTINGS} />)}
      {agentSettings && !agentSettings.view && <AgentSettingsGroup load={agentSettings} groupId="news-agent-llm" title="News agent settings" agent={NEWS_AGENT_SETTINGS} />}
      <NewsSettingsForm initial={JSON.parse(JSON.stringify(s))} desk={{ ...newsDeskState(s), text: newsDeskStateText(newsDeskState(s)) }} envProvider={process.env.NEWS_IMAGE_PROVIDER ?? null} />
    </>
  );
}
