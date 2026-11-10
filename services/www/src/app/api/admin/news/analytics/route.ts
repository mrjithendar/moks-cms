import { json, seoRoute } from "@/lib/seo-intel/http";
import { analytics } from "@/lib/news/service";

export const dynamic = "force-dynamic";

export const GET = seoRoute("news-analytics", {}, async (_req, ctx) => json(await analytics(Math.min(365, Math.max(7, Number(ctx.query.get("days") ?? 90) || 90)))));
