import { getDb } from "@/db";
import { getNewsSettings } from "./news/service";
import { getAskSettings } from "./seo-agent/ask-settings";
import { AgentError, getLlmBudgets, type AgentLlmBudgetsView } from "./seo-agent/client";
import { claudeConfig, getSeoSettings } from "./seo-intel/settings";

/**
 * Admin → Automation & AI → LLM budgets. The budgets belong to the seo-agent, which makes the SEO platform's LLM calls:
 * it stores them, validates them and checks them before every call (moks-seo-agent/app/llm_budgets.py). This page only
 * shows them, through the agent's GET /llm-budgets, and saves them through its PUT /llm-budgets. Nothing is kept here.
 *
 * Next to them it lists the feature caps that live in this app's own settings and still apply.
 */

/** A feature's own cap, shown next to the LLM budgets: both apply, and it is changed where it is shown to be. */
export type FeatureCap = { feature: string; scope: string; limit: string; where: string; href?: string };

export type LlmBudgetsView = {
  /** The agent's answer, or null with `agentError` when it cannot be reached. */
  agent: AgentLlmBudgetsView | null;
  agentError: string | null;
  /** Models the site is set up to use, listed even before their first call. */
  configuredModels: string[];
  featureCaps: FeatureCap[];
};

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function loadLlmBudgets(): Promise<LlmBudgetsView> {
  let agent: AgentLlmBudgetsView | null = null;
  let agentError: string | null = null;
  try {
    agent = await getLlmBudgets();
  } catch (e) {
    agentError = e instanceof AgentError ? e.message : "The SEO agent could not be asked.";
  }
  const configured = new Set<string>();
  const featureCaps: FeatureCap[] = [];
  try {
    const seo = await getSeoSettings();
    const claude = claudeConfig(seo);
    configured.add(claude.draftModel).add(claude.classifyModel);
    featureCaps.push({ feature: "Drafts and agent flows", scope: "all Claude calls except Ask the Blog and the news desk, per month", limit: usd(claude.monthlyBudgetUsd), where: claude.budgetSource === "env" ? "SEO_LLM_MONTHLY_BUDGET_USD, or a lower value in AI & drafts" : "Settings → AI & drafts", href: "#tab-ai" });
    featureCaps.push({ feature: "AI visibility", scope: "assistant answers, per month (recorded apart and not counted in the budgets above)", limit: usd(seo.aiVisibility.monthlyBudgetUsd), where: "Settings → AI & drafts → AI visibility", href: "#tab-ai" });
  } catch {
    /* SEO settings not readable yet: shown without them */
  }
  try {
    const ask = await getAskSettings();
    featureCaps.push({ feature: "Ask the Blog", scope: "answers to readers, per day", limit: usd(ask.dailyBudgetUsd), where: "Ask the Blog, on this page" });
  } catch {
    /* not migrated yet */
  }
  try {
    const news = await getNewsSettings(await getDb());
    for (const m of [news.writer_model, news.fast_model, news.vision_model]) configured.add(m);
    featureCaps.push({ feature: "News desk", scope: "news drafting, per day and per month", limit: `${usd(news.llm_daily_usd)} a day, ${usd(news.llm_monthly_usd)} a month`, where: "Newsroom settings", href: "/admin/news" });
  } catch {
    /* news desk not migrated */
  }
  return { agent, agentError, configuredModels: [...configured].filter(Boolean).sort(), featureCaps };
}
