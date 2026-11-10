import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { deleteJob, getJob, jobVersions, updateJob } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const id = (v: string) => {
  if (!UUID.test(v)) throw new SeoApiError("Job not found.", 404, "not_found");
  return v;
};

export const GET = seoRoute<{ id: string }>("news-job", {}, async (_req, _ctx, p) => {
  const job = await getJob(id(p.id));
  if (!job) throw new SeoApiError("Job not found.", 404, "not_found");
  return json({ job, versions: await jobVersions(p.id) });
});

/** PUT — save = a new immutable version with its diff (the editor shows it). */
export const PUT = seoRoute<{ id: string }>("news-job-save", { mutating: true }, async (_req, ctx, p) => json(await updateJob(ctx.actor, id(p.id), ctx.body)));

/** DELETE — soft delete (runs and articles keep their history). */
export const DELETE = seoRoute<{ id: string }>("news-job-delete", { mutating: true }, async (_req, ctx, p) => {
  await deleteJob(ctx.actor, id(p.id));
  return json({ ok: true });
});
