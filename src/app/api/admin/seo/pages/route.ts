import { json, seoRoute } from "@/lib/seo-intel/http";
import { pageIntelligence, parseFilters } from "@/lib/seo-intel/queries";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/pages?range=7|28|90|custom&start&end&page&category&query&device&country&searchType — Per-page Search Console + GA4 metrics (paginated: limit, offset, sort). */
export const GET = seoRoute("pages", {}, async (_req, ctx) => json(await pageIntelligence(parseFilters(ctx.query))));
