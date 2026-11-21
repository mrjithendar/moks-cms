import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "../log";
import { agentGate, type LlmGate } from "./llm-gate";
import { recordSeoLlm } from "../metrics";
import { anthropicClient, mapAnthropicError, messageParams, resultOf } from "../practice/ai/anthropic";
import { callModel, ProviderError, type ModelCall, type ModelResult } from "../practice/ai/providers";
import type { ClaudeConfig } from "./settings";

/**
 * Claude usage for the SEO platform: cost accounting, the monthly hard cap, validated structured calls and the
 * Message Batches flow. Every call (sync or batch result) writes one `seo_llm_usage` row.
 *
 * Prices are USD per million tokens, Anthropic first-party list prices as of 2026-10 (input, output, cache read,
 * cache write = 1.25 × input for the 5-minute TTL). Batches cost 50 %. Unknown models are priced at the most
 * expensive known rate so the budget errs on the safe side. Override with SEO_LLM_PRICES_JSON if prices change.
 */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
const FALLBACK_PRICE: Price = PRICES["claude-fable-5-1"]!;

export function priceOf(model: string, env: Record<string, string | undefined> = process.env): Price {
  try {
    const override = env.SEO_LLM_PRICES_JSON ? (JSON.parse(env.SEO_LLM_PRICES_JSON) as Record<string, Partial<Price>>)[model] : undefined;
    if (override && typeof override.input === "number" && typeof override.output === "number" && override.input >= 0 && override.output >= 0) {
      return { input: override.input, output: override.output, cacheRead: override.cacheRead ?? override.input * 0.1, cacheWrite: override.cacheWrite ?? override.input * 1.25 };
    }
  } catch {
    /* invalid override: list prices */
  }
  return PRICES[model] ?? FALLBACK_PRICE;
}

export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

export function costUsd(model: string, u: TokenUsage, mode: "sync" | "batch" = "sync"): number {
  const p = priceOf(model);
  const raw = (u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheReadTokens ?? 0) * p.cacheRead + (u.cacheWriteTokens ?? 0) * p.cacheWrite) / 1_000_000;
  return mode === "batch" ? raw / 2 : raw;
}

/** Upper-bound estimate before a call: ~3.5 characters per token in, the full max_tokens out. */
export function estimateCostUsd(model: string, inputChars: number, maxTokens: number, mode: "sync" | "batch" = "sync"): number {
  return costUsd(model, { inputTokens: Math.ceil(inputChars / 3.5), outputTokens: maxTokens }, mode);
}

export type UsageRow = TokenUsage & { provider?: string; model: string; purpose: string; promptVersion: string; mode: "sync" | "batch"; requestId?: string | null; latencyMs?: number | null; outcome: "ok" | "invalid" | "error" | "refusal"; errorCode?: string | null; draftId?: string | null };

export async function logUsage(db: Db, u: UsageRow): Promise<number> {
  const cost = costUsd(u.model, u, u.mode);
  await db.execute(sql`
    insert into seo_llm_usage (provider, model, purpose, prompt_version, mode, request_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, outcome, error_code, draft_id)
    values (${u.provider ?? "anthropic"}, ${u.model}, ${u.purpose}, ${u.promptVersion}, ${u.mode}, ${u.requestId ?? null}, ${u.inputTokens}, ${u.outputTokens}, ${u.cacheReadTokens ?? 0}, ${u.cacheWriteTokens ?? 0}, ${cost}, ${u.latencyMs ?? null}, ${u.outcome}, ${u.errorCode ?? null}, ${u.draftId ?? null})`);
  recordSeoLlm("anthropic", u.outcome === "ok" ? "ok" : u.outcome === "invalid" ? "invalid" : "error", u.errorCode ?? undefined);
  return cost;
}

export type BudgetState = { spentUsd: number; reservedUsd: number; monthStart: string; byModel: { model: string; costUsd: number; calls: number; cacheReadTokens: number; inputTokens: number }[] };

/**
 * Month-to-date LLM spend this web app can see (UTC calendar month) plus the estimated cost of batches still in
 * flight. A usage figure only: the limit is the one LLM budget in the seo-agent (llm-gate.ts), not anything here.
 * Ask the Blog (purpose "ask…") and the news desk (purpose "news…") are left out of this card's figure; the budget
 * itself counts every row.
 */
export async function budgetState(db: Db, now = new Date()): Promise<BudgetState> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const byModel = rowsOf<{ model: string; cost: number; calls: number; cr: number; inp: number }>(
    await db.execute(sql`select model, sum(cost_usd)::float8 as cost, count(*)::int as calls, sum(cache_read_tokens)::float8 as cr, sum(input_tokens)::float8 as inp from seo_llm_usage where at >= ${monthStart} and purpose not like 'ask%' and purpose not like 'news%' group by model order by cost desc`),
  ).map((r) => ({ model: r.model, costUsd: Number(r.cost), calls: Number(r.calls), cacheReadTokens: Number(r.cr), inputTokens: Number(r.inp) }));
  const [res] = rowsOf<{ n: number | null }>(await db.execute(sql`select sum(estimated_cost_usd)::float8 as n from seo_llm_batches where status = 'in_progress'`));
  return { spentUsd: byModel.reduce((s, r) => s + r.costUsd, 0), reservedUsd: Number(res?.n ?? 0), monthStart: monthStart.slice(0, 10), byModel };
}

export type FlowCost = { flow: string; runs: number; costUsd: number; tokens: number; share: number };
export type FlowCostBreakdown = { monthStart: string; flows: FlowCost[]; outsideFlowsUsd: number; totalUsd: number };

/**
 * Month-to-date spend per seo-agent flow (v5), from seo_flow_runs.cost_usd (every run's model cost, written by the
 * agent's CrewAI persistence). News flows are left out (the news agent's), as is Ask the Blog (no flow).
 * "Outside flows" = the admin month's spend in seo_llm_usage minus the flows: the v2 legacy path, keyword intents and
 * recommendation explanations. A flow's cost lands in the month its run started.
 */
export async function flowCostBreakdown(db: Db, spentUsd: number, now = new Date()): Promise<FlowCostBreakdown> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  let rows: { flow_name: string; runs: number; cost: number; tokens: number }[] = [];
  try {
    rows = rowsOf<{ flow_name: string; runs: number; cost: number; tokens: number }>(
      await db.execute(sql`select flow_name, count(*)::int as runs, coalesce(sum(cost_usd), 0)::float8 as cost, coalesce(sum(tokens), 0)::float8 as tokens
        from seo_flow_runs where started_at >= ${monthStart} and flow_name not like 'news%' group by flow_name order by cost desc, flow_name`),
    );
  } catch {
    rows = []; // migration 0016 not applied (legacy installs): no flows, everything is "outside flows"
  }
  const inFlows = rows.reduce((s, r) => s + Number(r.cost), 0);
  const totalUsd = Math.max(spentUsd, inFlows);
  const flows = rows.map((r) => ({ flow: r.flow_name, runs: Number(r.runs), costUsd: Number(r.cost), tokens: Number(r.tokens), share: totalUsd > 0 ? Number(r.cost) / totalUsd : 0 }));
  return { monthStart: monthStart.slice(0, 10), flows, outsideFlowsUsd: Math.max(0, spentUsd - inFlows), totalUsd };
}

export class BudgetExceeded extends Error {
  readonly code = "budget";
}

export type ClaudeJsonOpts<T> = {
  model: string;
  purpose: string;
  promptVersion: string;
  call: Omit<ModelCall, "signal"> & { timeoutMs?: number };
  schema: z.ZodType<T>;
  /** Semantic checks after the schema (e.g. block ids exist). Issues trigger the one retry, with the issues as feedback. */
  check?: (value: T) => string[];
  draftId?: string | null;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** The one LLM budget. Default: the seo-agent's (llm-gate.ts). */
  gate?: LlmGate;
};
export type ClaudeJsonResult<T> = { ok: true; value: T; attempts: number; requestIds: string[]; costUsd: number } | { ok: false; reason: "not_configured" | "budget" | "invalid" | "error" | "refusal"; detail: string; attempts: number; costUsd: number };

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return undefined;
  }
}

/**
 * One validated structured call with at most one retry: schema or semantic failure → retry with the problems listed
 * → still invalid → `{ ok: false, reason: "invalid" }` (the caller marks the draft generation_failed). Refuses before
 * calling when the one LLM budget (llm-gate.ts) has no room for the call's upper bound.
 */
export async function claudeJson<T>(db: Db, cfg: ClaudeConfig, o: ClaudeJsonOpts<T>): Promise<ClaudeJsonResult<T>> {
  if (!cfg.apiKey) return { ok: false, reason: "not_configured", detail: "ANTHROPIC_API_KEY is not set.", attempts: 0, costUsd: 0 };
  let feedback = "";
  let spent = 0;
  const requestIds: string[] = [];
  const gate = o.gate ?? agentGate();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = feedback ? `${o.call.user}\n\n<feedback>Your previous answer was rejected by the validator:\n${feedback}\nAnswer again with the complete JSON object, fixing every problem.</feedback>` : o.call.user;
    const chars = user.length + o.call.system.length + (o.call.cachedSystem ?? []).join("").length;
    const held = await gate.reserve(estimateCostUsd(o.model, chars, o.call.maxTokens), o.purpose);
    if (!held.ok) {
      log.warn("seo llm call refused by the budget", { operation: "seo_llm", outcome: "budget", model: o.model });
      return { ok: false, reason: "budget", detail: held.detail, attempts: attempt - 1, costUsd: spent };
    }
    const started = performance.now();
    let res: ModelResult;
    try {
      res = await callModel({ provider: "anthropic", model: o.model, enabled: true, baseUrl: "", region: "", apiKey: null, timeoutMs: o.call.timeoutMs ?? 120_000, maxOutputTokens: o.call.maxTokens, inputUsdPerMTok: 0, outputUsdPerMTok: 0 }, cfg.apiKey, { ...o.call, user, signal: AbortSignal.timeout(o.call.timeoutMs ?? 120_000) }, o.fetchImpl);
    } catch (e) {
      const err = e instanceof ProviderError ? e : mapAnthropicError(e);
      const refusal = /declined/.test(err.message);
      await logUsage(db, { model: o.model, purpose: o.purpose, promptVersion: o.promptVersion, mode: "sync", inputTokens: 0, outputTokens: 0, latencyMs: Math.round(performance.now() - started), outcome: refusal ? "refusal" : "error", errorCode: err.code, draftId: o.draftId });
      await gate.settle(held.id);
      log.warn("seo claude call failed", { operation: "seo_llm", outcome: "error", errorCode: err.code, model: o.model, attempt });
      if (!err.retryable || attempt === 2) return { ok: false, reason: refusal ? "refusal" : "error", detail: err.message, attempts: attempt, costUsd: spent };
      continue;
    }
    if (res.requestId) requestIds.push(res.requestId);
    const parsed = o.schema.safeParse(parseJsonText(res.text));
    const issues = parsed.success ? (o.check?.(parsed.data) ?? []) : parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
    spent += await logUsage(db, { model: res.model ?? o.model, purpose: o.purpose, promptVersion: o.promptVersion, mode: "sync", requestId: res.requestId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, cacheReadTokens: res.cacheReadTokens, cacheWriteTokens: res.cacheWriteTokens, latencyMs: Math.round(performance.now() - started), outcome: issues.length ? "invalid" : "ok", draftId: o.draftId });
    await gate.settle(held.id);
    log.info("seo claude call", { operation: "seo_llm", outcome: issues.length ? "invalid" : "ok", model: o.model, attempt, inputTokens: res.inputTokens, outputTokens: res.outputTokens, cacheReadTokens: res.cacheReadTokens, promptVersion: o.promptVersion });
    if (parsed.success && !issues.length) return { ok: true, value: parsed.data, attempts: attempt, requestIds, costUsd: spent };
    feedback = issues.map((i) => `- ${i}`).join("\n");
  }
  return { ok: false, reason: "invalid", detail: `Invalid output after a retry: ${feedback.slice(0, 900)}`, attempts: 2, costUsd: spent };
}

// --- Message Batches (weekly bulk generation: not latency-sensitive, 50 % cheaper) --------------------------------

export type BatchRequest = { customId: string; call: Omit<ModelCall, "signal"> };

/**
 * Create a batch after holding its estimated cost against the one LLM budget (llm-gate.ts). Returns null when it
 * does not fit. The hold is let go once the batch row exists: from then on the in-flight row is what is counted.
 */
export async function submitBatch(db: Db, cfg: ClaudeConfig, model: string, requests: BatchRequest[], deps: { fetchImpl?: typeof fetch; now?: Date; gate?: LlmGate } = {}): Promise<{ id: string; estimatedCostUsd: number } | null> {
  if (!requests.length) return null;
  const estimate = requests.reduce((s, r) => s + estimateCostUsd(model, r.call.user.length + (r.call.cachedSystem ?? []).join("").length, r.call.maxTokens, "batch"), 0);
  const gate = deps.gate ?? agentGate();
  const held = await gate.reserve(estimate, "draft_batch");
  if (!held.ok) {
    log.warn("seo batch refused by budget", { operation: "seo_llm_batch", outcome: "budget", requests: requests.length });
    return null;
  }
  const client = anthropicClient(cfg.apiKey, deps.fetchImpl);
  try {
    const batch = await client.messages.batches.create({ requests: requests.map((r) => ({ custom_id: r.customId, params: messageParams(model, r.call) })) });
    await db.execute(sql`insert into seo_llm_batches (id, status, model, request_count, estimated_cost_usd) values (${batch.id}, 'in_progress', ${model}, ${requests.length}, ${estimate})`);
    log.info("seo batch submitted", { operation: "seo_llm_batch", outcome: "submitted", requests: requests.length });
    return { id: batch.id, estimatedCostUsd: estimate };
  } catch (e) {
    throw mapAnthropicError(e);
  } finally {
    await gate.settle(held.id);
  }
}

export type BatchItem = { customId: string; ok: true; text: string; requestId: null } | { customId: string; ok: false; error: string };

/**
 * Poll in-flight batches. For each ended batch, stream its results (any order; keyed by custom_id), log usage at
 * batch prices, hand each result to `onResult`, then release the budget reservation.
 */
export async function pollBatches(db: Db, cfg: ClaudeConfig, onResult: (batchId: string, item: BatchItem) => Promise<void>, deps: { fetchImpl?: typeof fetch; promptVersion: string; purpose: string }): Promise<{ checked: number; processed: number }> {
  const open = rowsOf<{ id: string; model: string }>(await db.execute(sql`select id, model from seo_llm_batches where status = 'in_progress' order by created_at`));
  if (!open.length) return { checked: 0, processed: 0 };
  const client = anthropicClient(cfg.apiKey, deps.fetchImpl);
  let processed = 0;
  for (const b of open) {
    let status: string;
    try {
      status = (await client.messages.batches.retrieve(b.id)).processing_status;
    } catch (e) {
      log.warn("seo batch poll failed", { operation: "seo_llm_batch", outcome: "error", errorCode: mapAnthropicError(e).code });
      continue;
    }
    if (status !== "ended") continue;
    for await (const r of await client.messages.batches.results(b.id)) {
      if (r.result.type === "succeeded") {
        const m = r.result.message;
        try {
          const res = resultOf(m, null);
          await logUsage(db, { model: m.model, purpose: deps.purpose, promptVersion: deps.promptVersion, mode: "batch", inputTokens: res.inputTokens, outputTokens: res.outputTokens, cacheReadTokens: res.cacheReadTokens, cacheWriteTokens: res.cacheWriteTokens, outcome: "ok" });
          await onResult(b.id, { customId: r.custom_id, ok: true, text: res.text, requestId: null });
        } catch (e) {
          await logUsage(db, { model: m.model, purpose: deps.purpose, promptVersion: deps.promptVersion, mode: "batch", inputTokens: m.usage.input_tokens ?? 0, outputTokens: m.usage.output_tokens ?? 0, outcome: "refusal" });
          await onResult(b.id, { customId: r.custom_id, ok: false, error: (e as Error).message });
        }
      } else {
        await onResult(b.id, { customId: r.custom_id, ok: false, error: r.result.type === "errored" ? `Batch request failed (${r.result.error.error?.type ?? "error"})` : `Batch request ${r.result.type}` });
      }
      processed++;
    }
    await db.execute(sql`update seo_llm_batches set status = 'ended', ended_at = now(), processed_at = now(), estimated_cost_usd = 0 where id = ${b.id}`);
  }
  return { checked: open.length, processed };
}
