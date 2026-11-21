import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { AgentLlmKind, AgentLlmModel, AgentLlmProvider } from "@/lib/seo-agent/client";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const as = (role: "admin" | "author", id: string = role): SessionUser => ({ id, name: role, email: `${id}@example.com`, role, emailVerified: true, image: null, sessionCreatedAt: new Date() });

/**
 * Admin → AI & SEO → Settings → LLM providers & models. The seo-agent owns providers, sealed keys and models
 * (moks-seo-agent/app/llm_providers, tested in moks-seo-agent/tests/test_llm_providers.py); this app shows them and
 * hands a save over through the agent's GET/PUT /llm-providers. It keeps nothing, and a key never comes back.
 */
const SECRET = "sk-test-not-a-real-key-777888";
const KIND = (over: Partial<AgentLlmKind> = {}): AgentLlmKind => ({ id: "openai", label: "OpenAI", adapter: "openai_compat", auth: "bearer", base_url: "https://api.openai.com/v1", base_url_editable: false, lists_models: true, structured: "per_model", needs: [], takes_key: true, env_key: "OPENAI_API_KEY", many: false, docs: "https://example.com/docs", note: "", ...over });
const MODEL = (over: Partial<AgentLlmModel> = {}): AgentLlmModel => ({ provider_id: "anthropic", model_id: "claude-sonnet-5-5", label: "claude-sonnet-5-5", enabled: true, free: false, price_state: "built-in", prices: { input: null, output: null, cache_read: null, cache_write: null }, builtin_prices: { input: 2, output: 10 }, context_window: null, max_output: null, capabilities: { structured_output: true, tools: true, vision: true }, ...over });
const PROVIDER = (over: Partial<AgentLlmProvider> = {}): AgentLlmProvider => ({ id: "anthropic", kind: "anthropic", kind_label: "Anthropic", name: "Anthropic", enabled: true, base_url: "https://api.anthropic.com", region: "", deployment: "", api_version: "", key: "env", saved: false, issues: [], models: [MODEL()], ...over });
const VIEW = () => ({ kinds: [KIND({ id: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com" }), KIND(), KIND({ id: "custom", label: "Custom OpenAI-compatible", base_url: "", base_url_editable: true, many: true })], providers: [PROVIDER()], can_store_keys: true, key_env: "SEO_AGENT_SETTINGS_KEY" });

let db: Db;
type Sent = { method: string; path: string; body: unknown };
let sent: Sent[] = [];
let agent: "ok" | "down" | "old" = "ok";

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([as("admin"), as("author")].map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  currentUser = null;
  sent = [];
  agent = "ok";
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
  vi.stubEnv("SEO_AGENT_TOKEN", "a".repeat(40));
  vi.stubEnv("SEO_ORCHESTRATOR", "crewai");
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    if (agent === "down") throw new TypeError("fetch failed");
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? "GET", path: u.pathname, body });
    const mine = u.pathname === "/llm-providers" || u.pathname === "/llm-models";
    if (mine && agent === "old") return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    if (u.pathname === "/llm-providers" && init?.method === "PUT") {
      const b = body as { id: string; models?: { model_id: string; enabled: boolean; input_usd: number | null }[] };
      if (b.models?.some((m) => m.enabled && m.input_usd === null)) return new Response(JSON.stringify({ error: "the provider is not valid", issues: ["models.m1: enter its prices (USD per million tokens) or mark it free before switching it on"] }), { status: 422 });
      return new Response(JSON.stringify({ saved: { id: b.id, created: true, enabled: true, key_changed: true, models: b.models?.length ?? null }, ...VIEW() }), { status: 200 });
    }
    if (u.pathname === "/llm-providers") return new Response(JSON.stringify(VIEW()), { status: 200 });
    if (u.pathname === "/llm-models") return new Response(JSON.stringify({ models: [MODEL({ provider_name: "Anthropic" })] }), { status: 200 });
    return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
  }) as typeof fetch);
  setDbForTests(db);
});

afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const headers = { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" };
const put = async (body: unknown) => {
  const { PUT } = await import("@/app/api/admin/seo/llm-providers/route");
  return PUT(new Request("https://jithendar.com/api/admin/seo/llm-providers", { method: "PUT", headers, body: JSON.stringify(body) }));
};
const get = async (what: "llm-providers" | "llm-models" = "llm-providers") => {
  const { GET } = what === "llm-providers" ? await import("@/app/api/admin/seo/llm-providers/route") : await import("@/app/api/admin/seo/llm-models/route");
  return GET(new Request(`https://jithendar.com/api/admin/seo/${what}`));
};
const SAVE = (over: Record<string, unknown> = {}) => ({ id: "openai", kind: "openai", name: "OpenAI", enabled: true, base_url: "", region: "", deployment: "", api_version: "", api_key: SECRET, models: [{ model_id: "m1", label: "", enabled: true, free: false, input_usd: 1, output_usd: 4, cache_read_usd: null, cache_write_usd: null, context_window: null, max_output: null, structured_output: true, tools: false, vision: false }], ...over });

describe("admin API (a thin client of the seo-agent)", () => {
  it("only admins may read or change providers and models", async () => {
    expect((await get()).status).toBe(401);
    currentUser = as("author");
    expect((await get()).status).toBe(403);
    expect((await get("llm-models")).status).toBe(403);
    expect((await put(SAVE())).status).toBe(403);
    expect(sent.filter((s) => s.path.startsWith("/llm-"))).toEqual([]);
  });

  it("shows the agent's providers and the models that are switched on", async () => {
    currentUser = as("admin");
    const r = (await (await get()).json()) as { view: ReturnType<typeof VIEW>; error: string | null; tooOld: boolean };
    expect([r.view.providers[0]!.id, r.view.providers[0]!.key, r.error, r.tooOld]).toEqual(["anthropic", "env", null, false]);
    const m = (await (await get("llm-models")).json()) as { models: AgentLlmModel[]; error: string | null };
    expect(m.models.map((x) => x.model_id)).toEqual(["claude-sonnet-5-5"]);
  });

  it("hands a save to the agent with the actor; the key goes there and nowhere else", async () => {
    currentUser = as("admin");
    const res = await put(SAVE());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const call = sent.find((s) => s.method === "PUT")!;
    expect(call.path).toBe("/llm-providers");
    expect(call.body).toMatchObject({ id: "openai", api_key: SECRET, actor: expect.any(String) });
    const logs = await db.select().from(schema.auditLog);
    const mine = logs.filter((l) => l.action === "seo.llm_provider.update");
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain(SECRET);
    expect(JSON.stringify(mine)).toContain('"key":"set"');
  });

  it("the agent's refusal comes back with its issues, and nothing is audit-logged", async () => {
    currentUser = as("admin");
    const res = await put(SAVE({ models: [{ ...SAVE().models[0]!, input_usd: null, output_usd: null }] }));
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("enter its prices");
    expect(body).not.toContain(SECRET);
    expect((await db.select().from(schema.auditLog)).filter((l) => l.action === "seo.llm_provider.update")).toHaveLength(0);
  });

  it("a malformed body never reaches the agent", async () => {
    currentUser = as("admin");
    expect((await put({ id: "openai", api_key: SECRET })).status).toBe(400);
    expect((await put(SAVE({ models: [{ ...SAVE().models[0]!, input_usd: -1 }] }))).status).toBe(400);
    expect(sent.filter((s) => s.method === "PUT")).toEqual([]);
  });

  it("an agent that is down or older is reported, never a crash", async () => {
    currentUser = as("admin");
    agent = "old";
    const old = (await (await get()).json()) as { view: unknown; error: string; tooOld: boolean };
    expect([old.view, old.tooOld]).toEqual([null, true]);
    expect(old.error).toContain("newer seo-agent");
    expect((await put(SAVE())).status).toBe(503);
    expect(((await (await get("llm-models")).json()) as { models: unknown[]; tooOld: boolean })).toMatchObject({ models: [], tooOld: true });
    agent = "down";
    const down = (await (await get()).json()) as { view: unknown; error: string; tooOld: boolean };
    expect([down.view, down.tooOld]).toEqual([null, false]);
    expect((await put(SAVE())).status).toBe(503);
  });
});

describe("the form's own logic", () => {
  it("a form starts without a key and a save sends one only when typed or removed", async () => {
    const { draftOf, saveBody } = await import("@/components/seo/LlmProvidersCard");
    const d = draftOf(PROVIDER({ id: "openai", kind: "openai", key: "saved", models: [MODEL({ provider_id: "openai", model_id: "m1", price_state: "entered", prices: { input: 1, output: 4, cache_read: null, cache_write: null }, builtin_prices: null })] }), KIND());
    expect(d.apiKey).toBe("");
    expect(d.base_url).toBe(""); // a fixed address is not sent back
    const kept = saveBody(d);
    expect("body" in kept && "api_key" in kept.body).toBe(false);
    const typed = saveBody({ ...d, apiKey: ` ${SECRET} ` });
    expect("body" in typed && typed.body.api_key).toBe(SECRET);
    const removed = saveBody({ ...d, removeKey: true });
    expect("body" in removed && removed.body.api_key).toBe("");
    expect("body" in kept && kept.body.models![0]).toMatchObject({ model_id: "m1", input_usd: 1, output_usd: 4, cache_read_usd: null, enabled: true });
  });

  it("an empty price stays empty (never 0), and a bad number is reported before anything is sent", async () => {
    const { draftOf, saveBody } = await import("@/components/seo/LlmProvidersCard");
    const d = draftOf(PROVIDER({ id: "openai", kind: "openai", models: [MODEL({ provider_id: "openai", model_id: "m1", price_state: "missing", builtin_prices: null })] }), KIND());
    const empty = saveBody(d);
    expect("body" in empty && empty.body.models![0]).toMatchObject({ input_usd: null, output_usd: null });
    const bad = saveBody({ ...d, models: [{ ...d.models[0]!, input: "cheap", context: "1.5" }, { ...d.models[0]! }] });
    expect("issues" in bad && bad.issues.join(" ")).toMatch(/input price.*context window.*listed twice/s);
    const noName = saveBody({ ...d, name: " " });
    expect("issues" in noName && noName.issues[0]).toMatch(/Name/);
  });

  it("a new provider's id: the kind's own, or numbered for a kind that may exist more than once", async () => {
    const { newProviderId } = await import("@/components/seo/LlmProvidersCard");
    expect(newProviderId(KIND(), [])).toBe("openai");
    const azure = KIND({ id: "azure_openai", many: true });
    expect(newProviderId(azure, [])).toBe("azure-openai");
    expect(newProviderId(azure, ["azure-openai", "azure-openai-2"])).toBe("azure-openai-3");
  });

  it("the picker groups models by provider and keeps a value that is no longer offered, marked", async () => {
    const { modelValue, parseModelValue, pickerGroups } = await import("@/components/seo/ModelPicker");
    const models = [MODEL({ provider_name: "Anthropic" }), MODEL({ provider_id: "openrouter", model_id: "meta/llama-x", label: "Llama X", provider_name: "OpenRouter" })];
    expect(modelValue(models[1]!)).toBe("openrouter/meta/llama-x");
    expect(parseModelValue("openrouter/meta/llama-x")).toEqual({ provider_id: "openrouter", model_id: "meta/llama-x" });
    expect(parseModelValue("nope")).toBeNull();
    const g = pickerGroups(models, "anthropic/claude-sonnet-5-5");
    expect(g.map((x) => x.provider)).toEqual(["Anthropic", "OpenRouter"]);
    const gone = pickerGroups(models, "openai/old-model");
    expect(gone[0]).toMatchObject({ provider: "Not available", options: [{ value: "openai/old-model", missing: true }] });
  });
});
