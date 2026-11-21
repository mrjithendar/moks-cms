import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { LlmBudgetCard } from "@/components/seo/LlmBudgetCard";
import { loadLlmBudget, scopeOf } from "@/lib/llm-budget-view";

/**
 * AI & SEO settings → LLM budget: the one budget the SEO agent keeps and enforces, for the period chosen with
 * &scope=day|month (month when absent), then this site's own LLM usage this month.
 */
export default async function LlmBudgetSection(params: Record<string, string | undefined> = {}) {
  const [budget, usage] = await Promise.all([loadLlmBudget(scopeOf(params.scope)), loadClaudeUsage()]);
  return (
    <>
      <LlmBudgetCard key={budget.scope} load={budget} basePath="/admin/automation?section=llm-budget" />
      <ClaudeUsageCard data={usage} />
    </>
  );
}
