import { sql } from "drizzle-orm";
import { site } from "@/config/site";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { anthropicClient } from "../practice/ai/anthropic";
import { costUsd, estimateCostUsd } from "./claude";
import { DataForSeoError, DfsClient, dfsCredentials } from "./dataforseo";
import { SkipRun, type RunContext, type RunOutcome } from "./jobs";
import type { SeoSettings } from "./settings";
import { siteOrigin } from "./urls";

/**
 * AI visibility: does this site show up when people ask AI assistants about its subjects?
 *
 * A weekly job (`ai_visibility`) asks each active prompt (`seo_ai_prompts`, ≤ `maxPrompts`) to each enabled assistant
 * with web search on, and stores the answer, the sources it cited, whether one of them is on this site (and at which
 * rank), and whether the answer names the site (`seo_ai_answers`, one row per prompt, assistant and day).
 *
 * Assistants (each off until switched on and configured; Settings → AI visibility):
 * - `claude`: Anthropic Messages API with the web search server tool (ANTHROPIC_API_KEY, already used for drafts).
 * - `chatgpt`: OpenAI Responses API with web search (OPENAI_API_KEY; model must be set: no default is guessed).
 * - `perplexity`: Perplexity Sonar (PERPLEXITY_API_KEY).
 * - `gemini`: Gemini API with Google Search grounding (GEMINI_API_KEY; model must be set).
 * - `google_ai_overview`: the AI Overview on Google's results page, read through DataForSEO's SERP API (needs
 *   DataForSEO credentials; a query without an AI Overview is recorded as such, not as "not cited").
 *
 * These are API answers. The consumer apps (chatgpt.com, claude.ai, perplexity.ai) can differ: other models, memory,
 * location, personalisation. Treat the numbers as a trend for the same prompts, not as what every reader sees.
 *
 * Spend: Claude's cost is computed from the returned token usage and search count; DataForSEO returns its cost; the
 * other APIs are counted at `costPerAnswerUsd` (an estimate, set it from the provider's pricing). The month's total
 * (sum of `seo_ai_answers.cost_usd`) is capped by `monthlyBudgetUsd`: the run stops before a call that would cross it.
 */
export const AI_PROVIDERS = ["claude", "chatgpt", "perplexity", "gemini", "google_ai_overview"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const AI_PROVIDER_LABEL: Record<AiProvider, string> = { claude: "Claude", chatgpt: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", google_ai_overview: "Google AI Overview" };
const WEB_SEARCH_USD = 0.01; // Anthropic web search: $10 per 1,000 searches
const MAX_ANSWER_CHARS = 8000;
export const NO_AI_OVERVIEW = "no_ai_overview";

export type Source = { url: string; title: string; domain: string };
export type Answer = { text: string; sources: Source[]; model: string; costUsd: number; error?: string };
export type AiDeps = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

// --- Matching (pure) ---------------------------------------------------------------------------------------------

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
export function domainOf(url: string): string {
  try {
    return bare(new URL(url).hostname);
  } catch {
    return "";
  }
}
const onSite = (domain: string, host: string) => domain === bare(host) || domain.endsWith(`.${bare(host)}`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Sources deduplicated by URL (fragment and trailing slash ignored), in the order given. */
export function dedupeSources(list: { url: string; title?: string | null; domain?: string | null }[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of list) {
    if (!s.url || !/^https?:\/\//i.test(s.url)) continue;
    const key = s.url.replace(/#.*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: s.url.slice(0, 2000), title: (s.title ?? "").slice(0, 300), domain: s.domain ? bare(s.domain) : domainOf(s.url) });
  }
  return out;
}

/** Is the site among the sources (and where), and does the answer name it? Names match whole words, any case. */
export function analyzeAnswer(text: string, sources: Source[], host: string, names: string[]) {
  const cited = sources.map((s, i) => ({ s, rank: i + 1 })).filter(({ s }) => onSite(s.domain, host));
  const terms = [...new Set([bare(host), ...names].map((n) => n.trim()).filter((n) => n.length >= 3))];
  const mentioned = terms.some((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
  return { cited: cited.length > 0, citedUrls: cited.map(({ s }) => s.url), citedRank: cited[0]?.rank ?? null, mentioned };
}

// --- Providers ---------------------------------------------------------------------------------------------------

type Ctx = { settings: SeoSettings["aiVisibility"]; dfs: SeoSettings["dataforseo"]; env: Record<string, string | undefined>; fetchImpl: typeof fetch; dfsClient: DfsClient | null };

export function providerReadiness(s: SeoSettings, env: Record<string, string | undefined> = process.env): { id: AiProvider; label: string; enabled: boolean; ready: boolean; reason: string | null }[] {
  const a = s.aiVisibility;
  const need = (id: AiProvider): string | null => {
    switch (id) {
      case "claude":
        return env.ANTHROPIC_API_KEY?.trim() ? null : "ANTHROPIC_API_KEY is not set";
      case "chatgpt":
        return !env.OPENAI_API_KEY?.trim() ? "OPENAI_API_KEY is not set" : !a.models.chatgpt ? "set the model in Settings" : null;
      case "perplexity":
        return env.PERPLEXITY_API_KEY?.trim() ? null : "PERPLEXITY_API_KEY is not set";
      case "gemini":
        return !env.GEMINI_API_KEY?.trim() ? "GEMINI_API_KEY is not set" : !a.models.gemini ? "set the model in Settings" : null;
      case "google_ai_overview":
        return !dfsCredentials(env) ? "DataForSEO credentials are not set" : null;
    }
  };
  return AI_PROVIDERS.map((id) => {
    const reason = need(id);
    return { id, label: AI_PROVIDER_LABEL[id], enabled: a.providers[id], ready: a.providers[id] && !reason, reason };
  });
}

async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the API key)" : res.status === 429 ? " (rate limited or out of credit)" : ""}`);
  return (await res.json()) as Record<string, unknown>;
}

async function askClaude(prompt: string, c: Ctx): Promise<Answer> {
  const model = c.settings.models.claude;
  const client = anthropicClient(c.env.ANTHROPIC_API_KEY?.trim() ?? null, c.fetchImpl);
  const res = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages: [{ role: "user", content: prompt }],
  });
  let text = "";
  const cited: { url: string; title?: string | null }[] = [];
  const consulted: { url: string; title?: string | null }[] = [];
  for (const block of res.content) {
    if (block.type === "text") {
      text += block.text;
      for (const ci of block.citations ?? []) if (ci.type === "web_search_result_location") cited.push({ url: ci.url, title: ci.title });
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) consulted.push({ url: r.url, title: r.title });
    }
  }
  const u = res.usage;
  const cost = costUsd(res.model, { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 }) + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
  // Sources are what the answer cites; when it cites nothing, what it read.
  return { text, sources: dedupeSources(cited.length ? cited : consulted), model: res.model, costUsd: cost, ...(res.stop_reason === "refusal" ? { error: "refusal" } : {}) };
}

type OpenAiOutput = { type: string; content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string }[] }[] }[];

async function askChatGpt(prompt: string, c: Ctx): Promise<Answer> {
  const model = c.settings.models.chatgpt;
  const d = await postJson(c.fetchImpl, "https://api.openai.com/v1/responses", { Authorization: `Bearer ${c.env.OPENAI_API_KEY!.trim()}` }, { model, input: prompt, tools: [{ type: "web_search" }] });
  let text = "";
  const cited: { url: string; title?: string }[] = [];
  for (const item of (d.output as OpenAiOutput | undefined) ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue;
      text += part.text ?? "";
      for (const a of part.annotations ?? []) if (a.type === "url_citation" && a.url) cited.push({ url: a.url, title: a.title });
    }
  }
  return { text, sources: dedupeSources(cited), model, costUsd: c.settings.costPerAnswerUsd };
}

async function askPerplexity(prompt: string, c: Ctx): Promise<Answer> {
  const model = c.settings.models.perplexity || "sonar";
  const d = await postJson(c.fetchImpl, "https://api.perplexity.ai/chat/completions", { Authorization: `Bearer ${c.env.PERPLEXITY_API_KEY!.trim()}` }, { model, messages: [{ role: "user", content: prompt }] });
  const text = String((d.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? "");
  const results = (d.search_results as { url: string; title?: string }[] | undefined) ?? ((d.citations as string[] | undefined) ?? []).map((url) => ({ url }));
  return { text, sources: dedupeSources(results), model, costUsd: c.settings.costPerAnswerUsd };
}

type GeminiResponse = { candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[] };

async function askGemini(prompt: string, c: Ctx): Promise<Answer> {
  const model = c.settings.models.gemini;
  const d = (await postJson(c.fetchImpl, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": c.env.GEMINI_API_KEY!.trim() }, { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })) as GeminiResponse;
  const cand = d.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  // Grounding URIs are Google redirect links; the title carries the source's domain.
  const chunks = (cand?.groundingMetadata?.groundingChunks ?? []).flatMap((g) => (g.web?.uri ? [{ url: g.web.uri, title: g.web.title ?? "", domain: /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(g.web.title ?? "") ? g.web.title! : null }] : []));
  return { text, sources: dedupeSources(chunks), model, costUsd: c.settings.costPerAnswerUsd };
}

type SerpItem = { type: string; markdown?: string | null; text?: string | null; items?: unknown[] | null; references?: { url?: string; title?: string; domain?: string }[] | null };

/** Every `references` entry anywhere inside the AI Overview item (DataForSEO nests them per element). */
function aiOverviewRefs(node: unknown, out: { url: string; title?: string; domain?: string }[] = []) {
  if (Array.isArray(node)) for (const n of node) aiOverviewRefs(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "references" && Array.isArray(v)) {
        for (const r of v as { url?: string; title?: string; domain?: string }[]) if (r?.url) out.push({ url: r.url, title: r.title, domain: r.domain });
      } else if (v && typeof v === "object") aiOverviewRefs(v, out);
    }
  }
  return out;
}

async function askGoogleAiOverview(prompt: string, c: Ctx): Promise<Answer> {
  if (!c.dfsClient) throw new Error("DataForSEO credentials are not set");
  const result = await c.dfsClient.post<{ items?: SerpItem[] | null }>("serp/google/organic/live/advanced", { keyword: prompt.slice(0, 700), location_code: c.dfs.locationCode, language_code: c.dfs.languageCode, depth: 10, load_async_ai_overview: true }, 0.01);
  const ov = (result?.items ?? []).find((i) => i.type === "ai_overview");
  const cost = c.dfsClient.spent;
  c.dfsClient.spent = 0; // each answer carries its own cost
  if (!ov) return { text: "", sources: [], model: "google_serp", costUsd: cost, error: NO_AI_OVERVIEW };
  const text = ov.markdown ?? ((ov.items ?? []) as { text?: string }[]).map((x) => x.text ?? "").join("\n");
  return { text, sources: dedupeSources(aiOverviewRefs(ov)), model: "google_serp", costUsd: cost };
}

const ASK: Record<AiProvider, (prompt: string, c: Ctx) => Promise<Answer>> = { claude: askClaude, chatgpt: askChatGpt, perplexity: askPerplexity, gemini: askGemini, google_ai_overview: askGoogleAiOverview };

/** Upper bound on one call, checked against the remaining budget before it is made. */
function estimate(p: AiProvider, s: SeoSettings["aiVisibility"]): number {
  if (p === "claude") return estimateCostUsd(s.models.claude, 60_000, 4000) + 5 * WEB_SEARCH_USD;
  if (p === "google_ai_overview") return 0.01;
  return s.costPerAnswerUsd;
}

// --- Job ---------------------------------------------------------------------------------------------------------

export async function aiMonthSpend(db: Db, now = new Date()): Promise<number> {
  const [r] = rowsOf<{ usd: number | null }>(await db.execute(sql`select sum(cost_usd) as usd from seo_ai_answers where run_on >= ${`${now.toISOString().slice(0, 7)}-01`}::date`));
  return Number(r?.usd ?? 0);
}

export async function runAiVisibility(ctx: RunContext, deps: AiDeps = {}): Promise<RunOutcome> {
  const s = ctx.settings.aiVisibility;
  const env = deps.env ?? ctx.deps.env ?? process.env;
  if (!s.enabled) throw new SkipRun("AI visibility is switched off (Settings → AI visibility).", "disabled");
  const providers = providerReadiness(ctx.settings, env).filter((p) => p.ready).map((p) => p.id);
  if (!providers.length) throw new SkipRun("No assistant is both enabled and configured (Settings → AI visibility, and its API key).", "not_configured");
  const prompts = rowsOf<{ id: string; prompt: string }>(await ctx.db.execute(sql`select id, prompt from seo_ai_prompts where active order by added_at, prompt limit ${s.maxPrompts}`));
  if (!prompts.length) return { status: "skipped", rows: 0, error: "No prompts yet: add some on the AI visibility page.", errorCode: "no_prompts" };
  let left = s.monthlyBudgetUsd - (await aiMonthSpend(ctx.db, ctx.now));
  if (left <= 0) throw new SkipRun(`Monthly AI visibility budget of $${s.monthlyBudgetUsd} reached.`, "budget");
  const fetchImpl = deps.fetchImpl ?? ctx.deps.fetchImpl ?? fetch;
  const creds = dfsCredentials(env);
  const c: Ctx = { settings: s, dfs: ctx.settings.dataforseo, env, fetchImpl, dfsClient: creds ? new DfsClient(creds, Number.POSITIVE_INFINITY, fetchImpl) : null };
  const host = siteOrigin(env).hostname;
  const names = [site.name, ...s.brandNames];
  const day = ctx.now.toISOString().slice(0, 10);
  const done = new Set(rowsOf<{ k: string }>(await ctx.db.execute(sql`select prompt_id || ':' || provider as k from seo_ai_answers where run_on = ${day} and (error is null or error = ${NO_AI_OVERVIEW})`)).map((r) => r.k));
  let rows = 0;
  let spent = 0;
  let errors = 0;
  let stopped = false;
  for (const p of prompts) {
    const todo = providers.filter((id) => !done.has(`${p.id}:${id}`));
    const affordable: AiProvider[] = [];
    for (const id of todo) {
      if (estimate(id, s) > left) {
        stopped = true;
        break;
      }
      left -= estimate(id, s);
      affordable.push(id);
    }
    const results = await Promise.allSettled(affordable.map((id) => ASK[id](p.prompt, c)));
    for (const [i, r] of results.entries()) {
      const id = affordable[i]!;
      const a: Answer = r.status === "fulfilled" ? r.value : { text: "", sources: [], model: id === "claude" ? s.models.claude : (s.models as Record<string, string>)[id] ?? "", costUsd: 0, error: errorText(r.reason) };
      left += estimate(id, s) - a.costUsd;
      spent += a.costUsd;
      if (a.error && a.error !== NO_AI_OVERVIEW) errors++;
      const m = analyzeAnswer(a.text, a.sources, host, names);
      await ctx.db.execute(sql`
        insert into seo_ai_answers (prompt_id, provider, model, run_on, answer, sources, cited, cited_urls, mentioned, cited_rank, cost_usd, error)
        values (${p.id}, ${id}, ${a.model.slice(0, 120)}, ${day}, ${a.text.slice(0, MAX_ANSWER_CHARS)}, ${JSON.stringify(a.sources.slice(0, 50))}::jsonb, ${m.cited}, ${JSON.stringify(m.citedUrls)}::jsonb, ${m.mentioned}, ${m.citedRank}, ${a.costUsd}, ${a.error?.slice(0, 500) ?? null})
        on conflict (prompt_id, provider, run_on) do update set model = excluded.model, answer = excluded.answer, sources = excluded.sources, cited = excluded.cited,
          cited_urls = excluded.cited_urls, mentioned = excluded.mentioned, cited_rank = excluded.cited_rank, cost_usd = seo_ai_answers.cost_usd + excluded.cost_usd, error = excluded.error, created_at = now()`);
      rows++;
    }
    await ctx.heartbeat();
    if (stopped) break;
  }
  const detail = { prompts: prompts.length, providers, costUsd: Math.round(spent * 1e5) / 1e5, errors };
  if (stopped) return { status: rows ? "partial" : "skipped", rows, error: `Monthly AI visibility budget of $${s.monthlyBudgetUsd} reached; the rest waits for next month or a higher cap.`, errorCode: "budget", detail };
  return { status: errors && errors === rows ? "failed" : errors ? "partial" : "succeeded", rows, detail, ...(errors ? { error: `${errors} answer(s) failed; see the AI visibility page.` } : {}) };
}

function errorText(e: unknown): string {
  if (e instanceof DataForSeoError) return e.message;
  const msg = (e as { message?: string })?.message ?? String(e);
  // Never store a key: API errors can echo request headers in odd setups.
  return msg.replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|pplx-[A-Za-z0-9]{8,})/g, "[key]").slice(0, 300);
}

// --- Prompts -----------------------------------------------------------------------------------------------------

const QUESTION = /^(how|what|why|which|when|where|who|can|is|are|does|do|should|best|top)\b|\b(vs|versus|alternatives?|compared?|difference)\b/i;

/** Question-like Search Console queries with demand, not yet tracked as prompts. */
export async function suggestPrompts(db: Db, limit = 20): Promise<{ query: string; impressions: number }[]> {
  const rows = rowsOf<{ query: string; impressions: number }>(
    await db.execute(sql`
      select q.query, sum(q.impressions)::float8 as impressions from seo_gsc_query_daily q
      where q.search_type = 'web' and q.date > current_date - 90 and length(q.query) between 12 and 200
        and not exists (select 1 from seo_ai_prompts p where lower(p.prompt) = lower(q.query))
        and not exists (select 1 from seo_keyword_ignores i where i.query = q.query)
      group by q.query order by 2 desc limit 400`),
  );
  return rows.filter((r) => QUESTION.test(r.query) && r.query.split(/\s+/).length >= 3).slice(0, limit).map((r) => ({ query: r.query, impressions: Number(r.impressions) }));
}

export async function addPrompt(db: Db, prompt: string, source: "manual" | "search_console", actor: string): Promise<boolean> {
  const p = prompt.trim().replace(/\s+/g, " ").slice(0, 200);
  if (p.length < 5) return false;
  const r = rowsOf<{ id: string }>(await db.execute(sql`insert into seo_ai_prompts (prompt, source, added_by) values (${p}, ${source}, ${actor}) on conflict do nothing returning id`));
  return r.length > 0;
}

// --- Read side ---------------------------------------------------------------------------------------------------

export async function aiVisibilityOverview(weeks = 12) {
  const db = await getDb();
  const host = bare(siteOrigin().hostname);
  const prompts = rowsOf<{ id: string; prompt: string; source: string; active: boolean }>(await db.execute(sql`select id, prompt, source, active from seo_ai_prompts order by active desc, added_at, prompt`));
  const latest = rowsOf<{ prompt_id: string; provider: AiProvider; run_on: string; cited: boolean; mentioned: boolean; cited_rank: number | null; error: string | null; sources: Source[] }>(
    await db.execute(sql`select distinct on (prompt_id, provider) prompt_id, provider, run_on::text, cited, mentioned, cited_rank, error, sources from seo_ai_answers order by prompt_id, provider, run_on desc`),
  );
  const trend = rowsOf<{ week: string; provider: AiProvider; answers: number; cited: number; mentioned: number }>(
    await db.execute(sql`
      select to_char(date_trunc('week', run_on), 'YYYY-MM-DD') as week, provider, count(*)::int as answers, count(*) filter (where cited)::int as cited, count(*) filter (where mentioned)::int as mentioned
      from seo_ai_answers where error is null and run_on > current_date - ${weeks * 7}::int group by 1, 2 order by 1`),
  );
  const ok = latest.filter((l) => !l.error);
  const byProvider = AI_PROVIDERS.map((id) => {
    const rows = ok.filter((l) => l.provider === id);
    return { id, label: AI_PROVIDER_LABEL[id], answers: rows.length, cited: rows.filter((r) => r.cited).length, mentioned: rows.filter((r) => r.mentioned).length, lastRun: rows.map((r) => r.run_on).sort().at(-1) ?? null };
  }).filter((p) => p.answers > 0);
  const competitors = new Map<string, number>();
  for (const l of ok) for (const d of new Set((l.sources ?? []).map((s) => s.domain))) if (d && !onSite(d, host)) competitors.set(d, (competitors.get(d) ?? 0) + 1);
  const cells = new Map<string, Map<AiProvider, (typeof latest)[number]>>();
  for (const l of latest) cells.set(l.prompt_id, (cells.get(l.prompt_id) ?? new Map()).set(l.provider, l));
  const rows = prompts.map((p) => {
    const c = cells.get(p.id) ?? new Map();
    const answered = [...c.values()].filter((x) => !x.error);
    return { ...p, cells: Object.fromEntries(c) as Partial<Record<AiProvider, (typeof latest)[number]>>, gap: answered.length > 0 && !answered.some((x) => x.cited) };
  });
  return {
    host,
    byProvider,
    trend,
    competitors: [...competitors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([domain, prompts]) => ({ domain, prompts })),
    prompts: rows,
    spentUsd: await aiMonthSpend(db),
  };
}

export async function promptHistory(id: string) {
  const db = await getDb();
  const [prompt] = rowsOf<{ id: string; prompt: string; source: string; active: boolean; added_at: string }>(await db.execute(sql`select id, prompt, source, active, added_at::text from seo_ai_prompts where id = ${id}`));
  if (!prompt) return null;
  const answers = rowsOf<{ provider: AiProvider; model: string | null; run_on: string; answer: string | null; sources: Source[]; cited: boolean; mentioned: boolean; cited_rank: number | null; cost_usd: number; error: string | null }>(
    await db.execute(sql`select provider, model, run_on::text, answer, sources, cited, mentioned, cited_rank, cost_usd, error from seo_ai_answers where prompt_id = ${id} order by run_on desc, provider limit 200`),
  );
  return { prompt, answers };
}
