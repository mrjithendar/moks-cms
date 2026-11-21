import { z } from "zod";
import { BUDGET_TOO_OLD, loadLlmBudget, scopeOf } from "@/lib/llm-budget-view";
import { AgentError, putLlmBudget } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/llm-budget?scope=day|month — the seo-agent's one LLM budget and the period's spend. */
export const GET = seoRoute("llm-budget", {}, async (req) => json(await loadLlmBudget(scopeOf(new URL(req.url).searchParams.get("scope")))));

// Only the shape is checked here; the agent owns the rules (ranges) and answers 422 with its issues.
const body = z.object({ daily_usd: z.number().nullable(), monthly_usd: z.number().nullable() });

/**
 * PUT /api/admin/seo/llm-budget — hand both limits to the seo-agent (PUT /llm-budget), which validates, stores and
 * applies them at once. Audit-logged here with what the agent stored.
 */
export const PUT = seoRoute("llm-budget-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const next = parse(body, ctx.body);
  try {
    const saved = await putLlmBudget(next, ctx.actor.label);
    await ctx.audit("llm_budget.update", "llm_budget", { after: saved.budget });
    return json({ budget: saved.budget });
  } catch (e) {
    if (e instanceof AgentError) {
      if (e.status === 404 || e.status === 405) throw new SeoApiError(BUDGET_TOO_OLD, 503, "agent");
      throw new SeoApiError(e.message, e.status === 422 ? 400 : e.status >= 500 ? 503 : e.status, e.status === 422 ? "invalid" : "agent", e.issues);
    }
    throw e;
  }
});
