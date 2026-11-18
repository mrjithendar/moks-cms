import { json, seoRoute } from "@/lib/seo-intel/http";
import { keywordOpportunities, parseFilters } from "@/lib/seo-intel/queries";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/keywords?range=7|28|90|custom&start&end&page&category&query&device&country&searchType — Queries with opportunity flags (paginated; partial coverage). */
export const GET = seoRoute("keywords", {}, async (_req, ctx) => json(await keywordOpportunities(parseFilters(ctx.query))));
