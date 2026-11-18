import { AgentError, cancelRun, listRuns } from "@/lib/seo-agent/client";
import { json, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/admin/seo/agent/runs/{id}/cancel — stop the active run for a draft (or a run by id); the draft stays. */
export const POST = seoRoute<{ threadId: string }>("agent-cancel", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, { threadId }) => {
  if (!UUID.test(threadId)) throw new SeoApiError("Run not found.", 404, "not_found");
  try {
    const { items } = await listRuns({ draftId: threadId, limit: 5 });
    const active = items.find((r) => r.status === "queued" || r.status === "running");
    const r = await cancelRun(active?.run_id ?? threadId);
    await ctx.audit("agent.cancel", threadId, r);
    return json(r);
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, e.status === 404 ? 404 : 503, "agent");
    throw e;
  }
});
