import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

await import("@/lib/seo-intel/handlers");
const { runSeoJob, dueSlots } = await import("@/lib/seo-intel/jobs");
const { DEFAULT_SEO_SETTINGS, saveSeoSettings } = await import("@/lib/seo-intel/settings");
const { analyzeAnswer, dedupeSources, aiVisibilityOverview, suggestPrompts, addPrompt, providerReadiness } = await import("@/lib/seo-intel/ai-visibility");

const NOW = new Date("2026-11-12T08:00:00Z");
const ENV = { SITE_URL: "https://jithendar.com", ANTHROPIC_API_KEY: "test-anthropic", PERPLEXITY_API_KEY: "test-pplx", DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p" };
const AV = DEFAULT_SEO_SETTINGS.aiVisibility;
const on = (over: Partial<typeof AV> = {}) => settingsInput({ aiVisibility: { ...AV, enabled: true, providers: { ...AV.providers, perplexity: true, google_ai_overview: true }, ...over } });

/** Fake vendor APIs, answering by host. Claude cites jithendar.com for prompts about Argo CD; nobody cites it otherwise. */
function vendors() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}"))) as Record<string, unknown>;
    calls.push(new URL(url).host);
    if (url.startsWith("https://api.anthropic.com/")) {
      const prompt = String((body.messages as { content: string }[])[0]!.content);
      const argo = /argo/i.test(prompt);
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: prompt } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://argo-cd.readthedocs.io/en/stable/", title: "Argo CD docs", encrypted_content: "x" }] },
          { type: "text", text: argo ? "Jithendar.com explains sync waves well." : "Use the docs.", citations: argo ? [{ type: "web_search_result_location", url: "https://www.jithendar.com/blog/argo-cd-sync-waves", title: "Sync waves", cited_text: "…", encrypted_index: "x" }] : [] },
        ],
        usage: { input_tokens: 10_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 } },
      });
    }
    if (url.startsWith("https://api.perplexity.ai/")) return Response.json({ choices: [{ message: { content: "See Kubernetes docs." } }], search_results: [{ url: "https://kubernetes.io/docs/", title: "Docs" }] });
    if (url.startsWith("https://api.dataforseo.com/")) {
      const kw = String((body as unknown as Record<string, unknown>[])[0]!.keyword);
      const items = /argo/i.test(kw) ? [{ type: "ai_overview", markdown: "Overview", items: [{ type: "ai_overview_element", references: [{ url: "https://jithendar.com/blog/argo-cd-sync-waves", domain: "jithendar.com", title: "Sync waves" }] }] }] : [{ type: "organic" }];
      return Response.json({ status_code: 20000, cost: 0.004, tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.004, result: [{ items }] }] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("matching", () => {
  it("finds this site among the sources (www and subdomains) with its rank, and whole-word mentions", () => {
    const sources = dedupeSources([{ url: "https://kubernetes.io/x" }, { url: "https://kubernetes.io/x/" }, { url: "https://docs.jithendar.com/a" }, { url: "ftp://nope" }]);
    expect(sources.map((s) => s.domain)).toEqual(["kubernetes.io", "docs.jithendar.com"]);
    expect(analyzeAnswer("…", sources, "jithendar.com", [])).toMatchObject({ cited: true, citedRank: 2 });
    expect(analyzeAnswer("As Jithendar.com shows", [], "jithendar.com", ["Jithendar.com"]).mentioned).toBe(true);
    expect(analyzeAnswer("notjithendar.comx", [], "jithendar.com", ["Jithendar.com"]).mentioned).toBe(false);
  });
});

describe("AI visibility job", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    await addPrompt(db, "How do Argo CD sync waves work?", "manual", "admin");
    await addPrompt(db, "What is a Kubernetes operator?", "manual", "admin");
  });
  afterEach(() => setDbForTests(undefined));

  it("is off by default, and needs a configured assistant", async () => {
    await saveSeoSettings(settingsInput(), "admin");
    expect((await runSeoJob({ type: "ai_visibility", trigger: "manual" }, { env: ENV, now: () => NOW })).errorCode).toBe("disabled");
    expect(dueSlots(DEFAULT_SEO_SETTINGS, new Date("2026-11-12T08:00:00Z")).map((d) => d.type)).not.toContain("ai_visibility");
    const r = providerReadiness({ ...DEFAULT_SEO_SETTINGS, aiVisibility: { ...AV, providers: { ...AV.providers, chatgpt: true, gemini: true } } }, { OPENAI_API_KEY: "k", GEMINI_API_KEY: "k" });
    expect(r.find((x) => x.id === "chatgpt")).toMatchObject({ ready: false, reason: "set the model in Settings" });
    expect(r.find((x) => x.id === "claude")).toMatchObject({ ready: false, reason: "ANTHROPIC_API_KEY is not set" });
  });

  it("asks every prompt to every ready assistant, stores citations and costs, and does not re-buy the same day", async () => {
    await saveSeoSettings(on(), "admin");
    const { fetchImpl, calls } = vendors();
    const out = await runSeoJob({ type: "ai_visibility", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(out.status).toBe("succeeded");
    expect(out.rows).toBe(6);
    const rows = rowsOf<{ prompt: string; provider: string; cited: boolean; mentioned: boolean; cited_rank: number | null; cost_usd: number; error: string | null }>(
      await db.execute(sql`select p.prompt, a.provider, a.cited, a.mentioned, a.cited_rank, a.cost_usd, a.error from seo_ai_answers a join seo_ai_prompts p on p.id = a.prompt_id order by p.prompt, a.provider`),
    );
    const argo = rows.filter((r) => r.prompt.startsWith("How do Argo"));
    expect(argo.find((r) => r.provider === "claude")).toMatchObject({ cited: true, mentioned: true, cited_rank: 1 });
    expect(argo.find((r) => r.provider === "google_ai_overview")).toMatchObject({ cited: true, error: null });
    expect(argo.find((r) => r.provider === "perplexity")).toMatchObject({ cited: false, cost_usd: AV.costPerAnswerUsd });
    expect(rows.find((r) => r.prompt.startsWith("What is") && r.provider === "google_ai_overview")!.error).toBe("no_ai_overview");
    // Claude: 10k in × $4/M + 500 out × $20/M + one search at $0.01.
    expect(argo.find((r) => r.provider === "claude")!.cost_usd).toBeCloseTo(0.04 + 0.01 + 0.01, 5);

    const n = calls.length;
    await runSeoJob({ type: "ai_visibility", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(calls.length).toBe(n);

    const o = await aiVisibilityOverview();
    expect(o.byProvider.find((p) => p.id === "claude")).toMatchObject({ answers: 2, cited: 1 });
    expect(o.prompts.find((p) => p.prompt.startsWith("What is"))!.gap).toBe(true);
    expect(o.prompts.find((p) => p.prompt.startsWith("How do"))!.gap).toBe(false);
    expect(o.competitors.map((c) => c.domain)).toContain("kubernetes.io");
    expect(o.competitors.map((c) => c.domain)).not.toContain("jithendar.com");
  });

  it("stops before a call that would cross the monthly cap", async () => {
    await saveSeoSettings(on({ monthlyBudgetUsd: 0.05, providers: { ...AV.providers, claude: false, perplexity: true } }), "admin");
    const { fetchImpl } = vendors();
    const out = await runSeoJob({ type: "ai_visibility", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(out).toMatchObject({ status: "partial", errorCode: "budget" });
    const [r] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_ai_answers`));
    expect(r!.n).toBe(1);
  });

  it("suggests question-like Search Console queries that are not prompts yet", async () => {
    const rows = ["how to rollback a helm release", "helm", "argo cd vs flux", "how do argo cd sync waves work?"].map((q) => sql`(current_date - 3, 'https://jithendar.com/a', ${q}, 'web', 'desktop', 'ind', 1, 100, 0.01, 6)`);
    await db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr, position) values ${sql.join(rows, sql`, `)}`);
    expect((await suggestPrompts(db)).map((s) => s.query).sort()).toEqual(["argo cd vs flux", "how to rollback a helm release"]);
  });
});
