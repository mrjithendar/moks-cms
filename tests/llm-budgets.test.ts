import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const as = (role: "admin" | "author", id: string = role): SessionUser => ({ id, name: role, email: `${id}@example.com`, role, emailVerified: true, image: null, sessionCreatedAt: new Date() });

/**
 * Admin → Automation & AI → LLM budgets. The seo-agent owns the budgets (moks-seo-agent/app/llm_budgets.py, tested in
 * moks-seo-agent/tests/test_llm_budgets.py); this app only shows and edits them through the agent's GET/PUT
 * /llm-budgets, and keeps nothing itself.
 */
let db: Db;
type Sent = { method: string; path: string; body: unknown; auth: string | null };
let sent: Sent[] = [];
let agentDown = false;
let stored = { models: {} as Record<string, unknown>, providers: {} as Record<string, unknown> };

const VIEW = () => ({
  budgets: stored,
  month_start: "2026-11-01",
  day_resets_at: "2026-11-21T00:00:00+00:00",
  month_resets_at: "2026-12-01T00:00:00+00:00",
  models: [{ model: "claude-sonnet-5-5", provider: "anthropic", today_usd: 1.5, month_usd: 12, calls: 40, purposes: ["draft", "news"] }],
  providers: [{ provider: "anthropic", today_usd: 1.5, month_usd: 12, forecast_usd: 18.46 }],
});

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([as("admin"), as("author")].map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  currentUser = null;
  sent = [];
  agentDown = false;
  stored = { models: {}, providers: {} };
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
  vi.stubEnv("SEO_AGENT_TOKEN", "a".repeat(40));
  vi.stubEnv("SEO_ORCHESTRATOR", "crewai");
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    if (agentDown) throw new TypeError("fetch failed");
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? "GET", path, body, auth: new Headers(init?.headers).get("authorization") });
    if (path === "/llm-budgets" && init?.method === "PUT") {
      const b = body as { models: Record<string, { daily_usd: number | null }>; actor: string };
      if (Object.values(b.models).some((v) => (v.daily_usd ?? 0) < 0)) return Response.json({ error: "the LLM budgets are not valid", issues: ["models.claude-sonnet-5-5.daily_usd: Input should be greater than or equal to 0"] }, { status: 422 });
      const b2 = body as { models: Record<string, unknown>; providers: Record<string, unknown> };
      stored = { models: b2.models, providers: b2.providers };
      return Response.json({ budgets: stored });
    }
    if (path === "/llm-budgets") return Response.json(VIEW());
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
});
afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const put = async (body: unknown) => {
  const { PUT } = await import("@/app/api/admin/seo/llm-budgets/route");
  return PUT(new Request("https://jithendar.com/api/admin/seo/llm-budgets", { method: "PUT", headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) }));
};
const get = async () => {
  const { GET } = await import("@/app/api/admin/seo/llm-budgets/route");
  return GET(new Request("https://jithendar.com/api/admin/seo/llm-budgets"));
};

describe("admin API (a thin client of the seo-agent)", () => {
  it("only admins may read or change them", async () => {
    const body = { models: {}, providers: { anthropic: { daily_usd: null, monthly_usd: 30 } } };
    expect((await put(body)).status).toBe(401);
    expect((await get()).status).toBe(401);
    currentUser = as("author");
    expect((await put(body)).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("shows the agent's budgets and spend next to this app's feature caps", async () => {
    currentUser = as("admin");
    const view = (await (await get()).json()) as { agent: { budgets: unknown; providers: { forecast_usd: number }[] }; agentError: null; configuredModels: string[]; featureCaps: { feature: string }[] };
    expect(sent).toEqual([{ method: "GET", path: "/llm-budgets", body: undefined, auth: `Bearer ${"a".repeat(40)}` }]);
    expect(view.agent.budgets).toEqual({ models: {}, providers: {} }); // nothing preset
    expect(view.agent.providers[0]!.forecast_usd).toBe(18.46);
    expect(view.agentError).toBeNull();
    expect(view.configuredModels).toContain("claude-sonnet-5-5");
    expect(view.featureCaps.map((c) => c.feature)).toEqual(expect.arrayContaining(["Drafts and agent flows", "Ask the Blog", "News desk"]));
  });

  it("saves through the agent, which validates; the save is audit-logged and nothing is kept here", async () => {
    currentUser = as("admin");
    const body = { models: { "claude-sonnet-5-5": { daily_usd: null, monthly_usd: 20 } }, providers: { anthropic: { daily_usd: 2, monthly_usd: 30 } } };
    const ok = await put(body);
    expect(ok.status).toBe(200);
    expect((await ok.json()).budgets).toEqual(body);
    expect(sent.at(-1)).toMatchObject({ method: "PUT", path: "/llm-budgets", body: { ...body, actor: expect.any(String) } });
    const entry = (await db.select().from(schema.auditLog)).find((l) => l.action === "seo.llm_budgets.update");
    expect(JSON.stringify(entry?.detail)).toContain("claude-sonnet-5-5");
    expect((await db.select().from(schema.setting)).find((s) => s.key === "llm_budgets")).toBeUndefined();
    const invalid = await put({ models: { "claude-sonnet-5-5": { daily_usd: -5, monthly_usd: null } }, providers: {} });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).issues.join()).toContain("claude-sonnet-5-5");
    expect((await put({ models: "nope" })).status).toBe(400); // not even the shape: never sent
  });

  it("says so when the agent cannot be reached, and cannot change anything then", async () => {
    currentUser = as("admin");
    agentDown = true;
    const view = (await (await get()).json()) as { agent: unknown; agentError: string };
    expect(view.agent).toBeNull();
    expect(view.agentError).toContain("unreachable");
    expect((await put({ models: {}, providers: {} })).status).toBe(503);
  });
});

describe("the admin card", () => {
  it("sends an empty field as no limit, leaves out rows with neither, and shows spend against a limit", async () => {
    const { budgetsBody, spentOf, nearLimit } = await import("@/components/seo/LlmBudgetsCard");
    expect(budgetsBody({ "claude-sonnet-5-5": { daily: "", monthly: "20" }, "claude-haiku-5-5": { daily: "", monthly: "" } }, { anthropic: { daily: "2", monthly: " " } })).toEqual({
      models: { "claude-sonnet-5-5": { daily_usd: null, monthly_usd: 20 } },
      providers: { anthropic: { daily_usd: 2, monthly_usd: null } },
    });
    expect(spentOf(1.5, null)).toBe("$1.50 · no limit");
    expect(spentOf(85, 100)).toBe("$85.00 of $100.00");
    expect(nearLimit(85, 100)).toBe(true);
    expect(nearLimit(1000, null)).toBe(false);
  });
});
