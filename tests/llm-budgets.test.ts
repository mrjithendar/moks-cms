import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { schema, setDbForTests, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const as = (role: "admin" | "author", id: string = role): SessionUser => ({ id, name: role, email: `${id}@example.com`, role, emailVerified: true, image: null, sessionCreatedAt: new Date() });

const lb = await import("@/lib/llm-budgets");
const claude = await import("@/lib/seo-intel/claude");

/**
 * LLM budgets (Admin → Automation & AI → LLM budgets): an optional daily and monthly limit per model and per provider,
 * counted over every Claude call in seo_llm_usage. The seo-agent's side is tested in
 * moks-seo-agent/tests/test_llm_limits.py.
 */
let db: Db;
const NOW = new Date("2026-11-20T12:00:00Z");

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([as("admin"), as("author")].map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  currentUser = null;
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
});
afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
});

const use = (model: string, usd: number, purpose = "draft", at = NOW) =>
  db.execute(sql`insert into seo_llm_usage (at, provider, model, purpose, prompt_version, input_tokens, output_tokens, cost_usd, outcome) values (${at.toISOString()}, 'anthropic', ${model}, ${purpose}, 'v', 0, 0, ${usd}, 'ok')`);
const budgets = (b: unknown) => lb.saveLlmBudgets(b, "admin");

describe("the settings document", () => {
  it("is empty by default: nothing is preset and nothing is limited", async () => {
    expect(await lb.getLlmBudgets(db)).toEqual({ models: {}, providers: {} });
    await use("claude-sonnet-5-5", 500);
    expect(await lb.checkLlmBudget(db, "claude-sonnet-5-5", 10, "anthropic", NOW)).toBeNull();
  });

  it("validates, and leaves out entries without any limit", async () => {
    const { after } = await budgets({ models: { "claude-sonnet-5-5": { dailyUsd: 2, monthlyUsd: null }, "claude-haiku-5-5": { dailyUsd: null, monthlyUsd: null } }, providers: { anthropic: { monthlyUsd: 30 } } });
    expect(after).toEqual({ models: { "claude-sonnet-5-5": { dailyUsd: 2, monthlyUsd: null } }, providers: { anthropic: { dailyUsd: null, monthlyUsd: 30 } } });
    await expect(budgets({ models: { "claude-sonnet-5-5": { dailyUsd: -1, monthlyUsd: null } } })).rejects.toMatchObject({ status: 400 });
    await expect(budgets({ models: { "bad model!": { dailyUsd: 1, monthlyUsd: null } } })).rejects.toMatchObject({ status: 400 });
    await expect(budgets({ providers: { anthropic: { monthlyUsd: "lots" } } })).rejects.toMatchObject({ status: 400 });
  });

  it("reads a document that does not parse as no limits, so a bad row never stops every call", () => {
    expect(lb.parseLlmBudgets({ models: "nope" })).toEqual({ models: {}, providers: {} });
    expect(lb.parseLlmBudgets(null)).toEqual({ models: {}, providers: {} });
  });
});

describe("checks", () => {
  it("a model's monthly budget counts every purpose this month, but not last month", async () => {
    await budgets({ models: { "claude-sonnet-5-5": { dailyUsd: null, monthlyUsd: 5 } } });
    await use("claude-sonnet-5-5", 2, "draft");
    await use("claude-sonnet-5-5", 2, "news.writer");
    await use("claude-sonnet-5-5", 50, "draft", new Date("2026-10-31T23:59:00Z"));
    expect(await lb.checkLlmBudget(db, "claude-sonnet-5-5", 0.5, "anthropic", NOW)).toBeNull();
    const why = await lb.checkLlmBudget(db, "claude-sonnet-5-5", 2, "anthropic", NOW);
    expect(why).toContain("The monthly budget of claude-sonnet-5-5 is reached: $4.00 of $5.00 used this month");
    expect(why).toContain("2026-12-01 00:00 UTC");
    expect(why).toContain("Admin → Automation & AI → LLM budgets");
    expect(await lb.checkLlmBudget(db, "claude-haiku-5-5", 2, "anthropic", NOW)).toBeNull(); // another model has its own
  });

  it("a daily budget resets with the UTC day", async () => {
    await budgets({ models: { "claude-haiku-5-5": { dailyUsd: 1, monthlyUsd: null } } });
    await use("claude-haiku-5-5", 1, "ask.answer");
    expect(await lb.checkLlmBudget(db, "claude-haiku-5-5", 0, "anthropic", NOW)).toContain("daily budget of claude-haiku-5-5");
    expect(await lb.checkLlmBudget(db, "claude-haiku-5-5", 0.1, "anthropic", new Date("2026-11-21T00:00:01Z"))).toBeNull();
  });

  it("a provider total caps all of its models together, batches in progress included", async () => {
    await budgets({ providers: { anthropic: { dailyUsd: null, monthlyUsd: 10 } } });
    await use("claude-sonnet-5-5", 4);
    await use("claude-haiku-5-5", 3);
    await db.execute(sql`insert into seo_llm_batches (id, status, model, request_count, estimated_cost_usd) values ('b1', 'in_progress', 'claude-opus-5-5', 3, 2.5)`);
    const why = await lb.checkLlmBudget(db, "claude-opus-5-5", 1, "anthropic", NOW);
    expect(why).toContain("The monthly total for all anthropic models is reached: $9.50 of $10.00");
    expect(await lb.checkLlmBudget(db, "claude-opus-5-5", 0.4, "anthropic", NOW)).toBeNull();
  });

  it("a Claude call over a budget is refused before anything is sent", async () => {
    await budgets({ models: { "claude-sonnet-5-5": { dailyUsd: null, monthlyUsd: 1 } } });
    await use("claude-sonnet-5-5", 1);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const cfg = { apiKey: "sk-test", draftModel: "claude-sonnet-5-5", classifyModel: "claude-haiku-5-5", monthlyBudgetUsd: 1000, budgetSource: "default" as const };
    const r = await claude.claudeJson(db, cfg, { model: "claude-sonnet-5-5", purpose: "draft", promptVersion: "v", call: { system: "s", user: "u", schema: {}, maxTokens: 100 }, schema: z.object({ ok: z.boolean() }), fetchImpl, now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "budget" });
    expect(r.ok ? "" : r.detail).toContain("monthly budget of claude-sonnet-5-5");
    expect(calls).toBe(0);
  });
});

describe("spend overview", () => {
  it("adds up this month by model and provider, with today alongside and a month-end forecast", async () => {
    await use("claude-sonnet-5-5", 3, "draft");
    await use("claude-sonnet-5-5", 1, "news.writer", new Date("2026-11-02T10:00:00Z"));
    await use("claude-haiku-5-5", 1, "ask.answer");
    const s = await lb.llmSpend(db, NOW);
    expect(s.monthStart).toBe("2026-11-01");
    const sonnet = s.models.find((m) => m.model === "claude-sonnet-5-5")!;
    expect(sonnet).toMatchObject({ provider: "anthropic", todayUsd: 3, monthUsd: 4, calls: 2 });
    expect(sonnet.purposes).toEqual(["draft", "news"]);
    const anthropic = s.providers.find((p) => p.provider === "anthropic")!;
    expect(anthropic.monthUsd).toBe(5);
    expect(anthropic.forecastUsd).toBeCloseTo((5 / 19.5) * 30, 5);
  });
});

describe("admin API", () => {
  const put = async (body: unknown) => {
    const { PUT } = await import("@/app/api/admin/seo/llm-budgets/route");
    return PUT(new Request("https://jithendar.com/api/admin/seo/llm-budgets", { method: "PUT", headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) }));
  };

  it("admins save the document (validated, audit-logged); everyone else is refused", async () => {
    const body = { models: { "claude-sonnet-5-5": { dailyUsd: null, monthlyUsd: 20 } }, providers: { anthropic: { dailyUsd: 2, monthlyUsd: 30 } } };
    expect((await put(body)).status).toBe(401);
    currentUser = as("author");
    expect((await put(body)).status).toBe(403);
    currentUser = as("admin");
    const invalid = await put({ models: { "claude-sonnet-5-5": { dailyUsd: -5 } } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).issues.join()).toContain("claude-sonnet-5-5");
    const ok = await put(body);
    expect(ok.status).toBe(200);
    expect((await ok.json()).budgets).toEqual(body);
    const entry = (await db.select().from(schema.auditLog)).find((l) => l.action === "seo.llm_budgets.update");
    expect(JSON.stringify(entry?.detail)).toContain('"before"');
    const { GET } = await import("@/app/api/admin/seo/llm-budgets/route");
    const view = (await (await GET(new Request("https://jithendar.com/api/admin/seo/llm-budgets"))).json()) as { budgets: unknown; configuredModels: string[]; featureCaps: { feature: string }[] };
    expect(view.budgets).toEqual(body);
    expect(view.configuredModels).toContain("claude-sonnet-5-5");
    expect(view.featureCaps.map((c) => c.feature)).toEqual(expect.arrayContaining(["Drafts and agent flows", "Ask the Blog", "News desk"]));
  });
});

describe("the admin card", () => {
  it("sends an empty field as no limit, leaves out rows with neither, and shows spend against a limit", async () => {
    const { budgetsBody, spentOf, nearLimit } = await import("@/components/seo/LlmBudgetsCard");
    expect(budgetsBody({ "claude-sonnet-5-5": { daily: "", monthly: "20" }, "claude-haiku-5-5": { daily: "", monthly: "" } }, { anthropic: { daily: "2", monthly: " " } })).toEqual({
      models: { "claude-sonnet-5-5": { dailyUsd: null, monthlyUsd: 20 } },
      providers: { anthropic: { dailyUsd: 2, monthlyUsd: null } },
    });
    expect(spentOf(1.5, null)).toBe("$1.50 · no limit");
    expect(spentOf(85, 100)).toBe("$85.00 of $100.00");
    expect(nearLimit(85, 100)).toBe(true);
    expect(nearLimit(1000, null)).toBe(false);
  });
});
