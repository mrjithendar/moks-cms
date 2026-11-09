/**
 * Entry point for the job queue: importing this module registers every SEO analysis handler with jobs.ts, then
 * re-exports the queue handler. Kept separate so jobs.ts has no import cycle with the analysis modules.
 */
export { seoJobHandler } from "./jobs";
