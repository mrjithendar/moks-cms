import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { decideProposal } from "@/lib/seo-intel/ml-admin";

export const dynamic = "force-dynamic";

const body = z.object({ decision: z.enum(["approve", "dismiss"]) });

/** POST /api/admin/seo/models/proposals/{id} — approve (the proposed weights become the scoring weights) or dismiss. */
export const POST = seoRoute<{ id: string }>("models-proposal", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Proposal not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  const r = await decideProposal(id, b.decision, ctx.actor.id);
  if (!r) throw new SeoApiError("Proposal not found or already decided.", 409, "conflict");
  const weights = (v: unknown) => (v as { weights?: unknown } | undefined)?.weights ?? null;
  await ctx.audit(`ml.weights.${b.decision}`, id, { modelVersion: r.modelVersion, before: weights(r.settingsChange?.before), after: weights(r.settingsChange?.after) });
  return json({ id: r.id, decision: r.decision });
});
