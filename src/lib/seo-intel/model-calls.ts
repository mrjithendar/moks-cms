import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { log } from "../log";
import { recordSeoLlm } from "../metrics";
import { chat, LlmError, llmConfig, NOT_CONFIGURED, parseJson, type LlmConfig } from "../llm/client";

/**
 * The SEO platform's validated model calls (drafts, keyword intents), through the one LLM client (lib/llm/client.ts,
 * LiteLLM). Every call writes one `seo_llm_usage` row with what LiteLLM charged for it: a record for the breakdown of
 * runs and drafts, not a budget. Budgets are LiteLLM's; a call over one comes back as reason "budget".
 */

export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

export type UsageRow = TokenUsage & {
  /** The model that answered (LiteLLM's x-litellm-model-name), else the alias. */
  model: string;
  purpose: string;
  promptVersion: string;
  requestId?: string | null;
  latencyMs?: number | null;
  outcome: "ok" | "invalid" | "error" | "refusal";
  errorCode?: string | null;
  draftId?: string | null;
  /** What LiteLLM charged (x-litellm-response-cost); 0 when it did not say. */
  costUsd?: number | null;
};

export async function logUsage(db: Db, u: UsageRow): Promise<number> {
  const cost = u.costUsd != null && Number.isFinite(u.costUsd) ? Math.max(0, u.costUsd) : 0;
  await db.execute(sql`
    insert into seo_llm_usage (provider, model, purpose, prompt_version, mode, request_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, outcome, error_code, draft_id)
    values ('litellm', ${u.model.slice(0, 120)}, ${u.purpose}, ${u.promptVersion}, 'sync', ${u.requestId ?? null}, ${u.inputTokens}, ${u.outputTokens}, ${u.cacheReadTokens ?? 0}, ${u.cacheWriteTokens ?? 0}, ${cost}, ${u.latencyMs ?? null}, ${u.outcome}, ${u.errorCode ?? null}, ${u.draftId ?? null})`);
  recordSeoLlm("litellm", u.outcome === "ok" ? "ok" : u.outcome === "invalid" ? "invalid" : "error", u.errorCode ?? undefined);
  return cost;
}

export type ModelJsonOpts<T> = {
  /** A LiteLLM alias (lib/llm/client.ts: the default alias for drafting, the fast one for classifying). */
  model: string;
  purpose: string;
  promptVersion: string;
  call: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number; cachedSystem?: string[]; timeoutMs?: number };
  schema: z.ZodType<T>;
  /** Semantic checks after the schema (e.g. block ids exist). Issues trigger the one retry, with the issues as feedback. */
  check?: (value: T) => string[];
  draftId?: string | null;
  fetchImpl?: typeof fetch;
  /** Tests: the client's settings (default: from the environment). */
  config?: LlmConfig | null;
};
export type ModelJsonResult<T> = { ok: true; value: T; attempts: number; requestIds: string[]; costUsd: number } | { ok: false; reason: "not_configured" | "budget" | "invalid" | "error" | "refusal"; detail: string; attempts: number; costUsd: number };

export const parseJsonText = parseJson;

/**
 * One validated structured call with at most one retry: schema or semantic failure → retry with the problems listed
 * → still invalid → `{ ok: false, reason: "invalid" }` (the caller marks the draft generation_failed). Transport
 * retries (429, 5xx, timeouts) are the client's. Never throws for model problems.
 */
export async function modelJson<T>(db: Db, o: ModelJsonOpts<T>): Promise<ModelJsonResult<T>> {
  const config = o.config !== undefined ? o.config : llmConfig();
  if (!config) return { ok: false, reason: "not_configured", detail: NOT_CONFIGURED, attempts: 0, costUsd: 0 };
  let feedback = "";
  let spent = 0;
  const requestIds: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = feedback ? `${o.call.user}\n\n<feedback>Your previous answer was rejected by the validator:\n${feedback}\nAnswer again with the complete JSON object, fixing every problem.</feedback>` : o.call.user;
    const started = performance.now();
    let res;
    try {
      res = await chat(
        { caller: "seo", model: o.model, cachedSystem: o.call.cachedSystem, system: o.call.system, user, maxTokens: o.call.maxTokens, schema: { name: "answer", schema: o.call.schema }, timeoutMs: o.call.timeoutMs, tags: ["moks-cms", `purpose:${o.purpose}`] },
        { config, fetchImpl: o.fetchImpl },
      );
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError((e as Error)?.message ?? "model call failed", "unavailable", false);
      if (err.code === "budget") {
        log.warn("seo llm call refused by the LiteLLM budget", { operation: "seo_llm", outcome: "budget", scope: err.scope, model: o.model });
        return { ok: false, reason: "budget", detail: err.message, attempts: attempt, costUsd: spent };
      }
      const refusal = err.code === "refusal";
      await logUsage(db, { model: o.model, purpose: o.purpose, promptVersion: o.promptVersion, inputTokens: 0, outputTokens: 0, latencyMs: Math.round(performance.now() - started), outcome: refusal ? "refusal" : "error", errorCode: err.code, draftId: o.draftId });
      log.warn("seo llm call failed", { operation: "seo_llm", outcome: "error", errorCode: err.code, model: o.model, attempt });
      // The client already retried transport failures; one more round only for an empty or cut-off answer.
      if (err.code !== "bad_response" || attempt === 2) return { ok: false, reason: refusal ? "refusal" : "error", detail: err.message, attempts: attempt, costUsd: spent };
      continue;
    }
    if (res.requestId) requestIds.push(res.requestId);
    const parsed = o.schema.safeParse(parseJson(res.text));
    const issues = parsed.success ? (o.check?.(parsed.data) ?? []) : parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
    spent += await logUsage(db, { costUsd: res.costUsd, model: res.model, purpose: o.purpose, promptVersion: o.promptVersion, requestId: res.requestId, ...res.usage, latencyMs: Math.round(performance.now() - started), outcome: issues.length ? "invalid" : "ok", draftId: o.draftId });
    log.info("seo llm call", { operation: "seo_llm", outcome: issues.length ? "invalid" : "ok", model: res.model, alias: o.model, attempt, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cacheReadTokens: res.usage.cacheReadTokens, promptVersion: o.promptVersion });
    if (parsed.success && !issues.length) return { ok: true, value: parsed.data, attempts: attempt, requestIds, costUsd: spent };
    feedback = issues.map((i) => `- ${i}`).join("\n");
  }
  return { ok: false, reason: "invalid", detail: `Invalid output after a retry: ${feedback.slice(0, 900)}`, attempts: 2, costUsd: spent };
}
