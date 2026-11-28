import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { LlmBudgetCard } from "@/components/seo/LlmBudgetCard";
import { LlmGatewayCard } from "@/components/seo/LlmGatewayCard";
import { Alert } from "@/components/ui/form";
import { gatewayKeys, llmGateway } from "@/lib/llm-gateway";
import { LlmProvidersCard } from "@/components/seo/LlmProvidersCard";
import { loadLlmBudget, scopeOf } from "@/lib/llm-budget-view";
import { loadLlmProviders } from "@/lib/llm-providers-view";
import { settingsHref } from "@/lib/settings-areas";

/**
 * Settings → AI & models → LLM providers & budget (one section since 2026-11-23; it was "LLM providers & models" and "LLM
 * budget"). Top down: the one budget the SEO agent keeps and enforces, for the period chosen with &scope=day|month
 * (month when absent); the providers, sealed keys and models with prices that the budget's spend is counted in; then
 * this site's own LLM usage this month. All three are read from (and saved in) the SEO agent, each card on its own.
 * With LiteLLM as the gateway (D-109) a LiteLLM card comes first (its keys, team and aliases, read only), the budget
 * applies only to calls outside LiteLLM, and the providers here are not used.
 */
export default async function LlmSection(params: Record<string, string | undefined> = {}) {
  const gw = llmGateway();
  const [budget, providers, usage, webKeys] = await Promise.all([loadLlmBudget(scopeOf(params.scope)), loadLlmProviders(), loadClaudeUsage(), gw ? gatewayKeys(gw) : Promise.resolve(null)]);
  const agentGateway = budget.view?.gateway ?? null;
  const onGateway = Boolean(gw || agentGateway);
  return (
    <>
      {onGateway && (
        <LlmGatewayCard
          load={{ agent: agentGateway, web: webKeys, uiUrl: process.env.LITELLM_UI_URL?.trim() || null, agentError: gw && !agentGateway && budget.view ? "The SEO agent does not use LiteLLM yet: set LITELLM_BASE_URL and LITELLM_API_KEY for its container too." : null }}
        />
      )}
      <LlmBudgetCard key={budget.scope} load={budget} basePath={settingsHref("llm")} />
      {onGateway && (
        <div className="mb-3">
          <Alert tone="info">While LiteLLM is the gateway, the providers, keys and models below are not used for calls that go through it: those are set in LiteLLM.</Alert>
        </div>
      )}
      <LlmProvidersCard load={providers} />
      <ClaudeUsageCard data={usage} />
    </>
  );
}
