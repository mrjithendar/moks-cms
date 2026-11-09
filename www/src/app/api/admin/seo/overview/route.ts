import { json, seoRoute } from "@/lib/seo-intel/http";
import { overview, parseFilters } from "@/lib/seo-intel/queries";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/overview?range=7|28|90|custom&start&end&page&category&query&device&country&searchType — KPI cards with source, period, last sync and change vs the previous period. */
export const GET = seoRoute("overview", {}, async (_req, ctx) => json(await overview(parseFilters(ctx.query))));
