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
 * Admin → AI & SEO → Settings → LLM budget. The seo-agent owns the one budget (moks-seo-agent/app/llm_budgets.py,
 * tested in moks-seo-agent/tests/test_llm_budgets.py); this app only shows and edits it through the agent's GET/PUT
 * /llm-budget, and keeps nothing itself.
 */
let db: Db;
type Sent = { method: string; path: string; query: string; body: unknown; auth: string | null };
let sent: Sent[] = [];
let agent: "ok" | "down" | "old" = "ok";
let stored = { daily_usd: null as number | null, monthly_usd: null as number | null };

const VIEW = (scope: "day" | "month") => ({
  budget: stored,
  scope,
  period_start: scope === "day" ? "2026-11-21T00:00:00+00:00" : "2026-11-01T00:00:00+00:00",
  resets_at: scope === "day" ? "2026-11-22T00:00:00+00:00" : "2026-12-01T00:00:00+00:00",
  spent_usd: scope === "day" ? 1.5 : 12,
  pending_usd: 0.25,
  limit_usd: scope === "day" ? stored.daily_usd : stored.monthly_usd,
  remaining_usd: null,
  forecast_usd: scope === "month" ? 18.46 : null,
  by_provider: [{ provider: "anthropic", usd: 12, calls: 40 }],
  by_model: [{ provider: "anthropic", model: "claude-sonnet-5-5", usd: 12, calls: 40 }],
  by_purpose: [{ purpose: "draft", usd: 9, calls: 30 }, { purpose: "news_draft", usd: 3, calls: 10 }],
  other: { scope: scope === "day" ? "month" : "day", spent_usd: scope === "day" ? 12 : 1.5, limit_usd: null, resets_at: "2026-12-01T00:00:00+00:00" },
  ask_daily: { limit_usd: 1, spent_usd: 0.1 },
  legacy_limits: { models: {}, providers: {} },
});

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([as("admin"), as("author")].map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  currentUser = null;
  sent = [];
  agent = "ok";
  stored = { daily_usd: null, monthly_usd: null };
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
  vi.stubEnv("SEO_AGENT_TOKEN", "a".repeat(40));
  vi.stubEnv("SEO_ORCHESTRATOR", "crewai");
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    if (agent === "down") throw new TypeError("fetch failed");
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? "GET", path: u.pathname, query: u.search, body, auth: new Headers(init?.headers).get("authorization") });
    if (u.pathname === "/llm-budget" && agent === "old") return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    if (u.pathname === "/llm-budget" && init?.method === "PUT") {
      const b = body as { daily_usd: number | null; monthly_usd: number | null };
      if ((b.daily_usd ?? 0) < 0) return new Response(JSON.stringify({ error: "the LLM budget is not valid", issues: ["daily_usd: Input should be greater than or equal to 0"] }), { status: 422 });
      stored = { daily_usd: b.daily_usd, monthly_usd: b.monthly_usd };
      return new Response(JSON.stringify({ budget: stored }), { status: 200 });
    }
    if (u.pathname === "/llm-budget") return new Response(JSON.stringify(VIEW(u.searchParams.get("scope") === "day" ? "day" : "month")), { status: 200 });
    return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
  }) as typeof fetch);
  setDbForTests(db);
});

afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const put = async (body: unknown) => {
  const { PUT } = await import("@/app/api/admin/seo/llm-budget/route");
  return PUT(new Request("https://jithendar.com/api/admin/seo/llm-budget", { method: "PUT", headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) }));
};
const get = async (query = "") => {
  const { GET } = await import("@/app/api/admin/seo/llm-budget/route");
  return GET(new Request(`https://jithendar.com/api/admin/seo/llm-budget${query}`));
};

describe("admin API (a thin client of the seo-agent)", () => {
  it("only admins may read or change it", async () => {
    expect((await get()).status).toBe(401);
    currentUser = as("author");
    expect((await get()).status).toBe(403);
    expect((await put({ daily_usd: 1, monthly_usd: null })).status).toBe(403);
    expect(sent.filter((s) => s.path === "/llm-budget")).toEqual([]);
  });

  it("shows the agent's budget for the chosen period: the month unless the day is asked for", async () => {
    currentUser = as("admin");
    const month = (await (await get()).json()) as { view: { scope: string; spent_usd: number }; scope: string; error: string | null };
    expect([month.scope, month.view.scope, month.view.spent_usd, month.error]).toEqual(["month", "month", 12, null]);
    expect(sent.at(-1)).toMatchObject({ method: "GET", path: "/llm-budget", query: "?scope=month", auth: `Bearer ${"a".repeat(40)}` });
    const day = (await (await get("?scope=day")).json()) as { view: { scope: string; spent_usd: number } };
    expect([day.view.scope, day.view.spent_usd]).toEqual(["day", 1.5]);
    expect(((await (await get("?scope=week")).json()) as { scope: string }).scope).toBe("month");
  });

  it("saves both limits through the agent, which validates; the save is audit-logged and nothing is kept here", async () => {
    currentUser = as("admin");
    const res = await put({ daily_usd: null, monthly_usd: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ budget: { daily_usd: null, monthly_usd: 30 } });
    const call = sent.find((s) => s.method === "PUT");
    expect(call).toMatchObject({ path: "/llm-budget", body: { daily_usd: null, monthly_usd: 30 } });
    expect(typeof (call?.body as { actor?: unknown }).actor).toBe("string");
    const entry = (await db.select().from(schema.auditLog)).find((r) => r.action === "seo.llm_budget.update");
    expect(JSON.stringify(entry?.detail)).toContain('"monthly_usd":30');
    expect(await db.select().from(schema.setting)).toEqual([]);
    const refused = await put({ daily_usd: -1, monthly_usd: null });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { issues: string[] }).issues[0]).toContain("daily_usd");
    for (const bad of [{ daily_usd: 1 }, { daily_usd: "1", monthly_usd: null }, { models: {}, providers: {} }]) expect((await put(bad)).status).toBe(400);
  });

  it("says so when the agent cannot be reached or is from before the one budget, and cannot change anything then", async () => {
    currentUser = as("admin");
    agent = "down";
    const down = (await (await get()).json()) as { view: unknown; error: string; tooOld: boolean };
    expect(down).toMatchObject({ view: null, tooOld: false });
    expect(down.error).toMatch(/unreachable/i);
    expect((await put({ daily_usd: 1, monthly_usd: null })).status).toBe(503);
    agent = "old";
    const old = (await (await get()).json()) as { view: unknown; error: string; tooOld: boolean };
    expect(old).toMatchObject({ view: null, tooOld: true });
    expect(old.error).toMatch(/newer seo-agent/);
    const res = await put({ daily_usd: 1, monthly_usd: null });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/newer seo-agent/);
  });
});

describe("the budget card", () => {
  it("saves the period's field and leaves the other period's limit as it is; empty is no limit", async () => {
    const { budgetBody } = await import("@/components/seo/LlmBudgetCard");
    const current = { daily_usd: 2, monthly_usd: 30 };
    expect(budgetBody("month", " 45.5 ", current)).toEqual({ body: { daily_usd: 2, monthly_usd: 45.5 } });
    expect(budgetBody("day", "", current)).toEqual({ body: { daily_usd: null, monthly_usd: 30 } });
    expect(budgetBody("day", "$3", current)).toEqual({ body: { daily_usd: 3, monthly_usd: 30 } });
    expect(budgetBody("month", "0", current)).toEqual({ body: { daily_usd: 2, monthly_usd: 0 } });
    for (const bad of ["lots", "-1", "1e999"]) expect(budgetBody("month", bad, current)).toHaveProperty("issue");
  });

  it("shows spend against a limit, and a bar that counts calls in flight and never passes full", async () => {
    const { barTone, percentUsed, spentOf } = await import("@/components/seo/LlmBudgetCard");
    expect(spentOf(1.5, null)).toBe("$1.50 · no limit");
    expect(spentOf(85, 100)).toBe("$85.00 of $100.00");
    expect(percentUsed(40, 10, 100)).toBe(50);
    expect(percentUsed(140, 0, 100)).toBe(100);
    expect(percentUsed(1, 0, null)).toBeNull();
    expect(percentUsed(0, 0, 0)).toBe(100); // a limit of 0 stops every call
    expect([barTone(null), barTone(50), barTone(80), barTone(100)]).toEqual(["none", "ok", "near", "reached"]);
  });

  it("is the LLM budget section of AI & SEO settings, with the period from the address", async () => {
    const { scopeOf } = await import("@/lib/llm-budget-view");
    expect([scopeOf("day"), scopeOf("month"), scopeOf(undefined), scopeOf("week")]).toEqual(["day", "month", "month", "month"]);
    const { AI_SEO_SECTIONS } = await import("@/app/admin/(growth)/automation/sections");
    expect(AI_SEO_SECTIONS.map((s) => s.id)).toContain("llm-budget");
  });
});
