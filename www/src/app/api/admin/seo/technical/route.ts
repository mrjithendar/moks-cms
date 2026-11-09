import { json, seoRoute } from "@/lib/seo-intel/http";
import { latestScan } from "@/lib/seo-intel/technical";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/technical?severity&check&limit&offset — latest scan and its issues. */
export const GET = seoRoute("technical", {}, async (_req, ctx) =>
  json(await latestScan({ severity: ctx.query.get("severity") ?? undefined, check: ctx.query.get("check") ?? undefined, limit: Number(ctx.query.get("limit")) || 200, offset: Number(ctx.query.get("offset")) || 0 })),
);
