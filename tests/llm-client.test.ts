import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

/**
 * The web app's one LLM client (D-110, lib/llm/client.ts): LiteLLM is the only way it calls a model. The stand-in
 * answers as LiteLLM 1.111 did against a local proxy (headers x-litellm-response-cost, x-litellm-model-name,
 * x-litellm-call-id; 422 budget_exceeded; 403 key_model_access_denied; /key/info and /team/info at the root).
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const llm = await import("@/lib/llm/client");
const { chat, chatStream, checkLlm, errorFromResponse, lastLlmHealth, llmConfig, llmMissing, llmUsage, requestBody } = llm;

const ENV = { LITELLM_BASE_URL: "http://litellm.test:4000/v1/", LITELLM_API_KEY: "sk-seo-key-123456", LITELLM_PRACTICE_API_KEY: "sk-practice-key-654321" };
const CFG = llmConfig(ENV)!;
const TARGET: Record<string, string> = { "moks-cms-default": "anthropic/claude-sonnet-5-5", "moks-cms-fast": "anthropic/claude-haiku-5-5" };
const noSleep = { sleep: async () => undefined };

type Seen = { url: string; body: Record<string, unknown>; auth: string | null };
type Answer = { content?: string; status?: number; error?: Record<string, unknown>; cost?: string | null; finish?: string; toolCalls?: unknown[]; headers?: Record<string, string>; throw?: Error };

/** A LiteLLM stand-in: one answer per call, in order. */
function fakeLiteLLM(answers: Answer[] = []) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    seen.push({ url: String(url), body, auth });
    const a = answers.shift() ?? {};
    if (a.throw) throw a.throw;
    if (a.status) return Response.json({ error: a.error }, { status: a.status, headers: a.headers });
    const model = String(body.model);
    if (!TARGET[model]) return Response.json({ error: { message: `The requested model '${model}' is not available for this API key`, type: "key_model_access_denied" } }, { status: 403 });
    const headers: Record<string, string> = { "x-litellm-model-name": TARGET[model]!, "x-litellm-call-id": "call-1", ...(a.cost === null ? {} : { "x-litellm-response-cost": a.cost ?? "0.0042" }) };
    return Response.json(
      { id: "chatcmpl-1", model, choices: [{ message: { role: "assistant", content: a.content ?? JSON.stringify({ ok: true }), ...(a.toolCalls ? { tool_calls: a.toolCalls } : {}) }, finish_reason: a.finish ?? "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } } },
      { headers },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const keyOver = { status: 422, error: { message: "Budget has been exceeded! Key=abc Current cost: 1.02, Max budget: 1.0", type: "budget_exceeded", code: "422" } };
const teamOver = { status: 422, error: { message: "Budget has been exceeded! Team=jithendar.com Current cost: 20.5, Max budget: 20.0", type: "budget_exceeded" } };

describe("settings come from the environment only", () => {
  it("are off without the endpoint or the key; aliases default to moks-cms-default / moks-cms-fast", () => {
    expect(llmConfig({ LITELLM_BASE_URL: ENV.LITELLM_BASE_URL })).toBeNull();
    expect(llmConfig({ LITELLM_API_KEY: "k" })).toBeNull();
    expect(llmConfig({ LITELLM_BASE_URL: "litellm:4000", LITELLM_API_KEY: "k" })).toBeNull(); // not a URL
    expect(llmMissing({})).toEqual(["LITELLM_BASE_URL", "LITELLM_API_KEY"]);
    expect(llmMissing({ LITELLM_BASE_URL: "http://x/v1" })).toEqual(["LITELLM_API_KEY"]);
    expect(CFG).toMatchObject({ baseUrl: "http://litellm.test:4000/v1", root: "http://litellm.test:4000", model: "moks-cms-default", modelFast: "moks-cms-fast", modelPractice: "moks-cms-fast", timeoutMs: 120_000, keys: { seo: ENV.LITELLM_API_KEY, practice: ENV.LITELLM_PRACTICE_API_KEY } });
    expect(llmConfig({ LITELLM_BASE_URL: "http://x/v1", LITELLM_API_KEY: "k" })!.keys.practice).toBe("k"); // no tutor key: the main key
    const renamed = llmConfig({ ...ENV, LITELLM_MODEL: "site-main", LITELLM_MODEL_FAST: "site-fast", LITELLM_MODEL_PRACTICE: "tutor", LITELLM_TIMEOUT_MS: "30000" })!;
    expect(renamed).toMatchObject({ model: "site-main", modelFast: "site-fast", modelPractice: "tutor", timeoutMs: 30_000 });
    expect(llmConfig({ ...ENV, LITELLM_MODEL: "bad alias with spaces" })!.model).toBe("moks-cms-default");
  });
});

describe("a call", () => {
  it("sends the alias, cached system blocks, the schema and spend tags with the caller's key; returns LiteLLM's charge", async () => {
    const { fetchImpl, seen } = fakeLiteLLM([{ content: '{"a":1}', cost: "0.0042" }]);
    const r = await chat({ cachedSystem: ["RULES", "STYLE"], system: "Task.", user: "Hi", maxTokens: 300, schema: { schema: { type: "object" } }, tags: ["moks-cms", "purpose:test"] }, { config: CFG, fetchImpl });
    expect(seen[0]!.url).toBe("http://litellm.test:4000/v1/chat/completions");
    expect(seen[0]!.auth).toBe(`Bearer ${ENV.LITELLM_API_KEY}`);
    expect(seen[0]!.body).toMatchObject({
      model: "moks-cms-default",
      max_tokens: 300,
      messages: [{ role: "system", content: [{ type: "text", text: "RULES" }, { type: "text", text: "STYLE", cache_control: { type: "ephemeral" } }, { type: "text", text: "Task." }] }, { role: "user", content: "Hi" }],
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: false } },
      metadata: { tags: ["moks-cms", "purpose:test"] },
    });
    expect(r).toMatchObject({ text: '{"a":1}', costUsd: 0.0042, alias: "moks-cms-default", model: "claude-sonnet-5-5", requestId: "call-1", usage: { inputTokens: 600, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 0 } });
  });

  it("the tutor uses its own key and alias; tools, tool choice, web search and a plain system text are sent as asked", async () => {
    const { fetchImpl, seen } = fakeLiteLLM([{ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }], finish: "tool_calls" }]);
    const r = await chat({ caller: "practice", system: "Be brief.", user: "Q", maxTokens: 100, tools: [{ name: "lookup", parameters: { type: "object" } }], toolChoice: { name: "lookup" }, webSearch: { contextSize: "low" }, json: true }, { config: CFG, fetchImpl });
    expect(seen[0]!.auth).toBe(`Bearer ${ENV.LITELLM_PRACTICE_API_KEY}`);
    expect(seen[0]!.body).toMatchObject({ model: "moks-cms-fast", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Q" }], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }], tool_choice: { type: "function", function: { name: "lookup" } }, web_search_options: { search_context_size: "low" }, response_format: { type: "json_object" } });
    expect(r.toolCalls).toEqual([{ id: "t1", name: "lookup", arguments: '{"q":"x"}' }]);
    expect(r.finishReason).toBe("tool_calls");
    expect(requestBody({ user: "x", maxTokens: 1, webSearch: true }, CFG)).toMatchObject({ web_search_options: {} });
  });

  it("without the endpoint and key there is no call at all", async () => {
    const { fetchImpl, seen } = fakeLiteLLM();
    await expect(chat({ user: "x", maxTokens: 10 }, { config: null, fetchImpl })).rejects.toMatchObject({ code: "not_configured" });
    expect(seen).toHaveLength(0);
  });

  it("LiteLLM's budget refusals are code budget, whoever's budget it is, and are never retried", async () => {
    const key = fakeLiteLLM([keyOver]);
    await expect(chat({ user: "x", maxTokens: 10 }, { config: CFG, fetchImpl: key.fetchImpl, ...noSleep })).rejects.toMatchObject({ code: "budget", scope: "key", retryable: false, message: expect.stringContaining("budget of this key is used up (1.02, Max budget: 1.0)") });
    expect(key.seen).toHaveLength(1);
    const team = errorFromResponse(teamOver.status, { error: teamOver.error });
    expect(team).toMatchObject({ code: "budget", scope: "team" });
  });

  it("maps every other refusal to one error type, and never puts a key in a message", async () => {
    await expect(chat({ model: "nope", user: "x", maxTokens: 10 }, { config: CFG, fetchImpl: fakeLiteLLM().fetchImpl })).rejects.toMatchObject({ code: "model_access", status: 403 });
    expect(errorFromResponse(400, { error: { message: "Invalid model name passed in model=nope", type: "invalid_request_error" } }).code).toBe("model_access");
    const auth = errorFromResponse(401, { error: { message: `Authentication Error, Invalid proxy server token passed. Received API Key = ${ENV.LITELLM_API_KEY}`, type: "auth_error" } }, [ENV.LITELLM_API_KEY]);
    expect(auth).toMatchObject({ code: "auth", retryable: false });
    expect(auth.message).not.toContain(ENV.LITELLM_API_KEY);
    const echoed = errorFromResponse(400, { error: { message: `bad request for key sk-abcdef123456 and api_key=sk-zzz` } });
    expect(echoed.message).not.toMatch(/sk-abcdef|sk-zzz/);
    expect(errorFromResponse(400, { error: { message: "Output blocked by content filtering policy" } }).code).toBe("refusal");
    expect(errorFromResponse(422, { error: { message: "max_tokens too large" } }).code).toBe("bad_request");
    for (const [status, code] of [[408, "timeout"], [429, "rate_limited"], [500, "unavailable"], [503, "unavailable"], [409, "unavailable"]] as const) expect(errorFromResponse(status, {})).toMatchObject({ code, retryable: true });
  });

  it("retries 429 and 5xx with backoff (Retry-After first), then answers; gives up after its retries", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const ok = fakeLiteLLM([{ status: 429, error: { message: "rate" }, headers: { "retry-after": "2" } }, { status: 503, error: { message: "busy" } }, { content: "fine" }]);
    expect((await chat({ user: "x", maxTokens: 10 }, { config: CFG, fetchImpl: ok.fetchImpl, sleep })).text).toBe("fine");
    expect(waits).toEqual([2000, 1000]);
    const down = fakeLiteLLM([{ status: 502 }, { status: 502 }, { status: 502 }, { content: "never" }]);
    await expect(chat({ user: "x", maxTokens: 10 }, { config: CFG, fetchImpl: down.fetchImpl, ...noSleep })).rejects.toMatchObject({ code: "unavailable", status: 502 });
    expect(down.seen).toHaveLength(3);
    const lost = fakeLiteLLM([{ throw: new TypeError("fetch failed") }, { content: "back" }]);
    expect((await chat({ user: "x", maxTokens: 10, retries: 1 }, { config: CFG, fetchImpl: lost.fetchImpl, ...noSleep })).text).toBe("back");
    const once = fakeLiteLLM([{ throw: new TypeError("fetch failed") }]);
    await expect(chat({ user: "x", maxTokens: 10, retries: 0 }, { config: CFG, fetchImpl: once.fetchImpl })).rejects.toMatchObject({ code: "unavailable", message: "LiteLLM could not be reached." });
  });

  it("a timeout and a caller's cancel are timeouts; only the first is retried", async () => {
    const slow = (async (_u: string, init: RequestInit = {}) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(chat({ user: "x", maxTokens: 10, timeoutMs: 20, retries: 0 }, { config: CFG, fetchImpl: slow })).rejects.toMatchObject({ code: "timeout", retryable: true });
    const ctl = new AbortController();
    const p = chat({ user: "x", maxTokens: 10, signal: ctl.signal }, { config: CFG, fetchImpl: slow, ...noSleep });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: "timeout", retryable: false });
  });

  it("a filtered or empty answer is an error; a missing cost header is null, never guessed", async () => {
    await expect(chat({ user: "x", maxTokens: 10 }, { config: CFG, fetchImpl: fakeLiteLLM([{ finish: "content_filter" }]).fetchImpl })).rejects.toMatchObject({ code: "refusal" });
    await expect(chat({ user: "x", maxTokens: 10 }, { config: CFG, fetchImpl: fakeLiteLLM([{ content: "" }]).fetchImpl })).rejects.toMatchObject({ code: "bad_response" });
    expect((await chat({ user: "x", maxTokens: 10 }, { config: CFG, fetchImpl: fakeLiteLLM([{ cost: null }]).fetchImpl })).costUsd).toBeNull();
  });
});

describe("streaming", () => {
  const sse = (lines: string[]) => new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close(); } }), { headers: { "content-type": "text/event-stream", "x-litellm-model-name": "anthropic/claude-haiku-5-5", "x-litellm-call-id": "call-s" } });

  it("hands each piece over as it arrives and returns the whole answer, its usage and tool calls", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit = {}) => {
      body = JSON.parse(String(init.body));
      return sse([
        'data: {"id":"c1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"id":"c1","choices":[{"delta":{"content":"lo"}}]}\n',
        '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"look","arguments":"{\\"q\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":7}}\n\ndata: [DONE]\n\n',
      ]);
    }) as unknown as typeof fetch;
    const pieces: string[] = [];
    const r = await chatStream({ model: "moks-cms-fast", user: "x", maxTokens: 10 }, (d) => pieces.push(d), { config: CFG, fetchImpl });
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(pieces).toEqual(["Hel", "lo"]);
    expect(r).toMatchObject({ text: "Hello", finishReason: "tool_calls", toolCalls: [{ id: "t1", name: "look", arguments: '{"q":1}' }], usage: { inputTokens: 50, outputTokens: 7 }, costUsd: null, model: "claude-haiku-5-5", requestId: "call-s" });
  });

  it("an error in the stream is an LlmError", async () => {
    const fetchImpl = (async () => sse(['data: {"error":{"message":"Budget has been exceeded! Key=x","type":"budget_exceeded"}}\n\n'])) as unknown as typeof fetch;
    await expect(chatStream({ user: "x", maxTokens: 10 }, () => undefined, { config: CFG, fetchImpl })).rejects.toMatchObject({ code: "budget" });
  });
});

describe("health and usage (read only, with the app's own keys)", () => {
  it("checks the key against /v1/models and names the aliases LiteLLM does not list; never throws", async () => {
    const models = (ids: string[]) => (async () => Response.json({ data: ids.map((id) => ({ id })) })) as unknown as typeof fetch;
    expect(await checkLlm({ config: CFG, fetchImpl: models(["moks-cms-default", "moks-cms-fast", "other"]) })).toMatchObject({ configured: true, ok: true, missing: [], aliases: ["moks-cms-default", "moks-cms-fast", "other"] });
    expect(lastLlmHealth()).toMatchObject({ ok: true });
    expect((await checkLlm({ config: CFG, fetchImpl: models(["moks-cms-default"]) })).missing).toEqual(["moks-cms-fast"]);
    expect((await checkLlm({ config: CFG, fetchImpl: models(["all-proxy-models"]) })).missing).toEqual([]);
    const denied = (async () => Response.json({ error: { message: "Invalid proxy server token", type: "auth_error" } }, { status: 401 })) as unknown as typeof fetch;
    expect(await checkLlm({ config: CFG, fetchImpl: denied })).toMatchObject({ ok: false, status: 401, error: expect.stringContaining("rejected the key") });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkLlm({ config: CFG, fetchImpl: down })).toMatchObject({ ok: false, status: null, error: "LiteLLM could not be reached." });
    expect(await checkLlm({ config: null })).toMatchObject({ configured: false, ok: false });
  });

  it("reads each key's and the team's budget and spend with the keys themselves", async () => {
    const asked: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const auth = new Headers(init.headers).get("authorization");
      asked.push({ url, auth });
      if (url.endsWith("/key/info")) {
        const practice = auth === `Bearer ${ENV.LITELLM_PRACTICE_API_KEY}`;
        return Response.json({ info: { key_alias: practice ? "jithendar-practice" : "jithendar-web", spend: practice ? 0.12 : 3.4, max_budget: practice ? 1 : null, budget_duration: practice ? "1d" : null, budget_reset_at: null, models: ["moks-cms-fast"], team_id: "team-1", rpm_limit: 10 } });
      }
      if (url.includes("/team/info?team_id=team-1")) return Response.json({ team_info: { team_alias: "jithendar.com", spend: 9.5, max_budget: 20, budget_duration: "30d", budget_reset_at: "2026-12-01T00:00:00Z" } });
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const u = await llmUsage({ config: CFG, fetchImpl });
    expect(u.errors).toEqual([]);
    expect(u.keys.map((k) => [k.caller, k.alias, k.spendUsd, k.maxBudgetUsd])).toEqual([["seo", "jithendar-web", 3.4, null], ["practice", "jithendar-practice", 0.12, 1]]);
    expect(u.team).toMatchObject({ alias: "jithendar.com", spendUsd: 9.5, maxBudgetUsd: 20, budgetDuration: "30d" });
    expect(asked.map((a) => a.url)).toEqual(["http://litellm.test:4000/key/info", "http://litellm.test:4000/key/info", "http://litellm.test:4000/team/info?team_id=team-1"]);
    expect(asked.every((a) => a.auth === `Bearer ${ENV.LITELLM_API_KEY}` || a.auth === `Bearer ${ENV.LITELLM_PRACTICE_API_KEY}`)).toBe(true);
    expect((await llmUsage({ config: null })).errors[0]).toMatch(/not configured/);
  });

  it("the admin banner shows a used-up LiteLLM budget (team first, then a key); the alias picker keeps a value LiteLLM no longer lists", async () => {
    const { budgetStop } = await import("@/components/seo/LlmBudgetBanner");
    const key = (o: Record<string, unknown>) => ({ caller: "agent" as const, alias: "jithendar-agent", spend_usd: 1, max_budget_usd: null, budget_duration: null, budget_reset_at: null, models: [], tpm_limit: null, rpm_limit: null, ...o });
    expect(budgetStop(null)).toBeNull();
    expect(budgetStop({ team: null, keys: [key({})] })).toBeNull();
    expect(budgetStop({ team: { alias: "jithendar.com", spend_usd: 20.1, max_budget_usd: 20, budget_duration: "30d", budget_reset_at: null, models: [] }, keys: [] })).toMatchObject({ who: "the jithendar.com team", limitUsd: 20 });
    expect(budgetStop({ team: null, keys: [key({ caller: "ask", spend_usd: 1.2, max_budget_usd: 1 })] })).toMatchObject({ who: "the Ask the Blog key" });
    const { aliasOptions } = await import("@/components/seo/AliasPicker");
    expect(aliasOptions(["moks-cms-default", "moks-cms-fast"], "moks-cms-fast").map((o) => o.value)).toEqual(["moks-cms-default", "moks-cms-fast"]);
    expect(aliasOptions(["moks-cms-default"], "claude-opus-5-5")[0]).toEqual({ value: "claude-opus-5-5", label: "claude-opus-5-5 (not listed by LiteLLM)", missing: true });
  });
});

describe("the web app's model calls go through the client", () => {
  let db: Db;
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    for (const [k, v] of Object.entries({ ...ENV, ANTHROPIC_API_KEY: "sk-ant-must-not-be-used", OPENAI_API_KEY: "sk-openai-must-not-be-used" })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setDbForTests(undefined);
  });

  it("structured SEO calls book what LiteLLM charged and stop on its budget (no provider key is read)", async () => {
    const { modelJson } = await import("@/lib/seo-intel/model-calls");
    const { fetchImpl, seen } = fakeLiteLLM([{ content: '{"intent":"informational"}', cost: "0.0042" }]);
    const r = await modelJson(db, { model: "moks-cms-fast", purpose: "intent", promptVersion: "v1", call: { system: "Classify.", user: "query", schema: {}, maxTokens: 200 }, schema: z.object({ intent: z.string() }), fetchImpl });
    expect(r).toMatchObject({ ok: true, value: { intent: "informational" }, costUsd: 0.0042 });
    expect(seen[0]!.auth).toBe(`Bearer ${ENV.LITELLM_API_KEY}`);
    expect(seen[0]!.body.metadata).toEqual({ tags: ["moks-cms", "purpose:intent"] });
    const [row] = rowsOf<{ provider: string; model: string; cost_usd: number; cache_read_tokens: number }>(await db.execute(sql`select provider, model, cost_usd::float8 as cost_usd, cache_read_tokens from seo_llm_usage`));
    expect(row).toEqual({ provider: "litellm", model: "claude-haiku-5-5", cost_usd: 0.0042, cache_read_tokens: 400 });
    const refused = await modelJson(db, { model: "moks-cms-default", purpose: "draft", promptVersion: "v1", call: { system: "x", user: "y", schema: {}, maxTokens: 200 }, schema: z.object({}), fetchImpl: fakeLiteLLM([keyOver]).fetchImpl });
    expect(refused).toMatchObject({ ok: false, reason: "budget", detail: expect.stringContaining("LiteLLM refused the call") });
    expect(await modelJson(db, { model: "x", purpose: "draft", promptVersion: "v1", call: { system: "x", user: "y", schema: {}, maxTokens: 10 }, schema: z.object({}), config: null })).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("the SEO enrichment uses LiteLLM's fast alias, caches, and stops on its budget", async () => {
    const { saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");
    const { llmJson } = await import("@/lib/seo-intel/llm");
    await saveSeoSettings({ ...settingsInput(), llm: { ...settingsInput().llm, enabled: true } }, "admin");
    const s = await getSeoSettings();
    expect(s.llm).not.toHaveProperty("provider");
    const opts = { promptVersion: "test-v1", task: "Explain.", blocks: [{ name: "article", content: { t: 1 } }], jsonSchema: { type: "object" }, schema: z.object({ ok: z.boolean() }) };
    const { fetchImpl, seen } = fakeLiteLLM();
    expect(await llmJson(db, s, opts, { fetchImpl })).toMatchObject({ ok: true, cached: false });
    expect(seen[0]).toMatchObject({ auth: `Bearer ${ENV.LITELLM_API_KEY}`, body: { model: "moks-cms-fast" } });
    expect(await llmJson(db, s, opts, { fetchImpl })).toMatchObject({ ok: true, cached: true });
    expect(seen).toHaveLength(1);
    expect(await llmJson(db, s, { ...opts, task: "Other." }, { fetchImpl: fakeLiteLLM([keyOver]).fetchImpl })).toMatchObject({ ok: false, reason: "limit" });
    expect(await llmJson(db, s, opts, { config: null })).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("the Python practice tutor is on only with LiteLLM; its settings hold no provider, model, key or price", async () => {
    const { aiConfigured, getPracticeSettings, DEFAULT_SETTINGS } = await import("@/lib/practice/settings");
    const ps = await getPracticeSettings();
    expect(Object.keys(DEFAULT_SETTINGS.ai).sort()).toEqual(["enabled", "maxOutputTokens", "timeoutMs"]);
    expect(DEFAULT_SETTINGS.quotas).not.toHaveProperty("aiDailyBudgetUsd");
    expect(aiConfigured({ ...ps, ai: { ...ps.ai, enabled: true } }, ENV)).toBe(true);
    expect(aiConfigured({ ...ps, ai: { ...ps.ai, enabled: true } }, { OPENAI_API_KEY: "k" })).toBe(false);
    expect(aiConfigured({ ...ps, ai: { ...ps.ai, enabled: false } }, ENV)).toBe(false);
  });
});

describe("no direct model-provider calls in the web app (D-110)", () => {
  const root = path.resolve(import.meta.dirname, "..");
  it("only image and video generation still talk to a provider, and no provider SDK is a dependency", () => {
    const hits = execFileSync("git", ["grep", "-lE", String.raw`api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.perplexity\.ai|bedrock-runtime|@anthropic-ai/sdk|new Anthropic\(|ollama`, "--", "src"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
    // Image generation (Gemini), its key check, and video generation (Veo): not chat-model calls (docs/LLM_GATEWAY.md).
    expect(hits).toEqual(["src/lib/gemini.ts", "src/lib/integrations.ts", "src/lib/video-generation.ts"]);
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /anthropic|openai|bedrock-runtime|google\/genai|generative-ai|ollama/.test(d))).toEqual([]);
  });

  it("no provider key or model id is read by the model-call code", () => {
    const files = ["src/lib/llm/client.ts", "src/lib/seo-intel/model-calls.ts", "src/lib/seo-intel/llm.ts", "src/lib/seo-intel/drafts.ts", "src/lib/seo-intel/keywords.ts", "src/lib/seo-intel/ai-visibility.ts", "src/lib/practice/ai/tutor.ts", "src/lib/practice/settings.ts", "src/lib/seo-intel/settings.ts"];
    for (const f of files) {
      const text = readFileSync(path.join(root, f), "utf8");
      expect(text, f).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|PERPLEXITY_API_KEY|GOOGLE_API_KEY|BEDROCK_|OLLAMA_|SEO_DRAFT_MODEL|SEO_CLASSIFY_MODEL|SEO_LLM_MONTHLY_BUDGET_USD|"claude-(sonnet|haiku|opus|fable)/);
    }
  });
});

