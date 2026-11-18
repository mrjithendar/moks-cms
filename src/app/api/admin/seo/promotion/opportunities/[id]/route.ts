import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { opportunityPatch, updateOpportunity } from "@/lib/seo-intel/promotion/store";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/seo/promotion/opportunities/{id} — { action: save | posted | dismiss | reopen, title?, body?, postedUrl? }.
 * "posted" only records that the admin posted it themselves; the system never posts to a channel.
 */
export const PATCH = seoRoute<{ id: string }>("promotion-opportunity", { mutating: true, rate: { max: 120, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Opportunity not found.", 404, "not_found");
  const patch = parse(opportunityPatch, ctx.body);
  const change = await updateOpportunity(id, patch, ctx.actor.label);
  await ctx.audit(`promotion.${patch.action}`, id, change);
  return json(change.after);
});
