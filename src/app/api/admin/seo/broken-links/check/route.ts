import { enqueueSeoJob } from "@/lib/seo-intel/jobs";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/broken-links/check — run the broken-link check now (background worker, within ~30 s). */
export const POST = seoRoute("broken-links-check", { mutating: true, rate: { max: 3, windowSeconds: 600 } }, async (_req, ctx) => {
  const queued = await enqueueSeoJob({ type: "link_check", trigger: "manual", actor: ctx.actor.label }, `seo:link_check:manual:${new Date().toISOString().slice(0, 16)}`);
  await ctx.audit("links.check", undefined, { queued });
  return json({ queued }, 202);
});
