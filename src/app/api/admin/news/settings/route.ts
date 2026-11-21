import { z } from "zod";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { styleReview } from "@/lib/news/agent";
import { getNewsSettings, saveNewsSettings } from "@/lib/news/service";
import { newsDeskState } from "@/lib/news/schema";

export const dynamic = "force-dynamic";

export const GET = seoRoute("news-settings", {}, async () => {
  const settings = await getNewsSettings();
  const desk = newsDeskState(settings);
  return json({ settings, desk, envEnabled: desk.envValue === "true", imageProviderEnv: process.env.NEWS_IMAGE_PROVIDER ?? null });
});
export const PUT = seoRoute("news-settings-save", { mutating: true }, async (_req, ctx) => json({ settings: await saveNewsSettings(ctx.actor, ctx.body) }));
/** POST {action: "style_review", profileKey?} — run the style review now (it only proposes a new profile version). */
export const POST = seoRoute("news-style-review", { mutating: true, rate: { max: 3, windowSeconds: 300 } }, async (_req, ctx) => {
  const b = parse(z.object({ action: z.literal("style_review"), profileKey: z.string().max(42).nullable().default(null) }), ctx.body ?? {});
  return json(await styleReview(b.profileKey, ctx.actor.label), 202);
});
