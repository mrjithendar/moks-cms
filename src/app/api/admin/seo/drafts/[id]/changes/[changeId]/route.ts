import { z } from "zod";
import { decideChange } from "@/lib/seo-intel/drafts";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ decision: z.enum(["accepted", "rejected", "pending"]), edited: z.string().max(20_000).nullable().optional() });

/** PATCH /api/admin/seo/drafts/{id}/changes/{changeId} — accept / reject / reset one change, or accept with your own text. */
export const PATCH = seoRoute<{ id: string; changeId: string }>("drafts-change", { mutating: true, rate: { max: 240, windowSeconds: 600 } }, async (_req, ctx, { id, changeId }) => {
  if (!UUID.test(id) || !/^c\d{1,3}$/.test(changeId)) throw new SeoApiError("Change not found.", 404, "not_found");
  const b = parse(body, ctx.body);
  const r = await decideChange(id, changeId, b.decision, b.edited);
  await ctx.audit("draft.change", id, { change: changeId, decision: r.change.decision, edited: Boolean(r.change.edited) });
  return json(r);
});
