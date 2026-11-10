import { json, seoRoute } from "@/lib/seo-intel/http";
import { createJob, ensureNewsDefaults, listJobs } from "@/lib/news/service";

export const dynamic = "force-dynamic";

/** GET /api/admin/news/jobs — jobs with last run, today's drafts vs cap, month-to-date cost, next run. */
export const GET = seoRoute("news-jobs", {}, async () => {
  await ensureNewsDefaults();
  return json({ jobs: await listJobs() });
});

/** POST /api/admin/news/jobs — create (version 1). */
export const POST = seoRoute("news-jobs-create", { mutating: true }, async (_req, ctx) => json({ job: await createJob(ctx.actor, ctx.body) }, 201));
