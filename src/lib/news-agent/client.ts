import "server-only";
import { AgentError, type AgentCrew, type AgentFlow, type RunView } from "../seo-agent/client";
import { newsAgentToken } from "./config";
import { newsAgentBaseUrl, type NewsEndpointDeps } from "./endpoint";

/**
 * Web app → news agent (mrjithendar/newsroom; ClusterIP, bearer NEWS_AGENT_TOKEN), at the endpoint endpoint.ts finds.
 * The same API shape as the seo-agent's for what the web app uses (flows, runs, crews), and the same AgentError, so
 * the Newsroom and the CrewAI console handle both agents alike. A news agent that is not found is a 503.
 */
export type NewsAgentDeps = NewsEndpointDeps;

/** News desk flows a person may start (the dispatcher is started by its schedule only). */
export type NewsFlowName = "news_job_flow" | "news_draft_flow" | "news_ingest_flow" | "news_image_flow" | "news_train_flow" | "news_style_review_flow" | "news_playground_flow";
/** Everything the console may start on the news agent: its flows and the news crew's Test run. */
export type NewsAgentFlowName = NewsFlowName | "news_dispatch_flow" | "crew_test_flow";

export const NEWS_AGENT_MISSING = "The news agent was not found. Deploy it (image news-agent) or add its endpoint under Newsroom → Settings → News agent.";

async function call<T>(method: string, path: string, body: unknown, deps: NewsAgentDeps = {}, timeoutMs = 15_000): Promise<T> {
  const token = newsAgentToken(deps.env);
  if (!token) throw new AgentError("The news agent is not configured (NEWS_AGENT_TOKEN).", 503);
  const base = await newsAgentBaseUrl(deps);
  if (!base) throw new AgentError(NEWS_AGENT_MISSING, 503);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new AgentError("The news agent is unreachable.", 503);
  }
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (data as { error?: unknown; detail?: unknown }).error ?? (data as { detail?: unknown }).detail;
    const issues = (data as { issues?: unknown }).issues;
    throw new AgentError(typeof msg === "string" ? msg.slice(0, 500) : `News agent error (${res.status}).`, res.status, Array.isArray(issues) ? issues.filter((i): i is string => typeof i === "string").slice(0, 30) : []);
  }
  return data as T;
}

export const kickoff = (flow: NewsAgentFlowName, inputs: Record<string, unknown>, opts: { triggeredBy?: "manual" | "cron"; actor?: string } = {}, deps?: NewsAgentDeps) =>
  call<{ run_id: string; status: string; existing: boolean }>("POST", `/flows/${flow}/kickoff`, { inputs, triggered_by: opts.triggeredBy ?? "manual", actor: opts.actor ?? null }, deps);
export const flowCatalogue = (deps?: NewsAgentDeps) => call<{ items: AgentFlow[] }>("GET", "/flows", undefined, deps, 8_000);
export const validateFlowInputs = (flow: string, inputs: Record<string, unknown>, deps?: NewsAgentDeps) => call<{ inputs: Record<string, unknown> }>("POST", `/flows/${encodeURIComponent(flow)}/validate`, { inputs }, deps, 8_000);
export const crewCatalogue = (deps?: NewsAgentDeps) => call<{ items: AgentCrew[] }>("GET", "/crews", undefined, deps, 8_000);
export const validateCrewConfig = (crew: string, config: Record<string, unknown>, deps?: NewsAgentDeps) =>
  call<{ config: Record<string, unknown>; default_hash: string; prompt_version: string }>("POST", `/crews/${encodeURIComponent(crew)}/validate`, { config }, deps, 8_000);
export const getRun = (runId: string, deps?: NewsAgentDeps) => call<RunView>("GET", `/flows/runs/${encodeURIComponent(runId)}`, undefined, deps, 5_000);
export const cancelRun = (runId: string, deps?: NewsAgentDeps) => call<{ status: string }>("POST", `/flows/runs/${encodeURIComponent(runId)}/cancel`, {}, deps);
/** GET /readyz: the news agent is up, reaches its database, and whether it reaches the seo-agent's site search. */
export const newsAgentReady = (deps?: NewsAgentDeps) => call<{ status: string; site_search?: boolean; notes?: unknown }>("GET", "/readyz", undefined, deps, 4_000);
