import { getRun } from "@/lib/news-agent/client";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET — a news flow run's status and result (the playground polls this; its output is never saved as a draft). */
export const GET = seoRoute<{ id: string }>("news-flow-run", {}, async (_req, _ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Run not found.", 404, "not_found");
  const r = await getRun(p.id);
  if (!r.flow.startsWith("news_")) throw new SeoApiError("Run not found.", 404, "not_found");
  const st = (r.state ?? {}) as { result?: unknown; news_run_id?: string; errors?: string[] };
  return json({ status: r.status, outcome: r.outcome, result: st.result ?? null, newsRunId: st.news_run_id ?? null, errors: st.errors ?? [], error: r.error });
});
