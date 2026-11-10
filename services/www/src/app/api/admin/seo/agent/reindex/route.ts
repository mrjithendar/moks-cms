import { z } from "zod";
import { AgentError, reindex } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ full: z.boolean().default(false), articleIds: z.array(z.string().uuid()).max(100).optional() });

/** POST /api/admin/seo/agent/reindex — embeddings reindex (incremental unless full). Admin only, rate-limited. */
export const POST = seoRoute("agent-reindex", { mutating: true, rate: { max: 6, windowSeconds: 3600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body ?? {});
  try {
    const r = await reindex({ full: b.full, article_ids: b.articleIds });
    await ctx.audit("agent.reindex", undefined, { full: b.full, ...r });
    return json(r);
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, e.status === 429 || e.status === 409 ? e.status : 503, "agent");
    throw e;
  }
});
