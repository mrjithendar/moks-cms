import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { ideaPatch, updateIdea } from "@/lib/seo-intel/promotion/store";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/seo/promotion/ideas/{id} — { action: calendar | save | dismiss | restore }. "calendar" adds the idea
 * to the editorial calendar as an approved item with its brief; drafting and publishing stay in the existing flow.
 */
export const PATCH = seoRoute<{ id: string }>("promotion-idea", { mutating: true, rate: { max: 120, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Idea not found.", 404, "not_found");
  const { action } = parse(ideaPatch, ctx.body);
  const r = await updateIdea(id, action);
  await ctx.audit(`promotion.idea_${action}`, id, r);
  return json(r, action === "calendar" ? 201 : 200);
});
