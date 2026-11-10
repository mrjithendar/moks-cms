import { AgentError, getRun } from "@/lib/seo-agent/client";
import { json, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const THREAD = /^[A-Za-z0-9:_-]{1,80}$/;

/** GET /api/admin/seo/agent/runs/{threadId} — graph state for the review UI (status, current node, interrupt). */
export const GET = seoRoute<{ threadId: string }>("agent-run", {}, async (_req, _ctx, { threadId }) => {
  if (!THREAD.test(threadId)) throw new SeoApiError("Run not found.", 404, "not_found");
  try {
    return json(await getRun(threadId));
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, e.status === 404 ? 404 : 503, e.status === 404 ? "not_found" : "agent_unavailable");
    throw e;
  }
});
