import "server-only";
import { agentToken, agentUrl } from "./config";

/**
 * Web app → seo-agent (ClusterIP, bearer SEO_AGENT_TOKEN). Used by the admin SEO routes (flow kickoffs, review
 * decisions, run status/cancel) and the public /api/ask proxy. Errors surface as AgentError with the agent's status, never its internals.
 */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type AgentDeps = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

/** One CrewAI flow run (seo_flow_runs), as seo-agent's GET /flows/runs/{id} returns it. */
export type RunView = {
  run_id: string;
  flow: string;
  target_id: string;
  draft_id: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "paused_budget";
  current_step: string | null;
  outcome: string | null;
  outputs: Record<string, unknown>;
  error: string | null;
  tokens: number;
  cost_usd: number;
  triggered_by: string;
  started_at: string | null;
  finished_at: string | null;
  state?: Record<string, unknown>;
};

/** POST /review/{draft_id}/decision: approve starts publish_flow (only with the approval the web app recorded). */
export type Decision = { decision: "approve" | "reject" | "regenerate"; approval_id?: string | null; accepted_change_ids?: string[]; edits?: Record<string, string>; feedback?: string | null; actor?: string | null };

/** Flows a person or a CronJob may start with POST /flows/{name}/kickoff. publish_flow is not one of them. */
export type FlowName = "gsc_sync_flow" | "ga4_sync_flow" | "tech_audit_flow" | "weekly_recommendations_flow" | "optimize_article_flow" | "internal_linking_flow" | "new_article_flow" | "reindex_flow" | "ask_gaps_flow" | "report_flow" | NewsFlowName;
/** News desk flows a person may start (docs/news/ARCHITECTURE.md). The dispatcher is started by its CronJob only. */
export type NewsFlowName = "news_job_flow" | "news_draft_flow" | "news_ingest_flow" | "news_image_flow" | "news_train_flow" | "news_style_review_flow" | "news_playground_flow";

async function call<T>(method: string, path: string, body: unknown, deps: AgentDeps = {}, timeoutMs = 15_000): Promise<T> {
  const token = agentToken(deps.env);
  if (!token) throw new AgentError("The SEO agent is not configured (SEO_AGENT_TOKEN).", 503);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${agentUrl(deps.env)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new AgentError("The SEO agent is unreachable.", 503);
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
    throw new AgentError(typeof msg === "string" ? msg.slice(0, 300) : `SEO agent error (${res.status}).`, res.status);
  }
  return data as T;
}

export const kickoff = (flow: FlowName, inputs: Record<string, unknown>, opts: { triggeredBy?: "manual" | "cron"; actor?: string } = {}, deps?: AgentDeps) =>
  call<{ run_id: string; status: string; existing: boolean }>("POST", `/flows/${flow}/kickoff`, { inputs, triggered_by: opts.triggeredBy ?? "manual", actor: opts.actor ?? null }, deps);
export const getRun = (runId: string, deps?: AgentDeps) => call<RunView>("GET", `/flows/runs/${encodeURIComponent(runId)}`, undefined, deps, 5_000);
export const listRuns = (q: { flow?: string; status?: string; draftId?: string; limit?: number }, deps?: AgentDeps) => {
  const p = new URLSearchParams(Object.entries({ flow: q.flow, status: q.status, draft_id: q.draftId, limit: q.limit ? String(q.limit) : undefined }).filter((e): e is [string, string] => Boolean(e[1])));
  return call<{ items: RunView[] }>("GET", `/flows/runs?${p}`, undefined, deps, 5_000);
};
export const cancelRun = (runId: string, deps?: AgentDeps) => call<{ status: string }>("POST", `/flows/runs/${encodeURIComponent(runId)}/cancel`, {}, deps);
export const decide = (draftId: string, d: Decision, deps?: AgentDeps) => call<{ run_id?: string; status: string; existing?: boolean }>("POST", `/review/${encodeURIComponent(draftId)}/decision`, d, deps);

/** Streaming answer (server-sent events) for the public /api/ask proxy. */
export async function askStream(question: string, ipHash: string | null, deps: AgentDeps = {}): Promise<Response> {
  const token = agentToken(deps.env);
  if (!token) throw new AgentError("not configured", 503);
  const res = await (deps.fetchImpl ?? fetch)(`${agentUrl(deps.env)}/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ question, ip_hash: ipHash, stream: true }),
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  }).catch(() => {
    throw new AgentError("unreachable", 503);
  });
  if (!res.ok || !res.body) throw new AgentError(`agent ${res.status}`, res.status >= 500 ? 503 : res.status);
  return res;
}
