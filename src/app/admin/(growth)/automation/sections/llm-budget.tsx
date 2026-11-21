import { ClaudeUsageCard, loadClaudeUsage } from "@/components/seo/ClaudeUsage";
import { LlmBudgetsCard } from "@/components/seo/LlmBudgetsCard";
import { loadLlmBudgets } from "@/lib/llm-budgets-view";

/** AI & SEO settings → LLM budget: this month's Claude usage, then the budgets the SEO agent keeps and enforces. */
export default async function LlmBudgetSection() {
  const [usage, budgets] = await Promise.all([loadClaudeUsage(), loadLlmBudgets()]);
  return (
    <>
      <ClaudeUsageCard data={usage} />
      <LlmBudgetsCard data={budgets} />
    </>
  );
}
