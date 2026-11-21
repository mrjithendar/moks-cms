import "server-only";
import { agentToken } from "./config";
import { agentBaseUrl } from "./endpoint";

/**
 * Web app → seo-agent (ClusterIP, bearer SEO_AGENT_TOKEN), at the endpoint endpoint.ts resolves (SEO_AGENT_URL, the
 * admin's endpoint, or the one discovered). Used by the admin SEO routes (flow kickoffs, review decisions, run
 * status/cancel) and the public /api/ask proxy. Errors surface as AgentError with the agent's status, never its
 * internals; a disabled agent is a 503.
 */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The agent's own list of problems (a 422 for crew configuration or flow inputs), when it sent one. */
    readonly issues: string[] = [],
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

/** Flows a person or a schedule may start with POST /flows/{name}/kickoff. publish_flow is not one of them.
 * crew_test_flow is the CrewAI console's crew Test run (moks-seo-agent/app/flows/crew_test.py), started by an admin only. */
export type FlowName = "gsc_sync_flow" | "ga4_sync_flow" | "tech_audit_flow" | "weekly_recommendations_flow" | "optimize_article_flow" | "internal_linking_flow" | "new_article_flow" | "reindex_flow" | "ask_gaps_flow" | "report_flow" | "seo_ml_flow" | "promotion_flow" | "content_ideas_flow" | "crew_test_flow" | NewsFlowName;
/** News desk flows a person may start (docs/news/ARCHITECTURE.md). The dispatcher is started by its CronJob only. */
export type NewsFlowName = "news_job_flow" | "news_draft_flow" | "news_ingest_flow" | "news_image_flow" | "news_train_flow" | "news_style_review_flow" | "news_playground_flow";

export const DISABLED_MESSAGE = "The SEO agent is disabled: none was found. Add its endpoint under Admin → AI & SEO → Settings → Overview.";

async function call<T>(method: string, path: string, body: unknown, deps: AgentDeps = {}, timeoutMs = 15_000): Promise<T> {
  const token = agentToken(deps.env);
  if (!token) throw new AgentError("The SEO agent is not configured (SEO_AGENT_TOKEN).", 503);
  const base = await agentBaseUrl(deps);
  if (!base) throw new AgentError(DISABLED_MESSAGE, 503);
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
    const issues = (data as { issues?: unknown }).issues;
    throw new AgentError(typeof msg === "string" ? msg.slice(0, 500) : `SEO agent error (${res.status}).`, res.status, Array.isArray(issues) ? issues.filter((i): i is string => typeof i === "string").slice(0, 30) : []);
  }
  return data as T;
}

export const kickoff = (flow: FlowName, inputs: Record<string, unknown>, opts: { triggeredBy?: "manual" | "cron"; actor?: string } = {}, deps?: AgentDeps) =>
  call<{ run_id: string; status: string; existing: boolean }>("POST", `/flows/${flow}/kickoff`, { inputs, triggered_by: opts.triggeredBy ?? "manual", actor: opts.actor ?? null }, deps);
/** One flow as the agent's GET /flows describes it (CrewAI console: Run with parameters, schedules, crews). */
export type AgentFlow = { name: string; inputs_schema: JsonSchema; approval_only: boolean; schedulable: boolean; mcp: boolean; crews: string[] };
/** The JSON Schema subset Pydantic emits for the flows' input models. */
export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
};
/** One crew's editable configuration as the code defines it (moks-seo-agent/app/crews/config.py catalogue). */
export type AgentCrew = {
  crew: string;
  label: string;
  description: string;
  prompt_version: string;
  default_hash: string;
  tools: string[];
  models: string[];
  replay_flows: string[];
  agents: { key: string; role: string; goal: string; backstory: string; tools: string[]; max_tokens: number | null }[];
  tasks: { key: string; agent: string; label: string; instructions: string; expected_output: string; variables: string[]; contract: string; output_editable: boolean }[];
};
export const flowCatalogue = (deps?: AgentDeps) => call<{ items: AgentFlow[] }>("GET", "/flows", undefined, deps, 8_000);
export const validateFlowInputs = (flow: string, inputs: Record<string, unknown>, deps?: AgentDeps) => call<{ inputs: Record<string, unknown> }>("POST", `/flows/${encodeURIComponent(flow)}/validate`, { inputs }, deps, 8_000);
export const crewCatalogue = (deps?: AgentDeps) => call<{ items: AgentCrew[] }>("GET", "/crews", undefined, deps, 8_000);
export const validateCrewConfig = (crew: string, config: Record<string, unknown>, deps?: AgentDeps) =>
  call<{ config: Record<string, unknown>; default_hash: string; prompt_version: string }>("POST", `/crews/${encodeURIComponent(crew)}/validate`, { config }, deps, 8_000);

/** GET /readyz: the agent is up and reaches its database (System status). */
export const agentReady = (deps?: AgentDeps) => call<{ status: string; vector?: boolean; notes?: unknown }>("GET", "/readyz", undefined, deps, 4_000);
export const getRun = (runId: string, deps?: AgentDeps) => call<RunView>("GET", `/flows/runs/${encodeURIComponent(runId)}`, undefined, deps, 5_000);
export const listRuns = (q: { flow?: string; status?: string; draftId?: string; limit?: number }, deps?: AgentDeps) => {
  const p = new URLSearchParams(Object.entries({ flow: q.flow, status: q.status, draft_id: q.draftId, limit: q.limit ? String(q.limit) : undefined }).filter((e): e is [string, string] => Boolean(e[1])));
  return call<{ items: RunView[] }>("GET", `/flows/runs?${p}`, undefined, deps, 5_000);
};
export const cancelRun = (runId: string, deps?: AgentDeps) => call<{ status: string }>("POST", `/flows/runs/${encodeURIComponent(runId)}/cancel`, {}, deps);
export const decide = (draftId: string, d: Decision, deps?: AgentDeps) => call<{ run_id?: string; status: string; existing?: boolean }>("POST", `/review/${encodeURIComponent(draftId)}/decision`, d, deps);

export type AskTurn = { q: string; a: string };
/** Optional parts of a sitewide-chat question: earlier turns (follow-ups) and the article the reader has open. */
export type AskExtras = { history?: AskTurn[]; contextSlug?: string | null };

/** Streaming answer (server-sent events) for the public /api/ask proxy. */
export async function askStream(question: string, ipHash: string | null, deps: AgentDeps = {}, extras: AskExtras = {}): Promise<Response> {
  const token = agentToken(deps.env);
  if (!token) throw new AgentError("not configured", 503);
  const base = await agentBaseUrl(deps);
  if (!base) throw new AgentError("disabled", 503);
  const body: Record<string, unknown> = { question, ip_hash: ipHash, stream: true };
  if (extras.history?.length) body.history = extras.history;
  if (extras.contextSlug) body.context_slug = extras.contextSlug;
  const res = await (deps.fetchImpl ?? fetch)(`${base}/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  }).catch(() => {
    throw new AgentError("unreachable", 503);
  });
  if (!res.ok || !res.body) throw new AgentError(`agent ${res.status}`, res.status >= 500 ? 503 : res.status);
  return res;
}

/** LanceDB browser (/admin/lancedb; seo-agent app/lance_admin.py, D-92). */
export type LanceColumn = { name: string; type: string; kind: "string" | "bool" | "int" | "float" | "timestamp" | "vector" | "list" | "other"; editable: boolean; nullable: boolean };
export type LanceTable = { name: string; rows: number; version: number; columns: LanceColumn[] };
export type LanceCell = string | number | boolean | null | { text: string; length: number } | { dims: number; head: number[] } | { items: number; head: string[] };
export type LanceKey = { keyColumn: string; key: string | number | boolean; actor?: string };

export const lanceOverview = (deps?: AgentDeps) => call<{ configured: boolean; location: string | null; tables: LanceTable[] }>("GET", "/lancedb", undefined, deps, 15_000);
export const lanceBrowse = (table: string, offset: number, limit: number, deps?: AgentDeps) =>
  call<{ table: string; version: number; total: number; offset: number; limit: number; columns: LanceColumn[]; rows: Record<string, LanceCell>[] }>(
    "GET",
    `/lancedb/tables/${encodeURIComponent(table)}?offset=${offset}&limit=${limit}`,
    undefined,
    deps,
    15_000,
  );
const lanceBody = (k: LanceKey) => ({ key_column: k.keyColumn, key: k.key, actor: k.actor ?? null });
export const lanceRow = (table: string, k: LanceKey, deps?: AgentDeps) =>
  call<{ table: string; columns: LanceColumn[]; row: Record<string, LanceCell> }>("POST", `/lancedb/tables/${encodeURIComponent(table)}/row`, { key_column: k.keyColumn, key: k.key }, deps);
export const lanceUpdate = (table: string, k: LanceKey, values: Record<string, string | number | boolean | null>, deps?: AgentDeps) =>
  call<{ updated: number; version: number }>("POST", `/lancedb/tables/${encodeURIComponent(table)}/update`, { ...lanceBody(k), values }, deps);
export const lanceDelete = (table: string, k: LanceKey, deps?: AgentDeps) =>
  call<{ deleted: number; version: number }>("POST", `/lancedb/tables/${encodeURIComponent(table)}/delete`, lanceBody(k), deps);

/**
 * The one LLM budget (moks-seo-agent app/llm_budgets.py): an optional daily and an optional monthly limit for every
 * provider, model and purpose together, stored and enforced by the agent. Admin → AI & SEO → Settings → LLM budget
 * only shows and edits it. The breakdowns are for reading; they limit nothing.
 */
export type AgentLlmBudget = { daily_usd: number | null; monthly_usd: number | null };
export type AgentLlmScope = "day" | "month";
export type AgentLlmBudgetView = {
  budget: AgentLlmBudget;
  scope: AgentLlmScope;
  period_start: string;
  resets_at: string;
  spent_usd: number;
  /** Upper-bound estimates of the calls in flight; they count as spent until each call is booked. */
  pending_usd: number;
  limit_usd: number | null;
  remaining_usd: number | null;
  /** Month only: the month's spend at its average daily rate so far. */
  forecast_usd: number | null;
  by_provider: { provider: string; usd: number; calls: number }[];
  by_model: { provider: string; model: string; usd: number; calls: number }[];
  by_purpose: { purpose: string; usd: number; calls: number }[];
  other: { scope: AgentLlmScope; spent_usd: number; limit_usd: number | null; resets_at: string };
  /** Ask the Blog's own daily limit: a guard against readers, on top of the budget. */
  ask_daily: { limit_usd: number; spent_usd: number };
  /** Limits per model and per provider from before the one budget. Shown read-only: nothing enforces them. */
  legacy_limits: { models: Record<string, AgentLlmBudget>; providers: Record<string, AgentLlmBudget> };
};

export const getLlmBudget = (scope: AgentLlmScope, deps?: AgentDeps) => call<AgentLlmBudgetView>("GET", `/llm-budget?scope=${scope}`, undefined, deps, 8_000);
/** Both limits are sent; null is no limit. The agent validates and answers 422 with its issues. */
export const putLlmBudget = (budget: AgentLlmBudget, actor: string, deps?: AgentDeps) => call<{ budget: AgentLlmBudget }>("PUT", "/llm-budget", { ...budget, actor }, deps, 8_000);

// --- Admin-editable agent settings (moks-seo-agent app/admin_settings; GET /admin-settings, PUT /admin-settings/{group}) ---

export type AgentSettingType = "text" | "integer" | "number" | "boolean" | "select" | "list" | "secret";
export type AgentSettingValue = string | number | boolean | string[] | null;
export type AgentSettingField = {
  env: string;
  label: string;
  hint: string;
  type: AgentSettingType;
  /** "live": applies at once. "restart": stored, and applies when the agent restarts. */
  apply: "live" | "restart";
  unit: string | null;
  min: number | null;
  max: number | null;
  options: string[];
  source: "admin" | "deployment" | "default";
  updated_by: string | null;
  updated_at: string | null;
  restart_pending: boolean;
  /** Not sent for a secret. */
  value?: AgentSettingValue;
  default?: AgentSettingValue;
  /** The deployment's value when its environment variable is set, else null. */
  deployment?: AgentSettingValue;
  /** Secrets only: whether one is saved, whether the deployment has one, and whether it can be saved (the agent has its key). */
  set?: boolean;
  deployment_set?: boolean;
  editable?: boolean;
};
export type AgentSettingsGroup = { id: string; title: string; description: string; fields: AgentSettingField[]; restart_pending: boolean };
export type AgentSettingsView = { groups: AgentSettingsGroup[]; secrets_key_set: boolean; refresh_seconds: number; restart_pending: boolean };

export const getAgentSettings = (deps?: AgentDeps) => call<AgentSettingsView>("GET", "/admin-settings", undefined, deps, 8_000);
/** A field that is not sent stays as it is; null clears it (the deployment's value, then the default, applies). */
export const putAgentSettings = (group: string, values: Record<string, AgentSettingValue>, actor: string, deps?: AgentDeps) =>
  call<AgentSettingsView>("PUT", `/admin-settings/${encodeURIComponent(group)}`, { values, actor }, deps, 8_000);
