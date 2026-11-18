import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { approveReview, kindSchema, overrideSchema, setOverride } from "@/lib/seo-intel/ml-admin";

export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/seo/models/{kind} — { override?: auto|rule|model, approveReview?: true }.
 * override: what the site uses (auto = the activation rule decides). approveReview: the owner's sign-off where the
 * activation rule needs one (decay's back-test); the version is activated only if it beats the rule. Audit-logged.
 */
export const PUT = seoRoute<{ kind: string }>("models-put", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx, { kind }) => {
  const k = kindSchema.safeParse(kind);
  if (!k.success) throw new SeoApiError("Model not found.", 404, "not_found");
  const b = parse(overrideSchema, ctx.body ?? {});
  const out: Record<string, unknown> = {};
  if (b.override) {
    const change = await setOverride(k.data, b.override, ctx.actor.label);
    out.override = change;
    await ctx.audit("ml.override", k.data, change);
  }
  if (b.approveReview) {
    const review = await approveReview(k.data, ctx.actor.label);
    out.review = review;
    await ctx.audit("ml.review", k.data, review);
  }
  return json(out);
});
