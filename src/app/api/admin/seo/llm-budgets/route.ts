import { z } from "zod";
import { AgentError, putLlmBudgets } from "@/lib/seo-agent/client";
import { loadLlmBudgets } from "@/lib/llm-budgets-view";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/llm-budgets — the seo-agent's LLM budgets and spend, and this app's feature caps. */
export const GET = seoRoute("llm-budgets", {}, async () => json(await loadLlmBudgets()));

// Only the shape is checked here; the agent owns the rules (ids, ranges, how many) and answers 422 with its issues.
const limit = z.object({ daily_usd: z.number().nullable(), monthly_usd: z.number().nullable() });
const body = z.object({ models: z.record(z.string(), limit), providers: z.record(z.string(), limit) });

/**
 * PUT /api/admin/seo/llm-budgets — hand the whole set to the seo-agent (PUT /llm-budgets), which validates, stores and
 * applies it at once. Audit-logged here with what the agent stored.
 */
export const PUT = seoRoute("llm-budgets-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const next = parse(body, ctx.body);
  try {
    const saved = await putLlmBudgets(next, ctx.actor.label);
    await ctx.audit("llm_budgets.update", "llm_budgets", { after: saved.budgets });
    return json({ budgets: saved.budgets });
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, e.status === 422 ? 400 : e.status >= 500 ? 503 : e.status, e.status === 422 ? "invalid" : "agent", e.issues);
    throw e;
  }
});
