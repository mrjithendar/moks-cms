import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { acceptOptimization, rejectOptimization, rollbackOptimization } from "@/lib/seo-intel/optimize";

export const dynamic = "force-dynamic";

const body = z.object({ action: z.enum(["accept", "reject", "rollback"]) });

/**
 * PATCH /api/admin/seo/optimizations/{id} — { action: accept | reject | rollback }.
 * accept writes the value into YOUR editor working copy (autosave); it never edits or publishes the post.
 */
export const PATCH = seoRoute<{ id: string }>("optimization-patch", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Proposal not found.", 404, "not_found");
  const { action } = parse(body, ctx.body);
  const result = action === "accept" ? await acceptOptimization(id, ctx.actor) : action === "reject" ? await rejectOptimization(id, ctx.actor) : await rollbackOptimization(id, ctx.actor);
  await ctx.audit(`optimization.${action}`, id, result);
  return json(result);
});
