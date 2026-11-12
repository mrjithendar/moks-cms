import { json, seoRoute } from "@/lib/seo-intel/http";
import { getPromotionSettings, savePromotionSettings } from "@/lib/seo-intel/promotion/settings";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/promotion/settings — channels, subreddits, link tags and limits (no credential is stored here). */
export const GET = seoRoute("promotion-settings", {}, async () => json(await getPromotionSettings()));

/** PUT /api/admin/seo/promotion/settings — validate and save the whole document; audit-logged with before/after. */
export const PUT = seoRoute("promotion-settings-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const { before, after } = await savePromotionSettings(ctx.body, ctx.actor.id);
  await ctx.audit("promotion.settings", "promotion", { before, after });
  return json(after);
});
