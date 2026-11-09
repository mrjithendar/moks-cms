import { registerSeoHandler } from "./jobs";
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
registerSeoHandler("outcomes", async (ctx) => ({ status: "succeeded", rows: await captureOutcomes(ctx.now) }));

export { seoJobHandler, runSeoJob } from "./jobs";
