import { json, seoRoute } from "@/lib/seo-intel/http";
import { getSeoSettings, publicSettings, saveSeoSettings } from "@/lib/seo-intel/settings";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/settings — weights, schedules, thresholds, recipients, LLM provider (the key only as a flag). */
export const GET = seoRoute("settings", {}, async () => json(publicSettings(await getSeoSettings())));

/**
 * PUT /api/admin/seo/settings — validate and save the whole document, or with `only: [section, …]` just those sections
 * laid over the stored one; audit-logged with before/after (no secrets).
 */
export const PUT = seoRoute("settings-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const { before, after } = await saveSeoSettings(ctx.body, ctx.actor.id);
  await ctx.audit("settings.update", "seo", { before, after });
  return json(after);
});
