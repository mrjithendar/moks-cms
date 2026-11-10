import { getDraft, queueDraft } from "@/lib/seo-intel/drafts";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/drafts/{id}/regenerate — replace the pending changes with a fresh generation (synchronous API). */
export const POST = seoRoute<{ id: string }>("drafts-regenerate", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const d = await getDraft(id);
  if (!d) throw new SeoApiError("Draft not found.", 404, "not_found");
  if (!["ready_for_review", "generation_failed"].includes(d.status)) throw new SeoApiError(`This draft is ${d.status.replace(/_/g, " ")}.`, 409, "conflict");
  const queued = await queueDraft(d.article_id, { mode: "regenerate", trigger: "manual", actor: ctx.actor.label });
  await ctx.audit("draft.regenerate", d.article_id, { draftId: id, queued });
  return json({ queued }, 202);
});
