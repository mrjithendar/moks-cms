import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { LlmBudgetCard } from "@/components/seo/LlmBudgetCard";
import { LlmProvidersCard } from "@/components/seo/LlmProvidersCard";
import { loadLlmBudget, scopeOf } from "@/lib/llm-budget-view";
import { loadLlmProviders } from "@/lib/llm-providers-view";
import { settingsHref } from "@/lib/settings-areas";

/**
 * Settings → AI & models → LLM providers & budget (one section since 2026-11-23; it was "LLM providers & models" and "LLM
 * budget"). Top down: the one budget the SEO agent keeps and enforces, for the period chosen with &scope=day|month
 * (month when absent); the providers, sealed keys and models with prices that the budget's spend is counted in; then
 * this site's own LLM usage this month. All three are read from (and saved in) the SEO agent, each card on its own.
 */
export default async function LlmSection(params: Record<string, string | undefined> = {}) {
  const [budget, providers, usage] = await Promise.all([loadLlmBudget(scopeOf(params.scope)), loadLlmProviders(), loadClaudeUsage()]);
  return (
    <>
      <LlmBudgetCard key={budget.scope} load={budget} basePath={settingsHref("llm")} />
      <LlmProvidersCard load={providers} />
      <ClaudeUsageCard data={usage} />
    </>
  );
}
