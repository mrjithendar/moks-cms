import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ModelCall, ModelResult } from "./providers";
import { ProviderError } from "./providers";

/**
 * Claude through the official SDK, as one more provider of `callModel` (no second AI layer).
 *
 * - Structured output: `output_config.format` with the caller's JSON schema; the caller still validates the parsed
 *   object server-side (zod) and retries once on a mismatch.
 * - Prompt caching: `cachedSystem` blocks (stable rules + style guide) come first, and the last one carries
 *   `cache_control`, so the volatile per-article prompt never invalidates them. Below the model's minimum cacheable
 *   prefix the API silently does not cache; usage then reports 0 cache reads.
 * - Refusal fallback: Sonnet/Opus/Fable requests use the server-side `fallbacks: "default"` (beta
 *   server-side-fallback-2026-07-01). Haiku has no server-side fallback. A final `stop_reason: "refusal"` is a
 *   non-retryable error.
 * - The model gets no tools: its output is only ever data for a draft a person reviews.
 */
export const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1)$/;

export function anthropicClient(apiKey: string | null, fetchImpl?: typeof fetch): Anthropic {
  if (!apiKey) throw new ProviderError("Anthropic API key is not configured (ANTHROPIC_API_KEY).", "auth", false);
  return new Anthropic({ apiKey, maxRetries: 2, ...(fetchImpl && fetchImpl !== fetch ? { fetch: fetchImpl } : {}) });
}

/** System blocks: cached stable blocks first (breakpoint on the last), then the call's own system text. */
export function systemBlocks(call: Pick<ModelCall, "system" | "cachedSystem">): Anthropic.TextBlockParam[] {
  const stable = (call.cachedSystem ?? []).filter(Boolean);
  const blocks: Anthropic.TextBlockParam[] = stable.map((text, i) => ({ type: "text", text, ...(i === stable.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}) }));
  if (call.system) blocks.push({ type: "text", text: call.system });
  return blocks;
}

/** Request params shared by the synchronous call and Message Batches (batches reject `fallbacks`). */
export function messageParams(model: string, call: Omit<ModelCall, "signal">): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: call.maxTokens,
    system: systemBlocks(call),
    messages: [{ role: "user", content: call.user }],
    output_config: { format: { type: "json_schema", schema: call.schema }, ...(call.effort ? { effort: call.effort } : {}) },
  };
}

export function textOf(content: { type: string; text?: string }[]): string {
  return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

export function mapAnthropicError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError("Claude rejected the credentials", "auth", false);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError("Claude rate limit", "rate_limited", true);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("Claude timed out", "timeout", true);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError("Claude unreachable", "unavailable", true);
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) return new ProviderError(`Claude rejected the request (HTTP ${e.status})`, "bad_response", false);
  if (e instanceof Anthropic.APIError) return new ProviderError(`Claude HTTP ${e.status ?? "error"}`, "unavailable", (e.status ?? 500) >= 500);
  if ((e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError") return new ProviderError("Claude timed out", "timeout", true);
  return new ProviderError("Claude call failed", "unavailable", true);
}

type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

export function resultOf(msg: { content: { type: string; text?: string }[]; usage: Usage; model: string; stop_reason?: string | null }, requestId: string | null): ModelResult {
  if (msg.stop_reason === "refusal") throw new ProviderError("Claude declined this request.", "bad_response", false);
  const text = textOf(msg.content);
  if (!text) throw new ProviderError("Empty answer", "bad_response", msg.stop_reason === "max_tokens");
  return {
    text,
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    requestId,
    model: msg.model,
    stopReason: msg.stop_reason ?? null,
  };
}

export async function anthropicCall(model: string, apiKey: string | null, call: ModelCall, fetchImpl?: typeof fetch): Promise<ModelResult> {
  const client = anthropicClient(apiKey, fetchImpl);
  const params = messageParams(model, call);
  try {
    if (FALLBACK_MODELS.test(model)) {
      const msg = await client.beta.messages.create({ ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming), betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal: call.signal });
      return resultOf(msg as unknown as Parameters<typeof resultOf>[0], (msg as { _request_id?: string | null })._request_id ?? null);
    }
    const msg = await client.messages.create(params, { signal: call.signal });
    return resultOf(msg, (msg as { _request_id?: string | null })._request_id ?? null);
  } catch (e) {
    throw mapAnthropicError(e);
  }
}
