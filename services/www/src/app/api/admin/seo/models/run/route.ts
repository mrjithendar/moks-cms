import { z } from "zod";
import { AgentError, kickoff } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({
  models: z.array(z.enum(["decay", "query_clusters", "intent", "priority", "related", "rag_eval"])).max(6).optional(),
  suggestLabels: z.boolean().optional(),
});

/** POST /api/admin/seo/models/run — start seo_ml_flow now (the weekly CronJob runs it too). suggestLabels: ask Claude
 * to suggest groupings for the 200-query labelling sample (once; the owner confirms them). */
export const POST = seoRoute("models-run", { mutating: true, rate: { max: 6, windowSeconds: 3600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body ?? {});
  try {
    const r = await kickoff("seo_ml_flow", { ...(b.models?.length ? { models: b.models } : {}), ...(b.suggestLabels ? { suggest_labels: true } : {}) }, { actor: ctx.actor.label });
    await ctx.audit("ml.run", undefined, { runId: r.run_id, existing: r.existing, models: b.models ?? "all", suggestLabels: Boolean(b.suggestLabels) });
    return json(r, r.existing ? 200 : 202);
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, e.status === 429 || e.status === 409 ? e.status : 503, "agent");
    throw e;
  }
});
