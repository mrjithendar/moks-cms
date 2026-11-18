import { enqueueSeoJob } from "@/lib/seo-intel/jobs";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/recommendations/generate — queue a rules (+ optional LLM) run. Works with the LLM disabled. */
export const POST = seoRoute("recommendations-generate", { mutating: true, rate: { max: 5, windowSeconds: 600 } }, async (_req, ctx) => {
  const queued = await enqueueSeoJob({ type: "recommendations", trigger: "manual", actor: ctx.actor.label }, "seo:recommendations:manual");
  await ctx.audit("recommendations.generate", undefined, { queued });
  return json({ queued }, 202);
});
