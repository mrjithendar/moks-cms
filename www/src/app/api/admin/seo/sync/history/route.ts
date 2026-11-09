import { json, seoRoute } from "@/lib/seo-intel/http";
import { syncHistory } from "@/lib/seo-intel/queries";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/sync/history?limit&offset&jobType — every run with window, status, rows, requests, retries, error. */
export const GET = seoRoute("sync-history", {}, async (_req, ctx) =>
  json(await syncHistory(Number(ctx.query.get("limit") ?? 50) || 50, Number(ctx.query.get("offset") ?? 0) || 0, ctx.query.get("jobType") ?? undefined)),
);
