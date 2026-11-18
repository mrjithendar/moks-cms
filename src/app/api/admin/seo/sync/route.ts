import { z } from "zod";
import { AgentError, kickoff } from "@/lib/seo-agent/client";
import { orchestrator } from "@/lib/seo-agent/endpoint";
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
 * While the SEO agent is on, "sync now" starts gsc_sync_flow / ga4_sync_flow through the same kickoff endpoint
 * the CronJobs use (the flows run the same job); backfills stay in the web worker (they are not flows).
 */
export const POST = seoRoute("sync", { mutating: true, rate: { max: 5, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  const sources = b.source === "both" ? (["gsc", "ga4"] as const) : ([b.source] as const);
  const queued: { type: JobType; start?: string; end?: string; queued: boolean; runId?: string; error?: string }[] = [];
  for (const src of sources) {
    if (b.mode === "backfill") {
      const range = backfillRange(b.months ?? 16);
      const type: JobType = src === "gsc" ? "gsc_backfill" : "ga4_backfill";
      queued.push({ type, ...range, queued: await enqueueSeoJob({ type, trigger: "backfill", ...range, actor: ctx.actor.label }) });
    } else if ((await orchestrator()) === "crewai") {
      const type: JobType = src === "gsc" ? "gsc_sync" : "ga4_sync";
      try {
        const r = await kickoff(src === "gsc" ? "gsc_sync_flow" : "ga4_sync_flow", {}, { actor: ctx.actor.label });
        queued.push({ type, queued: !r.existing, runId: r.run_id } );
      } catch (e) {
        if (!(e instanceof AgentError)) throw e;
        queued.push({ type, queued: false, error: e.message } );
      }
    } else {
      const type: JobType = src === "gsc" ? "gsc_sync" : "ga4_sync";
      queued.push({ type, queued: await enqueueSeoJob({ type, trigger: "manual", actor: ctx.actor.label }, `seo:${type}:manual`) });
    }
  }
  await ctx.audit(b.mode === "backfill" ? "sync.backfill" : "sync.now", b.source, { queued });
  return json({ queued }, 202);
});
