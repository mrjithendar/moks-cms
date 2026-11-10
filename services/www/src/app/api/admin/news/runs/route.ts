import { json, seoRoute, UUID } from "@/lib/seo-intel/http";
import { listRuns } from "@/lib/news/service";

export const dynamic = "force-dynamic";

/** GET ?job=&status=&trigger=&kind=&before= — run history (keyset by started_at). */
export const GET = seoRoute("news-runs", {}, async (_req, ctx) => {
  const q = ctx.query;
  const job = q.get("job");
  return json({ runs: await listRuns({ jobId: job && UUID.test(job) ? job : null, status: q.get("status"), trigger: q.get("trigger"), kind: q.get("kind"), before: q.get("before"), limit: Number(q.get("limit") ?? 50) }) });
});
