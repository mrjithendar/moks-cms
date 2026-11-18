import { z } from "zod";
import { AgentError, kickoff } from "@/lib/seo-agent/client";
import { orchestrator } from "@/lib/seo-agent/endpoint";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { getPromotionSettings } from "@/lib/seo-intel/promotion/settings";

export const dynamic = "force-dynamic";

const body = z.object({ kind: z.enum(["opportunities", "ideas"]), articleId: z.string().uuid().optional() }).strict();

/**
 * POST /api/admin/seo/promotion/run — { kind: "opportunities", articleId? } starts promotion_flow (score channels, draft
 * posts for review); { kind: "ideas" } starts content_ideas_flow. Both are CrewAI flows in the seo-agent, the same ones
 * their CronJobs start; they end with drafts and ideas waiting for a person and never post anything.
 */
export const POST = seoRoute("promotion-run", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  if (!(await getPromotionSettings()).enabled) throw new SeoApiError("Promotion is switched off in its settings.", 409, "disabled");
  if ((await orchestrator()) !== "crewai") throw new SeoApiError("Promotion runs as CrewAI flows, and the SEO agent is disabled (Automation & AI → SEO agent).", 409, "orchestrator");
  try {
    const r = b.kind === "ideas" ? await kickoff("content_ideas_flow", {}, { actor: ctx.actor.label }) : await kickoff("promotion_flow", b.articleId ? { article_id: b.articleId } : {}, { actor: ctx.actor.label });
    await ctx.audit("promotion.run", b.articleId, { kind: b.kind, runId: r.run_id, existing: r.existing });
    return json(r, 202);
  } catch (e) {
    if (e instanceof AgentError) throw new SeoApiError(e.message, 503, "agent_unavailable");
    throw e;
  }
});
