import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { proposeOptimizations } from "@/lib/seo-intel/optimize";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/articles/{id}/optimize — (re)generate field-level proposals. Proposals only; nothing is applied. */
export const POST = seoRoute<{ id: string }>("article-optimize", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Article not found.", 404, "not_found");
  const proposals = await proposeOptimizations(id);
  await ctx.audit("optimization.generate", id, { proposals });
  return json({ proposals });
});
