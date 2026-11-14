import { z } from "zod";
import { DFS_JOB_TYPES } from "@/lib/seo-intel/dataforseo";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { enqueueSeoJob } from "@/lib/seo-intel/jobs";

export const dynamic = "force-dynamic";

const body = z.object({ job: z.enum(DFS_JOB_TYPES) });

/** POST /api/admin/seo/dataforseo/run — queue a DataForSEO job now (spend still capped by the monthly budget). */
export const POST = seoRoute("dataforseo-run", { mutating: true, rate: { max: 6, windowSeconds: 3600 } }, async (_req, ctx) => {
  const { job } = parse(body, ctx.body);
  const queued = await enqueueSeoJob({ type: job, trigger: "manual", actor: ctx.actor.label }, `seo:${job}:manual`);
  await ctx.audit("dataforseo.run", job, { queued });
  return json({ queued }, 202);
});
