import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { AgentError, kickoff, type AgentDeps, type NewsFlowName } from "../seo-agent/client";
import { NewsError } from "./service";
import { newsDeskEnabled } from "./schema";

/**
 * Admin actions that start news flows in the seo-agent. Same client and token as the SEO flows; the agent re-validates
 * inputs, enforces one active run per job and the budgets, and refuses everything when NEWS_DESK_ENABLED is off.
 */
async function start(flow: NewsFlowName, inputs: Record<string, unknown>, actor: string, deps?: AgentDeps) {
  if (!newsDeskEnabled(deps?.env)) throw new NewsError("The news desk is switched off (NEWS_DESK_ENABLED=false). See docs/news/MANUAL_SETUP.md.", 409);
  try {
    return await kickoff(flow, inputs, { actor }, deps);
  } catch (e) {
    if (e instanceof AgentError) throw new NewsError(`The agent refused: ${e.message}`, e.status >= 500 ? 503 : e.status);
    throw e;
  }
}

export const runJob = (jobId: string, actor: string, opts: { dryRun?: boolean; llm?: boolean } = {}, deps?: AgentDeps) =>
  start("news_job_flow", { job_id: jobId, dry_run: Boolean(opts.dryRun), llm: opts.llm ?? true, trigger: opts.dryRun ? "dry_run" : "manual", actor }, actor, deps);
export const retryRun = (jobId: string, runId: string, actor: string, deps?: AgentDeps) => start("news_job_flow", { job_id: jobId, retry_of: runId, trigger: "retry", actor }, actor, deps);
export const testSources = (sourceIds: string[], actor: string, deps?: AgentDeps) => start("news_ingest_flow", { source_ids: sourceIds, force: true, actor }, actor, deps);
export const regenerateImage = (articleId: string, actor: string, opts: { prompt?: string; provider?: "template" | "gemini" | "openai" | null } = {}, deps?: AgentDeps) =>
  start("news_image_flow", { article_id: articleId, prompt_tweak: opts.prompt ?? "", ...(opts.provider ? { provider: opts.provider } : {}), actor }, actor, deps);
export const train = (bootstrap: boolean, actor: string, deps?: AgentDeps) => start("news_train_flow", { bootstrap }, actor, deps);
export const styleReview = (profileKey: string | null, actor: string, deps?: AgentDeps) => start("news_style_review_flow", profileKey ? { profile_key: profileKey } : {}, actor, deps);
export const playground = (i: { jobId: string; clusterId: string; profileKey: string; versionA: number; versionB?: number | null }, actor: string, deps?: AgentDeps) =>
  start("news_playground_flow", { job_id: i.jobId, cluster_id: i.clusterId, profile_key: i.profileKey, version_a: i.versionA, ...(i.versionB ? { version_b: i.versionB } : {}) }, actor, deps);

/** Playground "Save as draft": a normal draft run for that story with the chosen profile version (through every gate). */
export async function saveAsDraft(i: { jobId: string; clusterId: string; version: number }, actor: string, deps?: AgentDeps) {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(sql`insert into news_runs (id, job_id, kind, trigger, status, actor) values (${id}, ${i.jobId}, 'playground', 'manual', 'succeeded', ${actor})`);
  return start("news_draft_flow", { job_id: i.jobId, cluster_ids: [i.clusterId], mode: "single", news_run_id: id, writing_profile_version: i.version }, actor, deps);
}
