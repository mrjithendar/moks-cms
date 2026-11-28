import "server-only";
import type { PracticeSettings } from "../settings";
import { anthropicCall } from "./anthropic";
import { traceAwsClient } from "../../trace";
import { budgetRefusal, gatewayErrorText } from "../../llm-gateway";

/**
 * Model providers for the tutor. Each takes a system prompt, a user prompt and a JSON schema, and returns raw
 * text plus token usage. The model id is always configuration (Admin → Python practice → Settings); nothing
 * here assumes a particular model.
 *
 * - openai: OpenAI Chat Completions or any OpenAI-compatible endpoint (base URL), structured output via json_schema
 * - gemini: Gemini API generateContent with responseSchema (reuses GEMINI_API_KEY when no key is saved)
 * - bedrock: Amazon Bedrock Converse API with the pod's AWS credentials (env or IRSA); JSON requested in the prompt
 * - anthropic: Claude Messages API through the official SDK (@anthropic-ai/sdk), structured output via
 *   output_config.format (JSON schema), prompt caching for the stable system blocks (src/lib/practice/ai/anthropic.ts)
 * - litellm: LiteLLM's Chat Completions API when it is the gateway (D-109, lib/llm-gateway.ts): `model` is an alias,
 *   `baseUrl` LiteLLM's …/v1, the key the caller's virtual key. Cached system blocks keep their cache_control, the
 *   schema goes as response_format json_schema, and the result carries what LiteLLM charged (costUsd). A call over a
 *   LiteLLM budget throws GatewayBudgetError.
 */
export type ModelProvider = PracticeSettings["ai"]["provider"] | "anthropic" | "litellm";
export type ModelSettings = Omit<PracticeSettings["ai"], "provider"> & { provider: ModelProvider };
export type ModelCall = {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  signal: AbortSignal;
  /** Anthropic only: stable system blocks sent before `system` and marked for prompt caching (rules, style guide). */
  cachedSystem?: string[];
  /** Anthropic only: output_config.effort. */
  effort?: "low" | "medium" | "high";
};
export type ModelResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestId?: string | null;
  model?: string;
  stopReason?: string | null;
  /** LiteLLM only: what it charged for the call (x-litellm-response-cost), in USD. */
  costUsd?: number | null;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "rate_limited" | "auth" | "unavailable" | "bad_response",
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function fromStatus(status: number, provider: string): ProviderError {
  if (status === 429) return new ProviderError(`${provider} rate limit`, "rate_limited", true);
  if (status === 401 || status === 403) return new ProviderError(`${provider} rejected the credentials`, "auth", false);
  if (status >= 500) return new ProviderError(`${provider} HTTP ${status}`, "unavailable", true);
  return new ProviderError(`${provider} HTTP ${status}`, "bad_response", false);
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, provider: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "TimeoutError" || signal.aborted) throw new ProviderError(`${provider} timed out`, "timeout", true);
    throw new ProviderError(`${provider} unreachable`, "unavailable", true);
  }
  if (!res.ok) throw fromStatus(res.status, provider);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`${provider} returned invalid JSON`, "bad_response", true);
  }
}

/** LiteLLM's Chat Completions API (D-109): see the list above. */
async function litellmCall(settings: ModelSettings, apiKey: string | null, call: ModelCall, fetchImpl: typeof fetch): Promise<ModelResult> {
  const blocks: Record<string, unknown>[] = (call.cachedSystem ?? []).filter(Boolean).map((text) => ({ type: "text", text }));
  if (blocks.length) blocks[blocks.length - 1]!.cache_control = { type: "ephemeral" };
  if (call.system) blocks.push({ type: "text", text: call.system });
  const body = {
    model: settings.model,
    messages: [...(blocks.length ? [{ role: "system", content: blocks }] : []), { role: "user", content: call.user }],
    max_tokens: call.maxTokens,
    response_format: { type: "json_schema", json_schema: { name: "answer", schema: call.schema, strict: false } },
  };
  let res: Response;
  try {
    res = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey ?? ""}` }, body: JSON.stringify(body), signal: call.signal });
  } catch (e) {
    if ((e as Error).name === "TimeoutError" || call.signal.aborted) throw new ProviderError("LiteLLM timed out", "timeout", true);
    throw new ProviderError("LiteLLM unreachable", "unavailable", true);
  }
  let data: Record<string, unknown> | null = null;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const refusal = budgetRefusal(res.status, data, "this caller's key");
    if (refusal) throw refusal;
    const base = fromStatus(res.status, "LiteLLM");
    throw new ProviderError(gatewayErrorText(res.status, data), base.code, base.retryable);
  }
  const choice = (data?.choices as { message?: { content?: string }; finish_reason?: string }[] | undefined)?.[0];
  const usage = (data?.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  const read = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const cost = Number(res.headers.get("x-litellm-response-cost"));
  const target = res.headers.get("x-litellm-model-name");
  const finish = choice?.finish_reason ?? null;
  if (finish === "content_filter") throw new ProviderError("The model declined to answer.", "bad_response", false);
  if (!choice?.message?.content) throw new ProviderError("Empty answer", "bad_response", false);
  return {
    text: choice.message.content,
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - read - write),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    requestId: res.headers.get("x-litellm-call-id") ?? (typeof data?.id === "string" ? data.id : null),
    model: target ? (target.split("/").at(-1) ?? target) : settings.model,
    stopReason: finish === "length" ? "max_tokens" : finish === "stop" ? "end_turn" : finish,
    costUsd: Number.isFinite(cost) && res.headers.has("x-litellm-response-cost") ? cost : null,
  };
}

export async function callModel(settings: ModelSettings, apiKey: string | null, call: ModelCall, fetchImpl: typeof fetch = fetch): Promise<ModelResult> {
  if (settings.provider === "litellm") return litellmCall(settings, apiKey, call, fetchImpl);
  if (settings.provider === "anthropic") return anthropicCall(settings.model, apiKey, call, fetchImpl);
  if (settings.provider === "openai") {
    const base = settings.baseUrl || "https://api.openai.com/v1";
    const official = !settings.baseUrl;
    const data = await post(
      `${base.replace(/\/+$/, "")}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      {
        model: settings.model,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        ...(official ? { max_completion_tokens: call.maxTokens } : { max_tokens: call.maxTokens }),
        response_format: { type: "json_schema", json_schema: { name: "tutor_answer", schema: call.schema, strict: true } },
      },
      call.signal,
      "OpenAI",
      fetchImpl,
    );
    const choice = (data.choices as { message?: { content?: string; refusal?: string } }[] | undefined)?.[0]?.message;
    const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (!choice?.content) throw new ProviderError(choice?.refusal ? "The model declined to answer." : "Empty answer", "bad_response", false);
    return { text: choice.content, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 };
  }
  if (settings.provider === "gemini") {
    const data = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
      { "x-goog-api-key": apiKey ?? "" },
      {
        systemInstruction: { parts: [{ text: call.system }] },
        contents: [{ role: "user", parts: [{ text: call.user }] }],
        generationConfig: { maxOutputTokens: call.maxTokens, responseMimeType: "application/json", responseSchema: geminiSchema(call.schema) },
      },
      call.signal,
      "Gemini",
      fetchImpl,
    );
    const parts = (data.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0]?.content?.parts ?? [];
    const usage = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    const text = parts.map((p) => p.text ?? "").join("");
    if (!text) throw new ProviderError("Empty answer", "bad_response", false);
    return { text, inputTokens: usage?.promptTokenCount ?? 0, outputTokens: usage?.candidatesTokenCount ?? 0 };
  }
  // Bedrock Converse.
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = traceAwsClient(new BedrockRuntimeClient({ region: settings.region, maxAttempts: 1 }), "bedrock");
  try {
    const out = await client.send(
      new ConverseCommand({
        modelId: settings.model,
        system: [{ text: `${call.system}\n\nAnswer with a single JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(call.schema)}` }],
        messages: [{ role: "user", content: [{ text: call.user }] }],
        inferenceConfig: { maxTokens: call.maxTokens },
      }),
      { abortSignal: call.signal },
    );
    const text = (out.output?.message?.content ?? []).map((c) => ("text" in c ? (c.text ?? "") : "")).join("");
    if (!text) throw new ProviderError("Empty answer", "bad_response", false);
    return { text, inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const name = (e as { name?: string }).name ?? "";
    if (call.signal.aborted || name === "AbortError" || name === "TimeoutError") throw new ProviderError("Bedrock timed out", "timeout", true);
    if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") throw new ProviderError("Bedrock throttled", "rate_limited", true);
    if (name === "AccessDeniedException" || name === "UnrecognizedClientException" || name === "CredentialsProviderError") throw new ProviderError("Bedrock denied access", "auth", false);
    throw new ProviderError(`Bedrock error ${name}`, "unavailable", true);
  }
}

/** Gemini's responseSchema is an OpenAPI subset: drop keywords it rejects. */
function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    if (k === "properties" && v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv as Record<string, unknown>)]));
    else if (k === "items" && v && typeof v === "object") out[k] = geminiSchema(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
