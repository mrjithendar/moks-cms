import { saveLlmBudgets } from "@/lib/llm-budgets";
import { loadLlmBudgets } from "@/lib/llm-budgets-view";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/llm-budgets — every model's and provider's limits, this month's spend, and the feature caps. */
export const GET = seoRoute("llm-budgets", {}, async () => json(await loadLlmBudgets()));

/**
 * PUT /api/admin/seo/llm-budgets — validate and save the whole document ({ models, providers }, each entry
 * { dailyUsd, monthlyUsd }, null = no limit); audit-logged with before/after. The web app checks it on every Claude
 * call; the seo-agent picks it up within its cache window (about 30 seconds).
 */
export const PUT = seoRoute("llm-budgets-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const { before, after } = await saveLlmBudgets(ctx.body, ctx.actor.id);
  await ctx.audit("llm_budgets.update", "llm_budgets", { before, after });
  return json({ budgets: after });
});
