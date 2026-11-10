import { AgentError, getRun, listRuns } from "@/lib/seo-agent/client";
import { json, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/seo/agent/runs/{id} — the latest flow run for a draft (the review UI passes the draft id), or one
 * run by its run id: status, current step, outcome, error, cost.
 */
export const GET = seoRoute<{ threadId: string }>("agent-run", {}, async (_req, _ctx, { threadId }) => {
  if (!UUID.test(threadId)) throw new SeoApiError("Run not found.", 404, "not_found");
  try {
    const { items } = await listRuns({ draftId: threadId, limit: 1 });
    if (items[0]) return json(items[0]);
    return json(await getRun(threadId));
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, e.status === 404 ? 404 : 503, e.status === 404 ? "not_found" : "agent_unavailable");
    throw e;
  }
});
