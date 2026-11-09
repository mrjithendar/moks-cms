import { json, seoRoute } from "@/lib/seo-intel/http";
import { visitorAnalytics, parseFilters } from "@/lib/seo-intel/queries";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/analytics?range=7|28|90|custom&start&end&page&category&query&device&country&searchType — GA4 visitor and organic trends, landing pages, engagement, channels, devices, geography. */
export const GET = seoRoute("analytics", {}, async (_req, ctx) => json(await visitorAnalytics(parseFilters(ctx.query))));
