import { z } from "zod";
import { backfillRange, enqueueSeoJob, type JobType } from "@/lib/seo-intel/jobs";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({
  source: z.enum(["gsc", "ga4", "both"]),
  mode: z.enum(["sync", "backfill"]).default("sync"),
  /** Backfill only: months back (1–16). */
  months: z.coerce.number().int().min(1).max(16).optional(),
});

/**
 * POST /api/admin/seo/sync — queue "sync now" (trailing window) or a manual backfill (up to 16 months). Jobs run in
 * the background worker within ~30 s; progress is in GET /api/admin/seo/sync/history. Rate-limited (5 per 10 min).
 */
export const POST = seoRoute("sync", { mutating: true, rate: { max: 5, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  const sources = b.source === "both" ? (["gsc", "ga4"] as const) : ([b.source] as const);
  const queued: { type: JobType; start?: string; end?: string; queued: boolean }[] = [];
  for (const src of sources) {
    if (b.mode === "backfill") {
      const range = backfillRange(b.months ?? 16);
      const type: JobType = src === "gsc" ? "gsc_backfill" : "ga4_backfill";
      queued.push({ type, ...range, queued: await enqueueSeoJob({ type, trigger: "backfill", ...range, actor: ctx.actor.label }) });
    } else {
      const type: JobType = src === "gsc" ? "gsc_sync" : "ga4_sync";
      queued.push({ type, queued: await enqueueSeoJob({ type, trigger: "manual", actor: ctx.actor.label }, `seo:${type}:manual`) });
    }
  }
  await ctx.audit(b.mode === "backfill" ? "sync.backfill" : "sync.now", b.source, { queued });
  return json({ queued }, 202);
});
