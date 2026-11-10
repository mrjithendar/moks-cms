import { pollDraftBatches, weeklyBatch } from "./drafts";
import { registerSeoHandler } from "./jobs";
import { refreshKeywords, trackedAlerts } from "./keywords";
import { sendDraftDigest } from "./notify";
import { captureDraftOutcomes } from "./publish";
import { captureOutcomes, generateRecommendations } from "./recommendations";
import { generateReport } from "./reports";
import { runTechnicalScan } from "./technical";

/**
 * Entry point for the job queue: importing this module registers every SEO analysis handler with jobs.ts, then
 * re-exports the queue handler. Kept separate so jobs.ts has no import cycle with the analysis modules.
 */
registerSeoHandler("recommendations", async (ctx) => {
  const r = await generateRecommendations({ now: ctx.now });
  return { status: "succeeded", rows: r.created + r.refreshed, detail: r };
});
registerSeoHandler("technical_scan", (ctx) => runTechnicalScan(ctx));
registerSeoHandler("report_weekly", async (ctx) => {
  const r = await generateReport("weekly", ctx.payload.trigger === "schedule" ? "schedule" : "manual", ctx.now);
  return { status: "succeeded", rows: 1, detail: r };
});
registerSeoHandler("report_monthly", async (ctx) => {
  const r = await generateReport("monthly", ctx.payload.trigger === "schedule" ? "schedule" : "manual", ctx.now);
  return { status: "succeeded", rows: 1, detail: r };
});
registerSeoHandler("outcomes", async (ctx) => ({ status: "succeeded", rows: (await captureOutcomes(ctx.now)) + (await captureDraftOutcomes(ctx.now)) }));

registerSeoHandler("drafts_weekly", async () => {
  // Ask the Blog gaps are re-clustered weekly, whatever the orchestrator.
  await (await import("../seo-agent/gaps")).clusterAskGaps().catch(() => 0);
  // v4: in crewai mode this job type is never scheduled here (the weekly_recommendations_flow CronJob owns it); a
  // manual "Run now" starts that flow instead of the v2 batch.
  const viaFlow = await (await import("../seo-agent/orchestrate")).weekly("sync page");
  if (viaFlow) return { status: "succeeded", rows: 0, detail: { orchestrator: "crewai", runId: viaFlow.run_id, existing: viaFlow.existing } };
  const r = await weeklyBatch();
  return { status: r.skipped && r.skipped !== "nothing_to_do" ? "skipped" : "succeeded", rows: r.submitted, detail: r, ...(r.skipped === "budget" ? { error: "Monthly LLM budget reached; weekly drafting paused.", errorCode: "budget" } : {}) };
});
registerSeoHandler("auto_links", async (ctx) => {
  const r = await (await import("./auto-links")).runAutoLinks(ctx.db, ctx.settings, ctx.now);
  return { status: r.failed.length && !r.published ? "failed" : r.failed.length ? "partial" : "succeeded", rows: r.links, detail: r, ...(r.failed.length ? { error: `${r.failed.length} article(s) not auto-linked; see their drafts.` } : {}) };
});
registerSeoHandler("link_check", async (ctx) => {
  const r = await (await import("./broken-links")).runLinkCheck(ctx.db, ctx.settings, ctx.now);
  return { status: "succeeded", rows: r.checked, detail: r };
});
registerSeoHandler("drafts_poll", async () => {
  const r = await pollDraftBatches();
  return { status: "succeeded", rows: r.processed, detail: r };
});
registerSeoHandler("drafts_digest", async (ctx) => {
  const r = await sendDraftDigest(ctx.now);
  return { status: r.sent ? "succeeded" : "skipped", rows: r.drafts, detail: r };
});

registerSeoHandler("keywords_refresh", async (ctx) => {
  const r = await refreshKeywords({ now: ctx.now });
  const alerts = await trackedAlerts(ctx.now);
  return { status: "succeeded", rows: r.clustered, detail: { ...r, alerts: alerts.length } };
});

export { seoJobHandler, runSeoJob } from "./jobs";
export { draftJobHandler } from "./drafts";
export { verifyJobHandler } from "./publish";
export { submissionJobHandler } from "./submission";
