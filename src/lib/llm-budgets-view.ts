import { getDb } from "@/db";
import { getLlmBudgets, llmSpend, type LlmBudgets, type LlmSpend } from "./llm-budgets";
import { getNewsSettings } from "./news/service";
import { getAskSettings } from "./seo-agent/ask-settings";
import { claudeConfig, getSeoSettings } from "./seo-intel/settings";

/** A feature's own cap, shown next to the LLM budgets: both apply, and it is changed where it is shown to be. */
export type FeatureCap = { feature: string; scope: string; limit: string; where: string; href?: string };

export type LlmBudgetsView = {
  budgets: LlmBudgets;
  spend: LlmSpend;
  /** Models the site is set up to use, listed even before their first call. */
  configuredModels: string[];
  featureCaps: FeatureCap[];
};

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Everything the LLM budgets card and GET /api/admin/seo/llm-budgets show. Never throws for a missing table. */
export async function loadLlmBudgets(): Promise<LlmBudgetsView> {
  const db = await getDb();
  const [budgets, spend] = await Promise.all([getLlmBudgets(db), llmSpend(db).catch(() => ({ monthStart: "", dayResetsAt: "", monthResetsAt: "", models: [], providers: [] }) as LlmSpend)]);
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
    const news = await getNewsSettings(db);
    for (const m of [news.writer_model, news.fast_model, news.vision_model]) configured.add(m);
    featureCaps.push({ feature: "News desk", scope: "news drafting, per day and per month", limit: `${usd(news.llm_daily_usd)} a day, ${usd(news.llm_monthly_usd)} a month`, where: "Newsroom settings", href: "/admin/news" });
  } catch {
    /* news desk not migrated */
  }
  return { budgets, spend, configuredModels: [...configured].filter(Boolean).sort(), featureCaps };
}
