import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { patchSchema, updateRecommendation } from "@/lib/seo-intel/recommendations";

export const dynamic = "force-dynamic";

/** PATCH /api/admin/seo/recommendations/{id} — { reviewStatus?, implementationStatus?, note? }. Audit-logged with before/after. */
export const PATCH = seoRoute<{ id: string }>("recommendations-patch", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Recommendation not found.", 404, "not_found");
  const patch = parse(patchSchema, ctx.body);
  const change = await updateRecommendation(id, patch, ctx.actor.label);
  await ctx.audit("recommendation.update", id, change);
  return json(change.after);
});
