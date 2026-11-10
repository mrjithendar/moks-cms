import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "@/lib/audit";
import { regenerateImage } from "@/lib/news/agent";
import { newsArticleForDraft } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("regenerate"), prompt: z.string().max(400).default(""), provider: z.enum(["gemini", "openai"]).nullable().default(null) }),
  z.object({ action: z.literal("template") }),
  z.object({ action: z.literal("choose"), imageId: z.string().regex(UUID) }),
]);

/** POST — regenerate the cover (optional prompt tweak), switch to the template cover, or pick an earlier stored cover. */
export const POST = seoRoute<{ id: string }>("news-draft-image", { mutating: true, rate: { max: 10, windowSeconds: 300 } }, async (_req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  const a = await newsArticleForDraft(p.id);
  if (!a) throw new SeoApiError("Not a news draft.", 404, "not_found");
  if (b.action === "regenerate") return json(await regenerateImage(String(a.id), ctx.actor.label, { prompt: b.prompt, provider: b.provider }), 202);
  if (b.action === "template") return json(await regenerateImage(String(a.id), ctx.actor.label, { provider: "template" }), 202);
  const img = a.images.find((i) => i.id === b.imageId && i.src);
  if (!img) throw new SeoApiError("That cover is not stored.", 404, "not_found");
  const db = await getDb();
  const r = rowsOf<{ id: string }>(await db.execute(sql`update seo_drafts set document = jsonb_set(document, '{news,image}', ${JSON.stringify({ imageId: img.id, provider: img.provider, aiGenerated: img.ai_generated, alt: img.alt, decorative: img.decorative, src: img.src, width: img.width, height: img.height, variants: {} })}::jsonb, true), updated_at = now() where id = ${p.id} and status = 'ready_for_review' returning id`));
  if (!r.length) throw new SeoApiError("The draft is not waiting for review.", 409, "conflict");
  await db.execute(sql`update news_images set selected = (id = ${b.imageId}) where article_id = ${String(a.id)}`);
  await audit(ctx.actor, "news.draft.image_choose", p.id, { imageId: b.imageId });
  return json({ ok: true });
});
