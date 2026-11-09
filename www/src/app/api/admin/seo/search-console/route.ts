import { json, seoRoute } from "@/lib/seo-intel/http";
import { searchPerformance, parseFilters } from "@/lib/seo-intel/queries";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/search-console?range=7|28|90|custom&start&end&page&category&query&device&country&searchType — Search Console trends, top pages/queries, splits, movers, low CTR, positions 5–20. */
export const GET = seoRoute("search-console", {}, async (_req, ctx) => json(await searchPerformance(parseFilters(ctx.query))));
