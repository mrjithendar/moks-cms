import { z } from "zod";
import { reject } from "@/lib/seo-agent/orchestrate";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ reason: z.string().trim().max(2000).nullable().optional() });

/** POST /api/admin/seo/drafts/{id}/reject — reject the whole draft; the optional reason is kept to improve prompts. */
export const POST = seoRoute<{ id: string }>("drafts-reject", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  const r = await reject(id, ctx.actor, b.reason || null);
  await ctx.audit("draft.reject", r.article_id, { draftId: id, reason: b.reason || null });
  return json({ status: "rejected" });
});
