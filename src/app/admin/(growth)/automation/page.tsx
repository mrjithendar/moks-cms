import { AdminHeader } from "@/components/admin/ui";
import { AgentSettingsGroup } from "@/components/seo/AgentSettingsGroup";
import { AskBlogSettingsCard } from "@/components/seo/AskBlogSettingsCard";
import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { IntegrationStatusCard, loadConnections } from "@/components/seo/IntegrationStatus";
import { LlmBudgetsCard } from "@/components/seo/LlmBudgetsCard";
import { loadMlSettings, MlSettingsCard } from "@/components/seo/MlSettingsCard";
import { SeoAgentCard } from "@/components/seo/SeoAgentCard";
import { SettingsForm } from "@/components/seo/SettingsForm";
import { DEFAULT_ASK_SETTINGS, getAskSettings, loadAskStatus } from "@/lib/seo-agent/ask-settings";
import { askEnabled } from "@/lib/seo-agent/config";
import { agentStatus } from "@/lib/seo-agent/endpoint";
import { loadAgentSettings } from "@/lib/seo-agent/settings-client";
import { loadLlmBudgets } from "@/lib/llm-budgets-view";
import { DEFAULT_SEO_SETTINGS, getSeoSettings, publicSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Automation & AI" };

export default async function SeoSettingsPage() {
  const [s, usage, connections, ml, ask, askStatus, agent, llmBudgets, agentSettings] = await Promise.all([getSeoSettings().then(publicSettings), loadClaudeUsage(), loadConnections(), loadMlSettings(), getAskSettings(), loadAskStatus(), agentStatus(), loadLlmBudgets(), loadAgentSettings()]);
  const recall3 = ml.ragEval?.metrics["recall@3"];
  return (
    <>
      <AdminHeader title="Automation & AI" description="Search and analytics connections, the SEO agent, Claude usage, LLM budgets, agent limits, ML models and retrieval, Ask the Blog, then the settings by area: data sources, schedules (UTC), scoring, content and links, AI, crawler and reports. Saved changes are audit-logged." />
      <IntegrationStatusCard rows={connections} />
      <SeoAgentCard initial={agent} />
      <ClaudeUsageCard data={usage} />
      <LlmBudgetsCard data={llmBudgets} />
      <AgentSettingsGroup load={agentSettings} groupId="agent-limits" title="Agent limits" />
      <MlSettingsCard data={ml} />
      <AskBlogSettingsCard initial={ask} defaults={DEFAULT_ASK_SETTINGS} envEnabled={askEnabled()} status={askStatus} recall3={typeof recall3 === "number" ? recall3 : null} />
      <SettingsForm initial={s} defaults={publicSettings(DEFAULT_SEO_SETTINGS)} />
    </>
  );
}
