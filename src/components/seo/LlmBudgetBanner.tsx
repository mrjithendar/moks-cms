import Link from "next/link";
import { getLlmStatus, type AgentLlmStatus } from "@/lib/seo-agent/client";

type Spend = { spend_usd: number | null; max_budget_usd: number | null };
const usedUp = (b: Spend | null | undefined) => Boolean(b && typeof b.max_budget_usd === "number" && b.max_budget_usd > 0 && typeof b.spend_usd === "number" && b.spend_usd >= b.max_budget_usd);

/** Whose LiteLLM budget is used up (the team's first, then a key's), or null. Pure, so it can be tested. */
export function budgetStop(status: Pick<AgentLlmStatus, "team" | "keys"> | null): { who: string; spentUsd: number; limitUsd: number } | null {
  if (!status) return null;
  if (usedUp(status.team)) return { who: `the ${status.team!.alias ?? "site's"} team`, spentUsd: status.team!.spend_usd!, limitUsd: status.team!.max_budget_usd! };
  const key = status.keys.find(usedUp);
  return key ? { who: key.caller === "ask" ? "the Ask the Blog key" : `the ${key.alias ?? "SEO agent's"} key`, spentUsd: key.spend_usd!, limitUsd: key.max_budget_usd! } : null;
}

/**
 * Banner on every search/analytics admin page while a LiteLLM budget of the site is used up (D-110: budgets are
 * LiteLLM's). Read through the SEO agent's GET /llm-status; never slows or breaks the page.
 */
export async function LlmBudgetBanner() {
  let stop: ReturnType<typeof budgetStop> = null;
  try {
    stop = budgetStop(await Promise.race([getLlmStatus().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]));
  } catch {
    stop = null;
  }
  if (!stop) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
      <p className="font-medium">LLM calls paused: the LiteLLM budget of {stop.who} is used up</p>
      <p className="mt-0.5">
        ${stop.spentUsd.toFixed(2)} of ${stop.limitUsd.toFixed(2)} spent. Existing drafts can still be reviewed and approved. Raise the budget in LiteLLM, or wait for its reset (
        <Link className="underline" href="/admin/settings/ai?section=llm">Settings → AI &amp; models → LiteLLM</Link>).
      </p>
    </div>
  );
}
