import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { rollbackDraft } from "@/lib/seo-intel/publish";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/drafts/{id}/rollback — restore the previous revision, then verify and submit again. */
export const POST = seoRoute<{ id: string }>("drafts-rollback", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  return json(await rollbackDraft(id, ctx.actor));
});
