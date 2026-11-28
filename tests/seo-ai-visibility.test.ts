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
const { analyzeAnswer, dedupeSources, aiVisibilityOverview, suggestPrompts, addPrompt, providerReadiness, sourcesOf } = await import("@/lib/seo-intel/ai-visibility");

const NOW = new Date("2026-11-12T08:00:00Z");
const LITELLM = { LITELLM_BASE_URL: "http://litellm.test:4000/v1", LITELLM_API_KEY: "sk-test-not-real" };
const ENV = { SITE_URL: "https://jithendar.com", ...LITELLM, DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p" };
const AV = DEFAULT_SEO_SETTINGS.aiVisibility;
const on = (over: Partial<typeof AV> = {}) => settingsInput({ aiVisibility: { ...AV, enabled: true, providers: { ...AV.providers, perplexity: true, google_ai_overview: true }, ...over } });

/**
 * LiteLLM (answering per alias, in the shapes LiteLLM 1.111 gives each provider's web search) and DataForSEO. Claude
 * cites jithendar.com for prompts about Argo CD; nobody cites it otherwise. `refuseAfter`: LiteLLM refuses every
 * call after that many for its budget (HTTP 422 budget_exceeded).
 */
function vendors(opts: { refuseAfter?: number } = {}) {
  const calls: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}"))) as Record<string, unknown>;
    calls.push(new URL(url).host);
    if (url === "http://litellm.test:4000/v1/chat/completions") {
      asked.push(body);
      if (opts.refuseAfter !== undefined && asked.length > opts.refuseAfter) return Response.json({ error: { message: "Budget has been exceeded! Key=abc Current cost: 2.01, Max budget: 2.0", type: "budget_exceeded", code: "422" } }, { status: 422 });
      const prompt = String((body.messages as { content: string }[]).at(-1)!.content);
      const argo = /argo/i.test(prompt);
      const head = (cost: string, target: string) => ({ headers: { "x-litellm-response-cost": cost, "x-litellm-model-name": target, "x-litellm-call-id": `call-${asked.length}` } });
      if (body.model === "moks-cms-visibility-claude") {
        const message = {
          role: "assistant",
          content: argo ? "Jithendar.com explains sync waves well." : "Use the docs.",
          provider_specific_fields: {
            citations: argo ? [[{ type: "web_search_result_location", url: "https://www.jithendar.com/blog/argo-cd-sync-waves", title: "Sync waves", cited_text: "…", encrypted_index: "x", supported_text: "Jithendar.com explains sync waves well." }]] : null,
            web_search_results: [{ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://argo-cd.readthedocs.io/en/stable/", title: "Argo CD docs", encrypted_content: "x" }] }],
          },
        };
        return Response.json({ id: "chatcmpl-1", model: body.model, choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 10_000, completion_tokens: 500 } }, head("0.06", "anthropic/claude-opus-5-5"));
      }
      if (body.model === "moks-cms-visibility-perplexity") {
        return Response.json({ id: "chatcmpl-2", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "See Kubernetes docs [1]." }, finish_reason: "stop" }], citations: ["https://kubernetes.io/docs/"], search_results: [{ url: "https://kubernetes.io/docs/", title: "Docs" }], usage: { prompt_tokens: 20, completion_tokens: 30 } }, head("0.005", "perplexity/sonar"));
      }
      return Response.json({ error: { message: `Invalid model name passed in model=${String(body.model)}`, type: "invalid_request_error" } }, { status: 400 });
    }
    if (url.startsWith("https://api.dataforseo.com/")) {
      const kw = String((body as unknown as Record<string, unknown>[])[0]!.keyword);
      const items = /argo/i.test(kw) ? [{ type: "ai_overview", markdown: "Overview", items: [{ type: "ai_overview_element", references: [{ url: "https://jithendar.com/blog/argo-cd-sync-waves", domain: "jithendar.com", title: "Sync waves" }] }] }] : [{ type: "organic" }];
      return Response.json({ status_code: 20000, cost: 0.004, tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.004, result: [{ items }] }] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, asked };
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

describe("sources from LiteLLM's answers (shapes captured from LiteLLM 1.111 with web_search_options, 2026-11-28)", () => {
  const urls = (r: Parameters<typeof sourcesOf>[0]) => {
    const { cited, consulted } = sourcesOf(r);
    return { cited: dedupeSources(cited).map((x) => `${x.domain} ${x.url}`), consulted: dedupeSources(consulted).map((x) => x.domain) };
  };
  it("Anthropic: citations and web search results in provider_specific_fields", () => {
    const message = { role: "assistant", content: "Jithendar.com explains sync waves well.", provider_specific_fields: { citations: [[{ type: "web_search_result_location", url: "https://www.jithendar.com/blog/argo-cd-sync-waves", title: "Sync waves", cited_text: "...", encrypted_index: "x", supported_text: "Jithendar.com explains sync waves well." }]], web_search_results: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://argo-cd.readthedocs.io/en/stable/", title: "Argo CD docs", encrypted_content: "x", page_age: null }] }], thinking_blocks: null } };
    expect(urls({ message, response: {} })).toEqual({ cited: ["jithendar.com https://www.jithendar.com/blog/argo-cd-sync-waves"], consulted: ["argo-cd.readthedocs.io"] });
  });
  it("Perplexity: citations and search_results on the response", () => {
    expect(urls({ message: { role: "assistant", content: "See the Kubernetes docs [1]." }, response: { citations: ["https://kubernetes.io/docs/"], search_results: [{ url: "https://kubernetes.io/docs/", title: "Docs" }] } }).cited).toEqual(["kubernetes.io https://kubernetes.io/docs/"]);
  });
  it("Gemini: url_citation annotations and grounding chunks, whose title carries the domain", () => {
    const uri = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
    const r = { message: { role: "assistant", content: "Use sync waves.", annotations: [{ type: "url_citation", url_citation: { end_index: 15, start_index: 0, title: "jithendar.com", url: uri } }] }, response: { vertex_ai_grounding_metadata: [{ webSearchQueries: ["argo cd sync waves"], groundingChunks: [{ web: { uri, title: "jithendar.com" } }] }] } };
    expect(urls(r).cited).toEqual([`jithendar.com ${uri}`]);
  });
  it("OpenAI: url_citation annotations", () => {
    expect(urls({ message: { role: "assistant", content: "x", annotations: [{ type: "url_citation", url_citation: { url: "https://jithendar.com/a", title: "A" } }] }, response: {} }).cited).toEqual(["jithendar.com https://jithendar.com/a"]);
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
    // D-110: no provider key here; an assistant needs LiteLLM and its alias.
    const s = { ...DEFAULT_SEO_SETTINGS, aiVisibility: { ...AV, providers: { ...AV.providers, chatgpt: true, gemini: true }, aliases: { ...AV.aliases, chatgpt: "" } } };
    expect(providerReadiness(s, { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" }).find((x) => x.id === "claude")).toMatchObject({ ready: false, reason: expect.stringMatching(/LiteLLM is not configured/) });
    const r = providerReadiness(s, LITELLM);
    expect(r.find((x) => x.id === "chatgpt")).toMatchObject({ ready: false, reason: "set its LiteLLM alias in Settings" });
    expect(r.find((x) => x.id === "gemini")).toMatchObject({ ready: true, reason: null });
    expect(r.find((x) => x.id === "claude")).toMatchObject({ ready: true });
  });

  it("asks every prompt to every ready assistant, stores citations and costs, and does not re-buy the same day", async () => {
    await saveSeoSettings(on(), "admin");
    const { fetchImpl, calls, asked } = vendors();
    const out = await runSeoJob({ type: "ai_visibility", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(out.status).toBe("succeeded");
    expect(out.rows).toBe(6);
    const rows = rowsOf<{ prompt: string; provider: string; cited: boolean; mentioned: boolean; cited_rank: number | null; cost_usd: number; error: string | null }>(
      await db.execute(sql`select p.prompt, a.provider, a.cited, a.mentioned, a.cited_rank, a.cost_usd, a.error from seo_ai_answers a join seo_ai_prompts p on p.id = a.prompt_id order by p.prompt, a.provider`),
    );
    const argo = rows.filter((r) => r.prompt.startsWith("How do Argo"));
    expect(argo.find((r) => r.provider === "claude")).toMatchObject({ cited: true, mentioned: true, cited_rank: 1 });
    expect(argo.find((r) => r.provider === "google_ai_overview")).toMatchObject({ cited: true, error: null });
    expect(argo.find((r) => r.provider === "perplexity")).toMatchObject({ cited: false, cost_usd: 0.005 });
    expect(rows.find((r) => r.prompt.startsWith("What is") && r.provider === "google_ai_overview")!.error).toBe("no_ai_overview");
    // What LiteLLM charged (x-litellm-response-cost), never priced here.
    expect(argo.find((r) => r.provider === "claude")!.cost_usd).toBeCloseTo(0.06, 8);
    // Without a citation, Claude's sources are what it read; every LLM answer asked its alias with web search.
    const plain = rowsOf<{ sources: { domain: string }[] }>(await db.execute(sql`select a.sources from seo_ai_answers a join seo_ai_prompts p on p.id = a.prompt_id where a.provider = 'claude' and p.prompt like 'What is%'`));
    expect(plain[0]!.sources.map((x) => x.domain)).toEqual(["argo-cd.readthedocs.io"]);
    expect(asked.every((b) => b.web_search_options !== undefined)).toBe(true);
    expect(new Set(asked.map((b) => b.model))).toEqual(new Set(["moks-cms-visibility-claude", "moks-cms-visibility-perplexity"]));
    expect(calls).not.toContain("api.anthropic.com");

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

  it("stops when LiteLLM refuses for its budget, and books what it charged in seo_llm_usage", async () => {
    await saveSeoSettings(on({ providers: { ...AV.providers, claude: false, perplexity: true, google_ai_overview: false } }), "admin");
    const { fetchImpl } = vendors({ refuseAfter: 1 });
    const out = await runSeoJob({ type: "ai_visibility", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    expect(out).toMatchObject({ status: "partial", errorCode: "budget" });
    expect(out.error).toMatch(/Stopped by LiteLLM: LiteLLM refused the call: the budget of this key is used up/);
    const [r] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_ai_answers`));
    expect(r!.n).toBe(1);
    const usage = rowsOf<{ provider: string; model: string; purpose: string; cost_usd: number }>(await db.execute(sql`select provider, model, purpose, cost_usd from seo_llm_usage`));
    expect(usage).toEqual([{ provider: "litellm", model: "sonar", purpose: "ai_visibility", cost_usd: 0.005 }]);
  });

  it("suggests question-like Search Console queries that are not prompts yet", async () => {
    const rows = ["how to rollback a helm release", "helm", "argo cd vs flux", "how do argo cd sync waves work?"].map((q) => sql`(current_date - 3, 'https://jithendar.com/a', ${q}, 'web', 'desktop', 'ind', 1, 100, 0.01, 6)`);
    await db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr, position) values ${sql.join(rows, sql`, `)}`);
    expect((await suggestPrompts(db)).map((s) => s.query).sort()).toEqual(["argo cd vs flux", "how to rollback a helm release"]);
  });
});

describe("admin MCP data views", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    await saveSeoSettings(on(), "admin");
    await addPrompt(db, "How do Argo CD sync waves work?", "manual", "admin");
    await db.execute(sql`insert into seo_tracked_keywords (query) values ('argo cd sync waves')`);
  });
  afterEach(() => setDbForTests(undefined));

  it("serve AI visibility, a prompt's answers, tracked keywords and backlinks to the agent", async () => {
    const { data } = await import("@/lib/seo-agent/callbacks-v4");
    const { fetchImpl } = vendors();
    await runSeoJob({ type: "ai_visibility", trigger: "manual" }, { env: ENV, fetchImpl, now: () => NOW });
    const av = (await data("ai-visibility", new URLSearchParams())) as { prompts: { id: string; answers: Record<string, { cited: boolean } | null> }[] };
    expect(av.prompts[0]!.answers.claude).toMatchObject({ cited: true });
    const one = (await data("ai-prompt", new URLSearchParams({ id: av.prompts[0]!.id }))) as { answers: { provider: string }[] };
    expect(one.answers.map((a) => a.provider).sort()).toEqual(["claude", "google_ai_overview", "perplexity"]);
    await expect(data("ai-prompt", new URLSearchParams({ id: "x" }))).rejects.toThrow();
    const tk = (await data("tracked-keywords", new URLSearchParams())) as { rows: { query: string; google: unknown; volume: unknown }[] };
    expect(tk.rows).toEqual([expect.objectContaining({ query: "argo cd sync waves", google: null, volume: null })]);
    expect(await data("backlinks", new URLSearchParams())).toMatchObject({ note: expect.stringContaining("No backlink snapshot") });
  });
});
