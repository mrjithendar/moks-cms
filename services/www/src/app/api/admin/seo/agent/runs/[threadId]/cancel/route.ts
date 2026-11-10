import { AgentError, cancelRun } from "@/lib/seo-agent/client";
import { json, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/agent/runs/{threadId}/cancel — stop a run (its draft stays as it is). */
export const POST = seoRoute<{ threadId: string }>("agent-cancel", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, { threadId }) => {
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(threadId)) throw new SeoApiError("Run not found.", 404, "not_found");
  try {
    const r = await cancelRun(threadId);
    await ctx.audit("agent.cancel", threadId, r);
    return json(r);
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, e.status === 404 ? 404 : 503, "agent");
    throw e;
  }
});
