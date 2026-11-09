import { registerSeoHandler } from "./jobs";
import { captureOutcomes, generateRecommendations } from "./recommendations";

/**
 * Entry point for the job queue: importing this module registers every SEO analysis handler with jobs.ts, then
 * re-exports the queue handler. Kept separate so jobs.ts has no import cycle with the analysis modules.
 */
registerSeoHandler("recommendations", async (ctx) => {
  const r = await generateRecommendations({ now: ctx.now });
  return { status: "succeeded", rows: r.created + r.refreshed, detail: r };
});
registerSeoHandler("outcomes", async (ctx) => ({ status: "succeeded", rows: await captureOutcomes(ctx.now) }));

export { seoJobHandler, runSeoJob } from "./jobs";
