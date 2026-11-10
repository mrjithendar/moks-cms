import "server-only";
import { agentToken, agentUrl } from "./config";

/**
 * Web app → seo-agent (ClusterIP, bearer SEO_AGENT_TOKEN). Used by the admin SEO routes (start/resume/cancel runs,
 * reindex) and the public /api/ask proxy. Errors surface as AgentError with the agent's status, never its internals.
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

export type RunView = {
  thread_id: string;
  graph: string;
  status: "running" | "interrupted" | "completed" | "failed" | "cancelled" | "paused_budget";
  outcome: string | null;
  current_node: string | null;
  next: string[];
  interrupt: Record<string, unknown> | null;
  error: string | null;
  cost_usd: number;
  state: Record<string, unknown>;
};

export type Decision = { decision: "approve" | "reject" | "edit"; accepted_change_ids?: string[]; edits?: Record<string, string>; approval_id?: string | null; actor?: string | null; feedback?: string | null };

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

export const startRun = (graph: "optimize_article" | "weekly_recommendations" | "internal_linking" | "new_article", input: Record<string, unknown>, threadId: string, deps?: AgentDeps) =>
  call<{ thread_id: string; status: string; existing: boolean }>("POST", "/runs", { graph, input, thread_id: threadId }, deps);
export const getRun = (threadId: string, deps?: AgentDeps) => call<RunView>("GET", `/runs/${encodeURIComponent(threadId)}`, undefined, deps, 5_000);
export const resumeRun = (threadId: string, d: Decision, deps?: AgentDeps) => call<{ thread_id: string; status: string }>("POST", `/runs/${encodeURIComponent(threadId)}/resume`, d, deps);
export const cancelRun = (threadId: string, deps?: AgentDeps) => call<{ status: string }>("POST", `/runs/${encodeURIComponent(threadId)}/cancel`, {}, deps);
export const reindex = (body: { article_ids?: string[]; full?: boolean }, deps?: AgentDeps) => call<Record<string, number>>("POST", "/embeddings/reindex", body, deps, 120_000);

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
