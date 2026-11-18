import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { addCorrection } from "@/lib/news/corrections";

export const dynamic = "force-dynamic";
const body = z.object({ note: z.string().trim().min(10).max(1000) });

/** POST — add a dated correction/update note to a published news article (dateModified + resubmission). */
export const POST = seoRoute<{ id: string }>("news-correction", { mutating: true, rate: { max: 10, windowSeconds: 300 } }, async (_req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Article not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  return json(await addCorrection(ctx.actor, p.id, b.note));
});
