import { json, seoRoute } from "@/lib/seo-intel/http";
import { redditState } from "@/lib/seo-intel/promotion/reddit";
import { getPromotionSettings } from "@/lib/seo-intel/promotion/settings";
import { listIdeas, listOpportunities, promotionCounts } from "@/lib/seo-intel/promotion/store";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/promotion?status&ideas — opportunities by article, content ideas, counts and the Reddit state. */
export const GET = seoRoute("promotion", {}, async (_req, ctx) => {
  const [counts, articles, ideas, reddit, settings] = await Promise.all([
    promotionCounts(),
    listOpportunities({ status: ctx.query.get("status") ?? undefined, articleId: ctx.query.get("articleId") ?? undefined }),
    listIdeas({ status: ctx.query.get("ideas") ?? undefined }),
    redditState(),
    getPromotionSettings(),
  ]);
  return json({ counts, articles, ideas, reddit, settings });
});
