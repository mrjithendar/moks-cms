import { z } from "zod";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { labelPatchSchema, listLabels, saveLabel } from "@/lib/seo-intel/ml-admin";

export const dynamic = "force-dynamic";

const q = z.object({ task: z.enum(["cluster", "intent_check"]).default("cluster"), status: z.enum(["pending", "confirmed", "changed", "skipped"]).optional() });

/** GET /api/admin/seo/models/labels?task=cluster|intent_check&status= — the owner's labelling tasks. */
export const GET = seoRoute("models-labels", {}, async (req) => {
  const p = parse(q, Object.fromEntries(new URL(req.url).searchParams));
  return json(await listLabels(p.task, p.status));
});

/** PATCH /api/admin/seo/models/labels — { id, status: confirmed|changed|skipped|pending, label? }. Audit-logged. */
export const PATCH = seoRoute("models-labels-patch", { mutating: true, rate: { max: 600, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(labelPatchSchema, ctx.body);
  const r = await saveLabel(b, ctx.actor.label);
  if (!r) throw new SeoApiError("Label task not found (or a changed label is missing).", 404, "not_found");
  await ctx.audit("ml.label", String(b.id), r);
  return json(r);
});
