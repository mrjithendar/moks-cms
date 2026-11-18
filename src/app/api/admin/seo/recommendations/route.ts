import { json, seoRoute } from "@/lib/seo-intel/http";
import { listRecommendations } from "@/lib/seo-intel/recommendations";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/recommendations?status=pending|approved|rejected|all&category&band&articleId&limit&offset */
export const GET = seoRoute("recommendations", {}, async (_req, ctx) => json(await listRecommendations(Object.fromEntries(ctx.query))));
