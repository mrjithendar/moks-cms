import { z } from "zod";
import { regenerate } from "@/lib/seo-agent/orchestrate";
import { getDraft } from "@/lib/seo-intel/drafts";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/drafts/{id}/regenerate — replace the pending changes with a fresh generation (synchronous API). */
const body = z.object({ feedback: z.string().trim().max(2000).nullable().optional() });

export const POST = seoRoute<{ id: string }>("drafts-regenerate", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const d = await getDraft(id);
  if (!d) throw new SeoApiError("Draft not found.", 404, "not_found");
  if (!["ready_for_review", "generation_failed"].includes(d.status)) throw new SeoApiError(`This draft is ${d.status.replace(/_/g, " ")}.`, 409, "conflict");
  const b = parse(body, ctx.body ?? {});
  const r = await regenerate(id, ctx.actor, b.feedback || null);
  await ctx.audit("draft.regenerate", d.article_id, { draftId: id, ...r });
  return json(r, 202);
});
