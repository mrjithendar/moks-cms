import { enqueueSeoJob } from "@/lib/seo-intel/jobs";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/technical/scan — queue a crawl of the public site (own host only, ≤ 1 req/s by default). */
export const POST = seoRoute("technical-scan", { mutating: true, rate: { max: 3, windowSeconds: 3600 } }, async (_req, ctx) => {
  const queued = await enqueueSeoJob({ type: "technical_scan", trigger: "manual", actor: ctx.actor.label }, "seo:technical_scan:manual");
  await ctx.audit("technical.scan", undefined, { queued });
  return json({ queued }, 202);
});
