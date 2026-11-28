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
 * crew_test_flow is the CrewAI console's crew Test run (seo-agent/app/flows/crew_test.py), started by an admin only. */
export type FlowName = "backup_flow" | "gsc_sync_flow" | "ga4_sync_flow" | "tech_audit_flow" | "weekly_recommendations_flow" | "optimize_article_flow" | "internal_linking_flow" | "new_article_flow" | "reindex_flow" | "ask_gaps_flow" | "report_flow" | "seo_ml_flow" | "seo_intel_sync_flow" | "rag_reindex_flow" | "promotion_flow" | "content_ideas_flow" | "crew_test_flow" | "custom_flow" | NewsFlowName;
/** News desk flows a person may start (docs/news/ARCHITECTURE.md). The dispatcher is started by its CronJob only. */
export type NewsFlowName = "news_job_flow" | "news_draft_flow" | "news_ingest_flow" | "news_image_flow" | "news_train_flow" | "news_style_review_flow" | "news_playground_flow";

export const DISABLED_MESSAGE = "The SEO agent is disabled: none was found. Add its endpoint under Admin → Settings → SEO agent → Connection.";

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
export type AgentFlow = {
  name: string;
  inputs_schema: JsonSchema;
  approval_only: boolean;
  schedulable: boolean;
  mcp: boolean;
  crews: string[];
  /** Since the unified catalogue (agent 2026-11-24): what the admin's catalogue starts from (lib/crewai/catalog.ts syncFromAgent). */
  label?: string;
  description?: string;
  categories?: string[];
  start?: string;
  /** Whether a step flow may start it (not approval-only, not the console's test run). */
  flow_step?: boolean;
};
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
/** One crew's editable configuration as the code defines it (seo-agent/app/crews/config.py catalogue). */
export type AgentCrew = {
  crew: string;
  label: string;
  description: string;
  prompt_version: string;
  default_hash: string;
  tools: string[];
  models: string[];
  replay_flows: string[];
  categories?: string[];
  agents: { key: string; role: string; goal: string; backstory: string; tools: string[]; max_tokens: number | null }[];
  tasks: { key: string; agent: string; label: string; instructions: string; expected_output: string; variables: string[]; contract: string; output_editable: boolean }[];
};
export const flowCatalogue = (deps?: AgentDeps) => call<{ items: AgentFlow[] }>("GET", "/flows", undefined, deps, 8_000);
/** One tool an agent can be given (seo-agent/app/config_catalogue.py). */
export type AgentTool = { name: string; description: string; groups: string[]; read_only: boolean; custom: boolean; crews: string[]; agents: string[] };
/** Everything the agent defines in code that the configuration bundle describes (GET /config-catalogue, agent ≥ 2026-11-24). */
export type AgentConfigCatalogue = {
  format: number;
  service: string;
  version: string;
  crews: AgentCrew[];
  flows: AgentFlow[];
  tools: AgentTool[];
  custom_tools: string[];
  guardrails: { id: string; title: string; applies_to: string; text: string }[];
  models: string[];
};
export const configCatalogue = (deps?: AgentDeps) => call<AgentConfigCatalogue>("GET", "/config-catalogue", undefined, deps, 10_000);
export const validateFlowInputs = (flow: string, inputs: Record<string, unknown>, deps?: AgentDeps) => call<{ inputs: Record<string, unknown> }>("POST", `/flows/${encodeURIComponent(flow)}/validate`, { inputs }, deps, 8_000);
export const crewCatalogue = (deps?: AgentDeps) => call<{ items: AgentCrew[] }>("GET", "/crews", undefined, deps, 8_000);
/** POST /custom/validate: the agent's one check of a custom crew or flow spec (seo-agent/app/crews/custom.py,
 * app/flows/custom.py); 422 with the issues. `crews`: the custom crews a flow may name. */
export const validateCustomSpec = (kind: "crew" | "flow", spec: Record<string, unknown>, crews?: string[], deps?: AgentDeps) =>
  call<{ spec: Record<string, unknown> }>("POST", "/custom/validate", { kind, spec, ...(crews ? { crews } : {}) }, deps, 8_000);
/** POST /crews/{crew}/as-spec: a crew defined in code as a spec under a new key (Duplicate). */
export const crewAsSpec = (crew: string, body: { key: string; label: string; config: Record<string, unknown> | null }, deps?: AgentDeps) =>
  call<{ spec: Record<string, unknown>; dropped_tools: string[] }>("POST", `/crews/${encodeURIComponent(crew)}/as-spec`, body, deps, 8_000);
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

/**
 * The article index in pgvector, read-only (/admin/article-index; seo-agent app/chunk_browser.py, D-103). The agent owns
 * the tables (their vector size follows the embeddings model), so the web app reads them through it. `live` is
 * seo_article_chunks; `rebuild` is seo_article_chunks_next, which exists only while a rebuild after a model change runs.
 */
export type ChunkTable = "live" | "rebuild";
export type ChunkVector = { dims: number; norm: number; head: number[] };
export type ChunkTableInfo = {
  table: ChunkTable;
  name: string;
  rows: number;
  articles: number;
  updated_at: string | null;
  models: { model: string; rows: number }[];
  vector: string | null;
  bytes: number | null;
  index: string | null;
};
export type ChunkOverview = { available: boolean; reason: string; pgvector: string | null; model: string | null; dimensions: number | null; rebuilding: boolean; tables: ChunkTableInfo[] };
/** published / draft / deleted / missing: a chunk stays until the next full reindex after its article goes. */
export type ChunkArticle = { article_id: string; title: string; path: string | null; status: string; chunks: number; updated_at: string; models: string[] };
export type ChunkRow = {
  id: number;
  article_id: string;
  title: string;
  path: string | null;
  status: string;
  chunk_index: number;
  part: number;
  parts: number;
  heading_path: string;
  anchor: string | null;
  length: number;
  model: string;
  updated_at: string;
  content: string;
  vector: ChunkVector;
};
export type ChunkDetail = ChunkRow & { content_hash: string; embed_text: string | null; identifiers: string[] };
export type ChunkNeighbour = { id: number; article_id: string; title: string; path: string | null; chunk_index: number; heading_path: string; anchor: string | null; score: number };
export type ChunkPage<T> = { table: ChunkTable; total: number; offset: number; limit: number; items: T[] };
export type ChunkQuery = { table?: ChunkTable; q?: string; offset?: number; limit?: number };

function chunkQs(p: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams(Object.entries(p).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "").map(([k, v]) => [k, String(v)]));
  return q.size ? `?${q}` : "";
}

export const chunkOverview = (deps?: AgentDeps) => call<ChunkOverview>("GET", "/chunks", undefined, deps, 15_000);
export const chunkArticles = (o: ChunkQuery = {}, deps?: AgentDeps) =>
  call<ChunkPage<ChunkArticle>>("GET", `/chunks/articles${chunkQs({ table: o.table, q: o.q, offset: o.offset, limit: o.limit })}`, undefined, deps, 15_000);
export const chunkRows = (o: ChunkQuery & { articleId?: string } = {}, deps?: AgentDeps) =>
  call<ChunkPage<ChunkRow>>("GET", `/chunks/rows${chunkQs({ table: o.table, article_id: o.articleId, q: o.q, offset: o.offset, limit: o.limit })}`, undefined, deps, 15_000);
export const chunkRow = (id: number, table: ChunkTable = "live", deps?: AgentDeps) =>
  call<{ table: ChunkTable; chunk: ChunkDetail; similar: ChunkNeighbour[] }>("GET", `/chunks/rows/${encodeURIComponent(String(id))}${chunkQs({ table })}`, undefined, deps, 15_000);

/**
 * The agent's view of LiteLLM, its only LLM gateway (D-110; GET /llm-status, seo-agent/app/llm_gateway.py): whether it
 * is configured and answers, its aliases, its keys' and their team's spend and budgets, and what each alias the key
 * may use points at. Read with the agent's own keys; never a key.
 */
export type AgentLlmKey = { caller: "agent" | "ask"; alias: string | null; spend_usd: number | null; max_budget_usd: number | null; budget_duration: string | null; budget_reset_at: string | null; models: string[]; tpm_limit: number | null; rpm_limit: number | null };
export type AgentLlmStatus = {
  gateway: "litellm";
  configured: boolean;
  base_url: string | null;
  aliases: { default: string; fast: string };
  /** An authenticated GET /v1/models answered (null: not configured). */
  healthy: boolean | null;
  checked_at: string;
  keys: AgentLlmKey[];
  team: { alias: string | null; spend_usd: number | null; max_budget_usd: number | null; budget_duration: string | null; budget_reset_at: string | null; models: string[] } | null;
  models: { name: string | null; target: string | null }[];
  errors: string[];
};

export const getLlmStatus = (deps?: AgentDeps) => call<AgentLlmStatus>("GET", "/llm-status", undefined, deps, 15_000);

// --- Admin-editable agent settings (seo-agent/app/admin_settings; GET /admin-settings, PUT /admin-settings/{group}) ---

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
