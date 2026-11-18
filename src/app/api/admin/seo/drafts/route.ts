import { z } from "zod";
import { DRAFT_CATEGORIES } from "@/lib/seo-intel/settings";
import { requestDraft } from "@/lib/seo-agent/orchestrate";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({
  articleId: z.string().uuid(),
  mode: z.enum(["auto", "regenerate"]).default("auto"),
  recommendationIds: z.array(z.string().uuid()).max(20).optional(),
  /** "Fix with Claude" from Content optimization: audit issues to address (Phase 5). */
  extra: z.array(z.object({ id: z.string().max(80), category: z.enum(DRAFT_CATEGORIES), problem: z.string().max(500) })).max(20).optional(),
});

/** POST /api/admin/seo/drafts — queue (re)generation of an article's draft. Returns at once; the queue shows progress. */
export const POST = seoRoute("drafts-create", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  // SEO agent disabled → v2 job queue; on → an optimize_article_flow run in the seo-agent (thread_id = draft id).
  const r = await requestDraft(b.articleId, { mode: b.mode, recommendationIds: b.recommendationIds, extra: b.extra, trigger: b.extra?.length ? "fix" : "manual", actor: ctx.actor.label });
  await ctx.audit("draft.generate", b.articleId, { mode: b.mode, recommendations: b.recommendationIds?.length ?? null, issues: b.extra?.length ?? 0, queued: r.queued, orchestrator: r.orchestrator, threadId: "threadId" in r ? r.threadId : null });
  return json(r, 202);
});
