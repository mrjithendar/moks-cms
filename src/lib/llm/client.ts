import "server-only";

/**
 * The web app's one LLM client (D-110). Every chat-model call of the web app goes through it to LiteLLM, the site's
 * only LLM gateway, and nothing in moks-cms calls a model provider directly. (The SEO agent's own client is
 * seo-agent/app/llm_gateway.py.)
 *
 * LiteLLM is the single source of truth for providers, models, provider keys, routing, fallbacks and budgets. This
 * app knows only:
 * - the endpoint: LITELLM_BASE_URL, LiteLLM's OpenAI-compatible API (…/v1);
 * - its virtual keys: LITELLM_API_KEY, and optionally LITELLM_PRACTICE_API_KEY for the Python practice tutor (its own
 *   budget in LiteLLM; the main key when unset);
 * - alias names: LITELLM_MODEL (default `moks-cms-default`), LITELLM_MODEL_FAST (default `moks-cms-fast`) and
 *   LITELLM_MODEL_PRACTICE (the fast alias when unset). Which provider and model answer an alias is set in LiteLLM.
 *
 * What it does: Chat Completions with system blocks (stable ones marked for prompt caching), JSON schema or JSON
 * object output, tool calling, web search (`web_search_options`), streaming, timeouts, retries with backoff on
 * 408/409/429/5xx and lost connections, and one error type (LlmError) whatever went wrong. It never computes a cost
 * or enforces a budget: a call's cost is what LiteLLM reports (`x-litellm-response-cost`, none on streams), and a
 * call over a LiteLLM budget is refused by LiteLLM (HTTP 422 `budget_exceeded`, LlmError code "budget").
 *
 * Keys never leave the requests: not in a message, an error, a log line or a return value.
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_MODEL = "moks-cms-default";
export const DEFAULT_MODEL_FAST = "moks-cms-fast";
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Whose virtual key a call uses: each has its own budget in LiteLLM. */
export type LlmCaller = "seo" | "practice";

export type LlmConfig = {
  /** LiteLLM's OpenAI-compatible API, …/v1 (no trailing slash). */
  baseUrl: string;
  /** LiteLLM's own routes (/key/info, /team/info, /health/*) are at the root. */
  root: string;
  keys: Record<LlmCaller, string>;
  /** The default alias (drafting, crews). */
  model: string;
  /** The fast alias (classifying, enrichment). */
  modelFast: string;
  /** The tutor's alias. */
  modelPractice: string;
  timeoutMs: number;
  /** LiteLLM's Admin UI, for links only. */
  uiUrl: string | null;
};

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;
const alias = (v: string | undefined, fallback: string) => {
  const s = (v ?? "").trim();
  return s && ALIAS.test(s) ? s : fallback;
};

/** The client's settings from the environment; null until both LITELLM_BASE_URL and LITELLM_API_KEY are set. */
export function llmConfig(env: Env = process.env): LlmConfig | null {
  const baseUrl = (env.LITELLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (env.LITELLM_API_KEY ?? "").trim();
  if (!baseUrl || !key || !/^https?:\/\//i.test(baseUrl)) return null;
  const modelFast = alias(env.LITELLM_MODEL_FAST, DEFAULT_MODEL_FAST);
  const timeout = Number(env.LITELLM_TIMEOUT_MS);
  return {
    baseUrl,
    root: baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl,
    keys: { seo: key, practice: env.LITELLM_PRACTICE_API_KEY?.trim() || key },
    model: alias(env.LITELLM_MODEL, DEFAULT_MODEL),
    modelFast,
    modelPractice: alias(env.LITELLM_MODEL_PRACTICE, modelFast),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600_000) : DEFAULT_TIMEOUT_MS,
    uiUrl: env.LITELLM_UI_URL?.trim() || null,
  };
}

/** The environment variables a status page names when the client is off. */
export function llmMissing(env: Env = process.env): string[] {
  const base = (env.LITELLM_BASE_URL ?? "").trim();
  return [...(!base || !/^https?:\/\//i.test(base) ? ["LITELLM_BASE_URL"] : []), ...(!(env.LITELLM_API_KEY ?? "").trim() ? ["LITELLM_API_KEY"] : [])];
}

export const NOT_CONFIGURED = "LiteLLM is not configured: set LITELLM_BASE_URL and LITELLM_API_KEY (docs/LLM_GATEWAY.md).";

// --- Errors ------------------------------------------------------------------------------------------------------

export type LlmErrorCode =
  /** LITELLM_BASE_URL or LITELLM_API_KEY is not set. */
  | "not_configured"
  /** LiteLLM refused the call: the key's or the team's budget is used up. */
  | "budget"
  /** The key may not use the alias, or LiteLLM has no such alias. */
  | "model_access"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "bad_request"
  /** An answer that is empty or not what was asked for. */
  | "bad_response"
  /** The model declined (content filter, refusal). */
  | "refusal";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
    readonly status: number | null = null,
    /** For "budget": whose budget LiteLLM counted. */
    readonly scope: "key" | "team" | null = null,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Never let a key into a message: LiteLLM's auth errors can echo (part of) the key they got. */
function redact(text: string, keys: string[] = []): string {
  let out = text;
  for (const k of keys) if (k.length >= 6) out = out.split(k).join("[key]");
  return out.replace(/\bsk-[A-Za-z0-9._*-]{3,}/g, "[key]").replace(/(api[_ ]?key\s*[=:]\s*)\S+/gi, "$1[key]");
}

function errorOf(body: unknown): { message: string; type: string | null } {
  const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; type?: unknown; code?: unknown };
    return { message: typeof e.message === "string" ? e.message.slice(0, 400) : "", type: typeof e.type === "string" ? e.type : typeof e.code === "string" ? e.code : null };
  }
  if (typeof err === "string") return { message: err.slice(0, 400), type: null };
  return { message: "", type: null };
}

/** LiteLLM's refusal as an LlmError: its budgets, its key's model list, its own errors and the provider's behind it. */
export function errorFromResponse(status: number, body: unknown, keys: string[] = []): LlmError {
  const { message: raw, type } = errorOf(body);
  const message = redact(raw, keys);
  const text = `LiteLLM: ${message || `HTTP ${status}`} (HTTP ${status}${type ? ` ${type}` : ""})`;
  if (type === "budget_exceeded" || /budget has been exceeded/i.test(message)) {
    const team = /Team=/.test(message);
    const spent = message.includes("Current cost:") ? ` (${message.split("Current cost:")[1]!.trim()})` : "";
    return new LlmError(`LiteLLM refused the call: the budget of ${team ? "the key's team" : "this key"} is used up${spent}. Raise it or wait for its reset in LiteLLM.`, "budget", false, status, team ? "team" : "key");
  }
  if (type === "key_model_access_denied" || type === "team_model_access_denied" || /not (?:available|allowed) for this (?:api )?key|not allowed to access model|Invalid model name|no deployments? (?:available|found)|model .*does not exist/i.test(message)) {
    return new LlmError(text, "model_access", false, status);
  }
  if (status === 401) return new LlmError(`LiteLLM rejected the key (HTTP 401${type ? ` ${type}` : ""}).`, "auth", false, status);
  if (status === 403) return new LlmError(text, "auth", false, status);
  if (status === 408) return new LlmError(text, "timeout", true, status);
  if (status === 429) return new LlmError(text, "rate_limited", true, status);
  if (status >= 500 || status === 409) return new LlmError(text, "unavailable", true, status);
  if (/content[_ ]?(?:filter|policy)|refus/i.test(message)) return new LlmError(text, "refusal", false, status);
  return new LlmError(text, "bad_request", false, status);
}

// --- Requests ----------------------------------------------------------------------------------------------------

export type ContentPart = { type: "text"; text: string; cache_control?: { type: "ephemeral" } } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
export type ToolCall = { id: string; name: string; arguments: string };
export type ChatMessage =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolDef = { name: string; description?: string; parameters: Record<string, unknown> };

export type ChatRequest = {
  /** Whose virtual key (and so whose LiteLLM budget). Default "seo". */
  caller?: LlmCaller;
  /** A LiteLLM alias. Default: LITELLM_MODEL. */
  model?: string;
  /** The whole conversation; or use system/cachedSystem/user. */
  messages?: ChatMessage[];
  /** Stable system blocks sent first, the last one marked for prompt caching (rules, style guide). */
  cachedSystem?: string[];
  system?: string;
  user?: string | ContentPart[];
  maxTokens: number;
  /** Structured output: response_format json_schema. */
  schema?: { name?: string; schema: Record<string, unknown>; strict?: boolean };
  /** Any JSON object: response_format json_object. */
  json?: boolean;
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /** Let the model search the web (LiteLLM's web_search_options; the alias's provider must support it). */
  webSearch?: boolean | { contextSize?: "low" | "medium" | "high" };
  temperature?: number;
  /** Per attempt. Default: LITELLM_TIMEOUT_MS, else 120 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Retries after the first attempt, for retryable failures only. Default 2. */
  retries?: number;
  /** LiteLLM spend-log tags (metadata.tags), e.g. ["moks-cms", "purpose:draft"]. */
  tags?: string[];
};

export type ChatUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type ChatResult = {
  text: string;
  toolCalls: ToolCall[];
  /** OpenAI's finish_reason: stop, length, tool_calls, content_filter. */
  finishReason: string | null;
  usage: ChatUsage;
  /** What LiteLLM charged (x-litellm-response-cost); null when it did not say (streams). */
  costUsd: number | null;
  /** The alias asked for. */
  alias: string;
  /** The model that answered (x-litellm-model-name, without its provider prefix), else the alias. */
  model: string;
  requestId: string | null;
  /** The assistant message as LiteLLM sent it (annotations, provider_specific_fields). */
  message: Record<string, unknown>;
  /** The whole response body (citations, search results, grounding metadata). */
  response: Record<string, unknown>;
};

export type LlmDeps = { fetchImpl?: typeof fetch; config?: LlmConfig | null; env?: Env; sleep?: (ms: number) => Promise<void> };

function configOf(deps: LlmDeps): LlmConfig {
  const cfg = deps.config !== undefined ? deps.config : llmConfig(deps.env ?? process.env);
  if (!cfg) throw new LlmError(NOT_CONFIGURED, "not_configured", false);
  return cfg;
}

function messagesOf(req: ChatRequest): ChatMessage[] {
  if (req.messages?.length) return req.messages;
  const blocks: ContentPart[] = (req.cachedSystem ?? []).filter(Boolean).map((text) => ({ type: "text", text }));
  if (blocks.length) (blocks[blocks.length - 1] as { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
  if (req.system) blocks.push({ type: "text", text: req.system });
  const system: ChatMessage[] = !blocks.length ? [] : blocks.length === 1 && !req.cachedSystem?.length ? [{ role: "system", content: req.system! }] : [{ role: "system", content: blocks }];
  return [...system, { role: "user", content: req.user ?? "" }];
}

export function requestBody(req: ChatRequest, cfg: LlmConfig, stream = false): Record<string, unknown> {
  const tools = req.tools?.length ? req.tools.map((t) => ({ type: "function", function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters } })) : null;
  const choice = req.toolChoice === undefined ? undefined : typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", function: { name: req.toolChoice.name } };
  const search = req.webSearch ? (typeof req.webSearch === "object" && req.webSearch.contextSize ? { search_context_size: req.webSearch.contextSize } : {}) : null;
  return {
    model: req.model?.trim() || (req.caller === "practice" ? cfg.modelPractice : cfg.model),
    messages: messagesOf(req),
    max_tokens: req.maxTokens,
    ...(req.schema ? { response_format: { type: "json_schema", json_schema: { name: req.schema.name ?? "answer", schema: req.schema.schema, strict: req.schema.strict ?? false } } } : req.json ? { response_format: { type: "json_object" } } : {}),
    ...(tools ? { tools, ...(choice ? { tool_choice: choice } : {}) } : {}),
    ...(search ? { web_search_options: search } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(req.tags?.length ? { metadata: { tags: req.tags.slice(0, 10) } } : {}),
  };
}

type RawUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

function usageOf(u: RawUsage | null | undefined): ChatUsage {
  const read = u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0;
  const write = u?.cache_creation_input_tokens ?? 0;
  return { inputTokens: Math.max(0, (u?.prompt_tokens ?? 0) - read - write), outputTokens: u?.completion_tokens ?? 0, cacheReadTokens: read, cacheWriteTokens: write };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  return "";
}

const answered = (headers: Headers, asked: string) => {
  const target = headers.get("x-litellm-model-name");
  return target ? (target.split("/").at(-1) ?? target) : asked;
};

function costOf(headers: Headers): number | null {
  if (!headers.has("x-litellm-response-cost")) return null;
  const cost = Number(headers.get("x-litellm-response-cost"));
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** One attempt's signal: the caller's, and the attempt's own timeout. */
function attemptSignal(req: ChatRequest, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
}

function fetchFailure(e: unknown, req: ChatRequest, timeoutMs: number): LlmError {
  if (req.signal?.aborted) return new LlmError("The model call was cancelled.", "timeout", false);
  if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") return new LlmError(`LiteLLM did not answer within ${Math.round(timeoutMs / 1000)} s.`, "timeout", true);
  return new LlmError("LiteLLM could not be reached.", "unavailable", true);
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function backoff(attempt: number, res: Response | null): number {
  const after = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 10_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

async function send(req: ChatRequest, cfg: LlmConfig, stream: boolean, deps: LlmDeps): Promise<{ res: Response; alias: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? pause;
  const body = requestBody(req, cfg, stream);
  const key = cfg.keys[req.caller ?? "seo"];
  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
  const retries = Math.max(0, Math.min(req.retries ?? 2, 5));
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let failure: LlmError;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(stream ? { Accept: "text/event-stream" } : {}) },
        body: JSON.stringify(body),
        signal: attemptSignal(req, timeoutMs),
      });
      if (res.ok) return { res, alias: String(body.model) };
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      failure = errorFromResponse(res.status, data, Object.values(cfg.keys));
      if (!RETRY_STATUS.has(res.status)) throw failure;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      failure = fetchFailure(e, req, timeoutMs);
    }
    if (!failure.retryable || attempt >= retries || req.signal?.aborted) throw failure;
    await sleep(backoff(attempt, res));
  }
}

function resultOf(data: Record<string, unknown>, res: Response, alias: string): ChatResult {
  const choice = (data.choices as { message?: Record<string, unknown>; finish_reason?: string | null }[] | undefined)?.[0];
  const message = choice?.message ?? {};
  const finish = choice?.finish_reason ?? null;
  const toolCalls = ((message.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? []).flatMap((t) => (t.function?.name ? [{ id: t.id ?? "", name: t.function.name, arguments: t.function.arguments ?? "" }] : []));
  const text = textOf(message.content);
  if (finish === "content_filter") throw new LlmError("The model declined to answer.", "refusal", false, res.status);
  if (!text && !toolCalls.length) throw new LlmError("The model's answer was empty.", "bad_response", finish === "length");
  return {
    text,
    toolCalls,
    finishReason: finish,
    usage: usageOf(data.usage as RawUsage | undefined),
    costUsd: costOf(res.headers),
    alias,
    model: answered(res.headers, alias),
    requestId: res.headers.get("x-litellm-call-id") ?? (typeof data.id === "string" ? data.id : null),
    message,
    response: data,
  };
}

/** One Chat Completions call through LiteLLM. Throws LlmError. */
export async function chat(req: ChatRequest, deps: LlmDeps = {}): Promise<ChatResult> {
  const cfg = configOf(deps);
  const { res, alias: asked } = await send(req, cfg, false, deps);
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LlmError("LiteLLM's answer was not JSON.", "bad_response", true, res.status);
  }
  return resultOf(data, res, asked);
}

/**
 * A streamed call: `onText` gets each piece of the answer as it arrives, and the result is the whole answer. Retries
 * happen only before the first byte. LiteLLM sends no cost header on streams, so `costUsd` is null (LiteLLM still
 * counts the call against its budgets).
 */
export async function chatStream(req: ChatRequest, onText: (delta: string) => void, deps: LlmDeps = {}): Promise<ChatResult> {
  const cfg = configOf(deps);
  const { res, alias: asked } = await send(req, cfg, true, deps);
  if (!res.body) throw new LlmError("LiteLLM sent no stream.", "bad_response", false, res.status);
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let text = "";
  let finish: string | null = null;
  let usage: RawUsage | undefined;
  let id: string | null = null;
  const calls = new Map<number, ToolCall>();
  const take = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk: { id?: string; choices?: { delta?: { content?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: RawUsage; error?: unknown };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk.error) throw errorFromResponse(res.status, chunk, Object.values(cfg.keys));
    id ??= chunk.id ?? null;
    if (chunk.usage) usage = chunk.usage;
    for (const c of chunk.choices ?? []) {
      const delta = textOf(c.delta?.content);
      if (delta) {
        text += delta;
        onText(delta);
      }
      for (const t of c.delta?.tool_calls ?? []) {
        const i = t.index ?? 0;
        const prev = calls.get(i) ?? { id: "", name: "", arguments: "" };
        calls.set(i, { id: t.id ?? prev.id, name: prev.name + (t.function?.name ?? ""), arguments: prev.arguments + (t.function?.arguments ?? "") });
      }
      if (c.finish_reason) finish = c.finish_reason;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        take(buffer.slice(0, nl).trimEnd());
        buffer = buffer.slice(nl + 1);
      }
    }
    take(buffer.trim());
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw fetchFailure(e, req, req.timeoutMs ?? cfg.timeoutMs);
  }
  const toolCalls = [...calls.values()].filter((c) => c.name);
  if (finish === "content_filter") throw new LlmError("The model declined to answer.", "refusal", false, res.status);
  if (!text && !toolCalls.length) throw new LlmError("The model's answer was empty.", "bad_response", false, res.status);
  return { text, toolCalls, finishReason: finish, usage: usageOf(usage), costUsd: costOf(res.headers), alias: asked, model: answered(res.headers, asked), requestId: res.headers.get("x-litellm-call-id") ?? id, message: { role: "assistant", content: text }, response: {} };
}

/** A model's JSON answer, without a ``` fence; undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return undefined;
  }
}

// --- Health and usage (read only) ----------------------------------------------------------------------------------

export type LlmHealth = {
  configured: boolean;
  /** LiteLLM answered GET /v1/models with the key. */
  ok: boolean;
  status: number | null;
  /** The aliases the key may use, as LiteLLM lists them. */
  aliases: string[];
  /** Of this app's aliases (default, fast, practice), those LiteLLM does not list for the key. */
  missing: string[];
  error: string | null;
  checkedAt: string;
  latencyMs: number | null;
};

let lastHealth: LlmHealth | null = null;

/** The last health check this process made (null before the first). */
export const lastLlmHealth = () => lastHealth;

/** Is LiteLLM reachable with this app's key, and does it serve this app's aliases? Never throws. */
export async function checkLlm(deps: LlmDeps = {}): Promise<LlmHealth> {
  const cfg = deps.config !== undefined ? deps.config : llmConfig(deps.env ?? process.env);
  const checkedAt = new Date().toISOString();
  if (!cfg) return (lastHealth = { configured: false, ok: false, status: null, aliases: [], missing: [], error: NOT_CONFIGURED, checkedAt, latencyMs: null });
  const started = performance.now();
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.keys.seo}` }, signal: AbortSignal.timeout(8_000) });
    const latencyMs = Math.round(performance.now() - started);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) return (lastHealth = { configured: true, ok: false, status: res.status, aliases: [], missing: [], error: errorFromResponse(res.status, data, Object.values(cfg.keys)).message, checkedAt, latencyMs });
    const aliases = ((data as { data?: { id?: unknown }[] } | null)?.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
    const ours = [...new Set([cfg.model, cfg.modelFast, cfg.modelPractice])];
    // A key with no model list may use every model LiteLLM serves; "all-proxy-models" is LiteLLM's own name for that.
    const missing = aliases.length && !aliases.includes("all-proxy-models") ? ours.filter((a) => !aliases.includes(a)) : [];
    return (lastHealth = { configured: true, ok: true, status: res.status, aliases, missing, error: null, checkedAt, latencyMs });
  } catch (e) {
    return (lastHealth = { configured: true, ok: false, status: null, aliases: [], missing: [], error: fetchFailure(e, {} as ChatRequest, 8_000).message, checkedAt, latencyMs: null });
  }
}

export type LlmKeyView = { caller: LlmCaller; alias: string | null; spendUsd: number | null; maxBudgetUsd: number | null; budgetDuration: string | null; budgetResetAt: string | null; models: string[]; rpmLimit: number | null; tpmLimit: number | null; teamId: string | null };
export type LlmTeamView = { alias: string | null; spendUsd: number | null; maxBudgetUsd: number | null; budgetDuration: string | null; budgetResetAt: string | null };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * LiteLLM's view of this app's keys and their team: spend, budget, reset, limits. Read with each key itself (a key may
 * read its own info and its team's). LiteLLM writes spend in batches, so a total can trail the last calls by a minute.
 */
export async function llmUsage(deps: LlmDeps = {}): Promise<{ keys: LlmKeyView[]; team: LlmTeamView | null; errors: string[] }> {
  const cfg = deps.config !== undefined ? deps.config : llmConfig(deps.env ?? process.env);
  if (!cfg) return { keys: [], team: null, errors: [NOT_CONFIGURED] };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const callers: LlmCaller[] = cfg.keys.practice !== cfg.keys.seo ? ["seo", "practice"] : ["seo"];
  const keys: LlmKeyView[] = [];
  const errors: string[] = [];
  for (const caller of callers) {
    try {
      const res = await fetchImpl(`${cfg.root}/key/info`, { headers: { Authorization: `Bearer ${cfg.keys[caller]}` }, signal: AbortSignal.timeout(8_000) });
      const info = res.ok ? ((await res.json()) as { info?: Record<string, unknown> }).info : undefined;
      if (!info) throw new Error(`HTTP ${res.status}`);
      keys.push({
        caller,
        alias: str(info.key_alias),
        spendUsd: num(info.spend),
        maxBudgetUsd: num(info.max_budget),
        budgetDuration: str(info.budget_duration),
        budgetResetAt: str(info.budget_reset_at),
        models: Array.isArray(info.models) ? info.models.filter((m): m is string => typeof m === "string") : [],
        rpmLimit: num(info.rpm_limit),
        tpmLimit: num(info.tpm_limit),
        teamId: str(info.team_id),
      });
    } catch {
      errors.push(`LiteLLM did not describe the ${caller === "seo" ? "web app's" : "Python practice tutor's"} key.`);
    }
  }
  let team: LlmTeamView | null = null;
  const teamId = keys.find((k) => k.teamId)?.teamId;
  if (teamId) {
    try {
      const res = await fetchImpl(`${cfg.root}/team/info?team_id=${encodeURIComponent(teamId)}`, { headers: { Authorization: `Bearer ${cfg.keys.seo}` }, signal: AbortSignal.timeout(8_000) });
      const t = res.ok ? ((await res.json()) as { team_info?: Record<string, unknown> }).team_info : undefined;
      if (t) team = { alias: str(t.team_alias), spendUsd: num(t.spend), maxBudgetUsd: num(t.max_budget), budgetDuration: str(t.budget_duration), budgetResetAt: str(t.budget_reset_at) };
    } catch {
      errors.push("LiteLLM did not describe the keys' team.");
    }
  }
  return { keys, team, errors };
}
