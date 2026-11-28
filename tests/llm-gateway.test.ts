import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

/**
 * LiteLLM as the gateway for the web app's own model calls (D-109, lib/llm-gateway.ts): the drafts and keyword intents
 * (lib/seo-intel/claude.ts), the SEO enrichment (lib/seo-intel/llm.ts) and the Practice tutor (lib/practice/ai) go to
 * LiteLLM's Chat Completions API with their own virtual keys and its aliases; LiteLLM's budget refusals and charges are
 * what the site acts on and books. The stand-in answers as LiteLLM 1.111 did against a local proxy on 2026-11-28.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { llmGateway, gatewayModel, budgetRefusal, gatewayKeys, GatewayBudgetError } = await import("@/lib/llm-gateway");
const { callModel, ProviderError } = await import("@/lib/practice/ai/providers");

const ENV = { LITELLM_BASE_URL: "http://litellm.test:4000/v1", LITELLM_API_KEY: "sk-seo-key", LITELLM_PRACTICE_API_KEY: "sk-practice-key" };
const TARGET: Record<string, string> = { "moks-cms-default": "anthropic/claude-sonnet-5-5", "moks-cms-fast": "anthropic/claude-haiku-5-5" };

type Seen = { url: string; body: Record<string, unknown>; auth: string | null };

/** A LiteLLM stand-in: `answer` per call (content, or status + error body). */
function fakeLiteLLM(answers: ({ content?: string; status?: number; error?: Record<string, unknown>; cost?: string })[] = []) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    if (String(url).endsWith("/key/info")) {
      const practice = auth === "Bearer sk-practice-key";
      return Response.json({ info: { key_alias: practice ? "jithendar-practice" : "jithendar-seo", spend: practice ? 0.12 : 3.4, max_budget: practice ? 1 : null, budget_duration: practice ? "1d" : null, budget_reset_at: practice ? "2026-11-29T00:00:00+00:00" : null, models: ["moks-cms-fast"] } });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ url: String(url), body, auth });
    const a = answers.shift() ?? {};
    if (a.status) return Response.json({ error: a.error }, { status: a.status });
    const model = String(body.model);
    if (!TARGET[model]) return Response.json({ error: { message: `The requested model '${model}' is not available for this API key`, type: "key_model_access_denied" } }, { status: 403 });
    return Response.json(
      { id: "chatcmpl-1", model, choices: [{ message: { role: "assistant", content: a.content ?? JSON.stringify({ ok: true }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } } },
      { headers: { "x-litellm-response-cost": a.cost ?? "0.0042", "x-litellm-model-name": TARGET[model]!, "x-litellm-call-id": "call-1" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const keyOver = { status: 422, error: { message: "Budget has been exceeded! Key=abc Current cost: 1.02, Max budget: 1.0", type: "budget_exceeded", code: "422" } };

describe("the gateway's settings", () => {
  it("are on only with a URL and a key; models are asked by tier", () => {
    expect(llmGateway({ LITELLM_BASE_URL: ENV.LITELLM_BASE_URL })).toBeNull();
    expect(llmGateway({ LITELLM_API_KEY: "k" })).toBeNull();
    const gw = llmGateway({ ...ENV, LITELLM_BASE_URL: "http://litellm.test:4000/v1/" })!;
    expect(gw).toMatchObject({ baseUrl: "http://litellm.test:4000/v1", root: "http://litellm.test:4000", seoKey: "sk-seo-key", practiceKey: "sk-practice-key", modelDefault: "moks-cms-default", modelFast: "moks-cms-fast", modelPractice: "moks-cms-fast" });
    expect(llmGateway({ LITELLM_BASE_URL: "http://x/v1", LITELLM_API_KEY: "k" })!.practiceKey).toBe("k"); // no tutor key: the SEO key
    expect([gatewayModel(gw, "claude-sonnet-5-5"), gatewayModel(gw, "claude-haiku-5-5"), gatewayModel(gw, "moks-cms-writer"), gatewayModel(gw, "")]).toEqual(["moks-cms-default", "moks-cms-fast", "moks-cms-writer", "moks-cms-default"]);
  });

  it("read LiteLLM's budget refusals, whoever's budget it is", () => {
    const key = budgetRefusal(422, keyOver, "the tutor's key")!;
    expect(key).toBeInstanceOf(GatewayBudgetError);
    expect(key.scope).toBe("key");
    expect(key.message).toContain("the tutor's key is used up (1.02, Max budget: 1.0)");
    expect(budgetRefusal(422, { error: { message: "Budget has been exceeded! Team=t1 Current cost: 20.1, Max budget: 20.0", type: "budget_exceeded" } }, "x")!.scope).toBe("team");
    expect(budgetRefusal(400, { error: { message: "bad request", type: "invalid_request_error" } }, "x")).toBeNull();
  });
});

describe("the litellm provider", () => {
  const settings = { provider: "litellm" as const, model: "moks-cms-fast", baseUrl: ENV.LITELLM_BASE_URL, enabled: true, region: "", apiKey: null, timeoutMs: 5000, maxOutputTokens: 300, inputUsdPerMTok: 0, outputUsdPerMTok: 0 };
  const call = { system: "Answer briefly.", cachedSystem: ["Rules.", "Style."], user: "Hi", schema: { type: "object" }, maxTokens: 300, signal: AbortSignal.timeout(5000) };

  it("sends cached system blocks, the schema and the alias; returns LiteLLM's charge and the model that answered", async () => {
    const { fetchImpl, seen } = fakeLiteLLM([{ content: '{"a":1}', cost: "0.0031" }]);
    const r = await callModel(settings, "sk-seo-key", call, fetchImpl);
    expect(seen[0]!.url).toBe("http://litellm.test:4000/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer sk-seo-key");
    const messages = seen[0]!.body.messages as { role: string; content: unknown }[];
    expect(messages[0]!.content).toEqual([{ type: "text", text: "Rules." }, { type: "text", text: "Style.", cache_control: { type: "ephemeral" } }, { type: "text", text: "Answer briefly." }]);
    expect(seen[0]!.body).toMatchObject({ model: "moks-cms-fast", max_tokens: 300, response_format: { type: "json_schema", json_schema: { strict: false, schema: { type: "object" } } } });
    expect(r).toMatchObject({ text: '{"a":1}', inputTokens: 600, cacheReadTokens: 400, outputTokens: 200, costUsd: 0.0031, model: "claude-haiku-5-5", requestId: "call-1", stopReason: "end_turn" });
  });

  it("raises a budget refusal as GatewayBudgetError, and other refusals as provider errors without the key", async () => {
    await expect(callModel(settings, "sk-seo-key", call, fakeLiteLLM([keyOver]).fetchImpl)).rejects.toBeInstanceOf(GatewayBudgetError);
    const denied = await callModel({ ...settings, model: "gpt-x" }, "sk-seo-key", call, fakeLiteLLM().fetchImpl).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ProviderError);
    expect((denied as InstanceType<typeof ProviderError>).code).toBe("auth");
    expect(String((denied as Error).message)).toContain("key_model_access_denied");
    expect(String((denied as Error).message)).not.toContain("sk-seo-key");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(callModel(settings, "k", call, down)).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("reads each key's budget with the key itself", async () => {
    const gw = llmGateway(ENV)!;
    const { keys, errors } = await gatewayKeys(gw, fakeLiteLLM().fetchImpl);
    expect(errors).toEqual([]);
    expect(keys).toEqual([
      { caller: "seo", alias: "jithendar-seo", spendUsd: 3.4, maxBudgetUsd: null, budgetDuration: null, budgetResetAt: null, models: ["moks-cms-fast"] },
      { caller: "practice", alias: "jithendar-practice", spendUsd: 0.12, maxBudgetUsd: 1, budgetDuration: "1d", budgetResetAt: "2026-11-29T00:00:00+00:00", models: ["moks-cms-fast"] },
    ]);
  });
});

describe("the web app's SEO calls through LiteLLM", () => {
  let db: Db;
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    // An SEO agent that cannot be reached: a call that asked its budget would fail as "not checked".
    for (const [k, v] of Object.entries({ ...ENV, ANTHROPIC_API_KEY: "", SEO_AGENT_TOKEN: "t".repeat(40), SEO_AGENT_URL: "http://127.0.0.1:9" })) {
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

  it("drafts and keyword intents need no Anthropic key, never ask the agent's budget (LiteLLM's applies), and book LiteLLM's charge", async () => {
    const { getSeoSettings, claudeConfig, claudeReady } = await import("@/lib/seo-intel/settings");
    const { claudeJson } = await import("@/lib/seo-intel/claude");
    const cfg = claudeConfig(await getSeoSettings());
    expect(cfg.apiKey).toBeNull();
    expect(claudeReady(cfg)).toBe(true);
    const { fetchImpl, seen } = fakeLiteLLM([{ content: '{"intent":"informational"}', cost: "0.0042" }]);
    const r = await claudeJson(db, cfg, { model: "claude-haiku-5-5", purpose: "intent", promptVersion: "v1", call: { system: "Classify.", user: "query", schema: {}, maxTokens: 200 }, schema: z.object({ intent: z.string() }), fetchImpl });
    expect(r).toMatchObject({ ok: true, value: { intent: "informational" }, costUsd: 0.0042 });
    expect(seen[0]!.body.model).toBe("moks-cms-fast");
    expect(seen[0]!.auth).toBe("Bearer sk-seo-key");
    const [row] = rowsOf<{ provider: string; model: string; cost_usd: number; cache_read_tokens: number }>(await db.execute(sql`select provider, model, cost_usd::float8 as cost_usd, cache_read_tokens from seo_llm_usage`));
    expect(row).toEqual({ provider: "litellm", model: "claude-haiku-5-5", cost_usd: 0.0042, cache_read_tokens: 400 });

    const refused = await claudeJson(db, cfg, { model: "claude-sonnet-5-5", purpose: "draft", promptVersion: "v1", call: { system: "x", user: "y", schema: {}, maxTokens: 200 }, schema: z.object({}), fetchImpl: fakeLiteLLM([keyOver]).fetchImpl });
    expect(refused).toMatchObject({ ok: false, reason: "budget" });
    expect((refused as { detail: string }).detail).toContain("LiteLLM refused the call");
  });

  it("the SEO enrichment uses LiteLLM's fast alias with the SEO key, and stops on its budget", async () => {
    const { saveSeoSettings, getSeoSettings, llmConfigured } = await import("@/lib/seo-intel/settings");
    const { llmJson } = await import("@/lib/seo-intel/llm");
    await saveSeoSettings({ ...settingsInput(), llm: { ...settingsInput().llm, enabled: true, provider: "openai", model: "" } }, "admin");
    const s = await getSeoSettings();
    expect(llmConfigured(s)).toBe(true); // no model or key here: LiteLLM has them
    const opts = { promptVersion: "test-v1", task: "Explain.", blocks: [{ name: "article", content: { t: 1 } }], jsonSchema: { type: "object" }, schema: z.object({ ok: z.boolean() }) };
    const { fetchImpl, seen } = fakeLiteLLM();
    expect(await llmJson(db, s, opts, { fetchImpl })).toMatchObject({ ok: true });
    expect(seen[0]).toMatchObject({ auth: "Bearer sk-seo-key", body: { model: "moks-cms-fast" } });
    const [cache] = rowsOf<{ provider: string; model: string }>(await db.execute(sql`select provider, model from seo_llm_cache`));
    expect(cache).toEqual({ provider: "litellm", model: "moks-cms-fast" });
    expect(await llmJson(db, s, { ...opts, task: "Other." }, { fetchImpl: fakeLiteLLM([keyOver]).fetchImpl })).toMatchObject({ ok: false, reason: "limit" });
  });

  it("the Practice tutor is available with LiteLLM alone (its key and model live there)", async () => {
    const { aiConfigured, getPracticeSettings } = await import("@/lib/practice/settings");
    const ps = await getPracticeSettings();
    expect(aiConfigured({ ...ps, ai: { ...ps.ai, enabled: true, model: "", apiKey: null } })).toBe(true);
    expect(aiConfigured({ ...ps, ai: { ...ps.ai, enabled: false } })).toBe(false);
  });
});
