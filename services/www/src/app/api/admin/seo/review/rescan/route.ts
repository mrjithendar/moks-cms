import { z } from "zod";
import { requestDraft } from "@/lib/seo-agent/orchestrate";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { RESCAN_MAX, RESCAN_TASKS, rescanArticles } from "@/lib/seo-intel/review-scan";

export const dynamic = "force-dynamic";

const body = z.union([
  z.object({ articleIds: z.array(z.string().uuid()).min(1).max(RESCAN_MAX) }),
  z.object({ all: z.literal(true), limit: z.number().int().min(1).max(RESCAN_MAX).default(10), staleDays: z.number().int().min(1).max(3650).optional() }),
]);

/**
 * POST /api/admin/seo/review/rescan — ask for a fresh review draft of the chosen articles, or of the next `limit`
 * articles on the "Not reviewed" list (at most 25 a request: each is a model run). Drafts land in the queue; nothing
 * is published without approval.
 */
export const POST = seoRoute("review-rescan", { mutating: true, rate: { max: 6, windowSeconds: 600 } }, async (_req, ctx) => {
  const pick = parse(body, ctx.body);
  const r = await rescanArticles(pick, (articleId) => requestDraft(articleId, { mode: "regenerate", extra: RESCAN_TASKS, trigger: "manual", actor: ctx.actor.label }));
  await ctx.audit("review.rescan", undefined, { ...r, all: "all" in pick });
  return json(r, 202);
});
