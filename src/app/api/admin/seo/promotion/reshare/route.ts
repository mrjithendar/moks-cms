import { z } from "zod";
import { AgentError, kickoff } from "@/lib/seo-agent/client";
import { orchestrator } from "@/lib/seo-agent/endpoint";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { getPromotionSettings } from "@/lib/seo-intel/promotion/settings";
import { reopenForReshare } from "@/lib/seo-intel/promotion/strategies";

export const dynamic = "force-dynamic";

const body = z.object({ articleId: z.string().uuid() }).strict();

/**
 * POST /api/admin/seo/promotion/reshare { articleId } — reopen the article's channels shared more than 90 days ago and,
 * with the SEO agent, draft fresh posts for them (promotion_flow). The drafts wait for review; nothing is posted.
 */
export const POST = seoRoute("promotion-reshare", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  if (!(await getPromotionSettings()).enabled) throw new SeoApiError("Promotion is switched off in its settings.", 409, "disabled");
  const reopened = await reopenForReshare(b.articleId);
  let runId: string | null = null;
  if ((await orchestrator()) === "crewai") {
    try {
      runId = (await kickoff("promotion_flow", { article_id: b.articleId }, { actor: ctx.actor.label })).run_id;
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
    }
  }
  await ctx.audit("promotion.reshare", b.articleId, { reopened, runId });
  return json({ reopened, drafting: Boolean(runId) }, 202);
});
