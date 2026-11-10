import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { retryRun } from "@/lib/news/agent";
import { runDetail } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const body = z.object({ mode: z.enum(["failed", "rerun"]) });

export const GET = seoRoute<{ id: string }>("news-run", {}, async (_req, _ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Run not found.", 404, "not_found");
  const d = await runDetail(p.id);
  if (!d) throw new SeoApiError("Run not found.", 404, "not_found");
  return json(d);
});

/** POST {mode: failed|rerun} — retry the failed drafts of this run, or rerun the whole job. Both are idempotent. */
export const POST = seoRoute<{ id: string }>("news-run-retry", { mutating: true, rate: { max: 10, windowSeconds: 60 } }, async (_req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Run not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  const d = await runDetail(p.id);
  const jobId = d?.run.job_id as string | null;
  if (!jobId) throw new SeoApiError("Only job runs can be retried.", 409, "conflict");
  const { runJob } = await import("@/lib/news/agent");
  return json(b.mode === "failed" ? await retryRun(jobId, p.id, ctx.actor.label) : await runJob(jobId, ctx.actor.label), 202);
});
