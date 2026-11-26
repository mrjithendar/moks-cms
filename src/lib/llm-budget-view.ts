import { AgentError, getLlmBudget, type AgentLlmBudgetView, type AgentLlmScope } from "./seo-agent/client";

/**
 * Admin → AI & SEO → Settings → LLM providers & budget (the budget card). The budget belongs to the seo-agent, which makes the LLM calls: it stores
 * it, validates a save and checks it before every call (seo-agent/app/llm_budgets.py). This page only shows it,
 * through the agent's GET /llm-budget, and saves it through its PUT /llm-budget. Nothing is kept here.
 */
export type LlmBudgetLoad = {
  /** The agent's answer for the chosen period, or null with `error` when it cannot be asked. */
  view: AgentLlmBudgetView | null;
  error: string | null;
  /** The agent answered, but it is a release from before the one budget. */
  tooOld: boolean;
  scope: AgentLlmScope;
};

export const BUDGET_TOO_OLD = "This needs a newer seo-agent: the one running still has a limit per model and per provider, not the one LLM budget. Release and restart the seo-agent.";

export const scopeOf = (v: string | null | undefined): AgentLlmScope => (v === "day" ? "day" : "month");

export async function loadLlmBudget(scope: AgentLlmScope): Promise<LlmBudgetLoad> {
  try {
    const view = await getLlmBudget(scope);
    if (!view || typeof view.spent_usd !== "number" || !view.budget) return { view: null, error: BUDGET_TOO_OLD, tooOld: true, scope };
    return { view, error: null, tooOld: false, scope };
  } catch (e) {
    if (e instanceof AgentError && (e.status === 404 || e.status === 405)) return { view: null, error: BUDGET_TOO_OLD, tooOld: true, scope };
    return { view: null, error: e instanceof AgentError ? e.message : "The SEO agent could not be asked.", tooOld: false, scope };
  }
}
