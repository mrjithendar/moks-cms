import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { SkipRun, type RunContext, type RunOutcome } from "./jobs";
import type { SeoSettings } from "./settings";
import { addDays } from "./sqlutil";
import { siteOrigin } from "./urls";

/**
 * DataForSEO (pay as you go; https://dataforseo.com): the licensed third-party source the keyword pages lacked.
 *
 * - `dataforseo_keywords`: search volume, keyword difficulty, CPC and intent for the top Search Console queries and every
 *   tracked keyword (DataForSEO Labs keyword_overview, ≤ 700 keywords per request). Only rows older than `refreshDays`
 *   are fetched again, so the daily run is usually free.
 * - `serp_ranks`: the live Google position of every tracked keyword (SERP API, organic, `depth` results), with the
 *   top results (competitors) and whether the page shows an AI Overview. Works for keywords the site does not rank for
 *   yet, which Search Console cannot show.
 * - `backlinks`: referring-domain snapshot of this site (Backlinks API; DataForSEO bills that API with its own monthly
 *   minimum, so it is off by default). New and lost referring domains are the diff with the previous snapshot.
 *
 * Credentials come only from the environment (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD; the Kubernetes Secret), never the
 * database. Spend is the `cost` DataForSEO returns, stored on each job row (detail.costUsd) and capped by
 * `dataforseo.monthlyBudgetUsd`: a run stops before a request that would cross the cap.
 */
export const DFS_JOB_TYPES = ["dataforseo_keywords", "serp_ranks", "backlinks"] as const;
const BASE = "https://api.dataforseo.com/v3";
const KEYWORDS_PER_REQUEST = 700;
/** Upper bounds used to refuse a request before it is sent (the real cost comes back in the response). */
const EST = { keywordTask: 0.0101, perKeyword: 0.0001, serpPage: 0.002, backlinksSummary: 0.02, referringDomains: 0.05 };

export type DfsDeps = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

export class DataForSeoError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "quota" | "budget" | "api" | "network",
  ) {
    super(message);
  }
}

export function dfsCredentials(env: Record<string, string | undefined> = process.env): { login: string; password: string } | null {
  const login = env.DATAFORSEO_LOGIN?.trim();
  const password = env.DATAFORSEO_PASSWORD?.trim();
  return login && password ? { login, password } : null;
}

type DfsTask<T> = { status_code: number; status_message: string; cost?: number; result: T[] | null };
type DfsResponse<T> = { status_code: number; status_message: string; cost?: number; tasks?: DfsTask<T>[] };

/** One metered client per run: every request checks the remaining budget first and adds the returned cost. */
export class DfsClient {
  spent = 0;
  requests = 0;
  constructor(
    private readonly creds: { login: string; password: string },
    private readonly budgetLeft: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get remaining() {
    return this.budgetLeft - this.spent;
  }

  async post<T>(path: string, payload: Record<string, unknown>, estimate: number): Promise<T> {
    if (estimate > this.remaining) throw new DataForSeoError(`Monthly DataForSEO budget reached (about $${Math.max(0, this.remaining).toFixed(2)} left, next request up to $${estimate.toFixed(3)}).`, "budget");
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}/${path}`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${this.creds.login}:${this.creds.password}`).toString("base64")}`, "Content-Type": "application/json" },
        body: JSON.stringify([payload]),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new DataForSeoError(`DataForSEO request failed: ${(e as Error).message}`.slice(0, 300), "network");
    }
    this.requests++;
    if (res.status === 401 || res.status === 403) throw new DataForSeoError("DataForSEO refused the credentials (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).", "auth");
    if (res.status === 402) throw new DataForSeoError("DataForSEO account has no funds left.", "quota");
    if (!res.ok) throw new DataForSeoError(`DataForSEO HTTP ${res.status}.`, "api");
    const body = (await res.json()) as DfsResponse<T>;
    this.spent += Number(body.cost ?? 0);
    const task = body.tasks?.[0];
    const code = task?.status_code ?? body.status_code;
    if (code !== 20000) {
      const msg = `DataForSEO ${code}: ${task?.status_message ?? body.status_message}`.slice(0, 300);
      throw new DataForSeoError(msg, code >= 40100 && code < 40200 ? "auth" : code >= 40200 && code < 40300 ? "quota" : "api");
    }
    return (task?.result?.[0] ?? null) as T;
  }
}

/** USD spent on DataForSEO this calendar month (UTC), from the job rows. */
export async function monthSpend(db: Db, now = new Date()): Promise<number> {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  const [r] = rowsOf<{ usd: number | null }>(
    await db.execute(sql`select sum((detail->>'costUsd')::float8) as usd from seo_sync_jobs where job_type in ('dataforseo_keywords', 'serp_ranks', 'backlinks') and started_at >= ${month}::date`),
  );
  return Number(r?.usd ?? 0);
}

async function client(ctx: RunContext, deps: DfsDeps): Promise<DfsClient> {
  const d = ctx.settings.dataforseo;
  if (!d.enabled) throw new SkipRun("DataForSEO is switched off (Settings → Data sources).", "disabled");
  const creds = dfsCredentials(deps.env ?? ctx.deps.env);
  if (!creds) throw new SkipRun("DataForSEO credentials are not configured (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD).", "not_configured");
  const left = d.monthlyBudgetUsd - (await monthSpend(ctx.db, ctx.now));
  if (left <= 0) throw new SkipRun(`Monthly DataForSEO budget of $${d.monthlyBudgetUsd} reached.`, "budget");
  return new DfsClient(creds, left, deps.fetchImpl ?? ctx.deps.fetchImpl);
}

/** Wraps a run: records spend on the job row, maps API errors to the job outcome, keeps partial work. */
async function metered(ctx: RunContext, deps: DfsDeps, body: (c: DfsClient) => Promise<{ rows: number; detail?: Record<string, unknown> }>): Promise<RunOutcome> {
  const c = await client(ctx, deps);
  try {
    const r = await body(c);
    ctx.stats.apiRequests += c.requests;
    return { status: "succeeded", rows: r.rows, detail: { ...r.detail, costUsd: round(c.spent), requests: c.requests } };
  } catch (e) {
    ctx.stats.apiRequests += c.requests;
    if (!(e instanceof DataForSeoError)) throw e;
    const partial = e.code === "budget" && c.requests > 0;
    return { status: partial ? "partial" : e.code === "budget" ? "skipped" : "failed", rows: 0, error: e.message, errorCode: e.code, detail: { costUsd: round(c.spent), requests: c.requests } };
  }
}

/** A Postgres text[] literal (the pattern keywords.ts uses for `any(...)`). */
const textArray = (xs: string[]) => `{${xs.map((x) => `"${x.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
const round = (n: number) => Math.round(n * 1e5) / 1e5;
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const float = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// --- Keyword metrics ---------------------------------------------------------------------------------------------

type KeywordOverviewItem = {
  keyword: string;
  keyword_info?: { search_volume?: number | null; cpc?: number | null; competition?: number | null; monthly_searches?: { year: number; month: number; search_volume: number | null }[] | null } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};

/** Queries whose metrics are missing or older than `refreshDays`: tracked keywords first, then by impressions. */
export async function staleKeywords(db: Db, s: SeoSettings["dataforseo"], now: Date): Promise<string[]> {
  const since = addDays(now.toISOString().slice(0, 10), -90);
  const cutoff = new Date(now.getTime() - s.keywordMetrics.refreshDays * 86_400_000).toISOString();
  const rows = rowsOf<{ query: string }>(
    await db.execute(sql`
      with candidates as (
        select query, 1e12::float8 as weight from seo_tracked_keywords
        union all
        select query, sum(impressions)::float8 from seo_gsc_query_daily where search_type = 'web' and date > ${since} group by query),
      ranked as (select query, max(weight) as weight from candidates group by query order by 2 desc limit ${s.keywordMetrics.maxKeywords})
      select r.query from ranked r left join seo_keyword_metrics m on m.query = r.query
      where (m.query is null or m.fetched_at < ${cutoff} or m.location_code <> ${s.locationCode} or m.language_code <> ${s.languageCode})
        and not exists (select 1 from seo_keyword_ignores i where i.query = r.query)
        and length(r.query) <= 80 and array_length(regexp_split_to_array(trim(r.query), '\\s+'), 1) <= 10
      order by r.weight desc`),
  );
  return rows.map((r) => r.query);
}

export async function runKeywordMetrics(ctx: RunContext, deps: DfsDeps = {}): Promise<RunOutcome> {
  const s = ctx.settings.dataforseo;
  if (!s.keywordMetrics.enabled) throw new SkipRun("Keyword metrics are switched off.", "disabled");
  const queries = await staleKeywords(ctx.db, s, ctx.now);
  if (!queries.length) return { status: "succeeded", rows: 0, detail: { costUsd: 0, upToDate: true } };
  return metered(ctx, deps, async (c) => {
    let rows = 0;
    for (let i = 0; i < queries.length; i += KEYWORDS_PER_REQUEST) {
      const batch = queries.slice(i, i + KEYWORDS_PER_REQUEST);
      const result = await c.post<{ items?: KeywordOverviewItem[] | null }>("dataforseo_labs/google/keyword_overview/live", { keywords: batch, location_code: s.locationCode, language_code: s.languageCode, include_serp_info: false }, EST.keywordTask + EST.perKeyword * batch.length);
      const byKeyword = new Map((result?.items ?? []).map((it) => [it.keyword.toLowerCase(), it]));
      // Every requested keyword gets a row, also those DataForSEO has no data for (volume null), so they are not re-bought daily.
      const values = batch.map((q) => {
        const it = byKeyword.get(q.toLowerCase());
        const ki = it?.keyword_info ?? {};
        const monthly = (ki.monthly_searches ?? []).slice(0, 12).map((m) => ({ month: `${m.year}-${String(m.month).padStart(2, "0")}`, volume: m.search_volume }));
        return sql`(${q}, ${s.locationCode}, ${s.languageCode}, ${int(ki.search_volume)}, ${int(it?.keyword_properties?.keyword_difficulty)}, ${float(ki.cpc)}, ${float(ki.competition)}, ${it?.search_intent_info?.main_intent ?? null}, ${JSON.stringify(monthly)}::jsonb, ${ctx.now.toISOString()})`;
      });
      await ctx.db.execute(sql`
        insert into seo_keyword_metrics (query, location_code, language_code, search_volume, keyword_difficulty, cpc, competition, main_intent, monthly_searches, fetched_at)
        values ${sql.join(values, sql`, `)}
        on conflict (query) do update set location_code = excluded.location_code, language_code = excluded.language_code, search_volume = excluded.search_volume,
          keyword_difficulty = excluded.keyword_difficulty, cpc = excluded.cpc, competition = excluded.competition, main_intent = excluded.main_intent,
          monthly_searches = excluded.monthly_searches, fetched_at = excluded.fetched_at`);
      rows += batch.length;
      await ctx.heartbeat();
    }
    return { rows, detail: { keywords: rows } };
  });
}

// --- SERP rank tracking ------------------------------------------------------------------------------------------

type SerpItem = { type: string; rank_group?: number; rank_absolute?: number; domain?: string; url?: string; title?: string };
type SerpResult = { item_types?: string[] | null; items?: SerpItem[] | null; se_results_count?: number | null };

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Our organic position (rank_group) and the top organic results, from one SERP. */
export function readSerp(result: SerpResult | null, host: string): { position: number | null; url: string | null; aiOverview: boolean; itemTypes: string[]; top: { position: number; domain: string; url: string; title: string }[] } {
  const organic = (result?.items ?? []).filter((i) => i.type === "organic" && i.domain && i.url);
  const own = organic.find((i) => bare(i.domain!) === bare(host) || bare(i.domain!).endsWith(`.${bare(host)}`));
  const itemTypes = [...new Set(result?.item_types ?? [])];
  return {
    position: own?.rank_group ?? null,
    url: own?.url ?? null,
    aiOverview: itemTypes.includes("ai_overview"),
    itemTypes,
    top: organic.slice(0, 10).map((i) => ({ position: i.rank_group ?? 0, domain: bare(i.domain!), url: i.url!, title: (i.title ?? "").slice(0, 200) })),
  };
}

export async function runSerpRanks(ctx: RunContext, deps: DfsDeps = {}): Promise<RunOutcome> {
  const s = ctx.settings.dataforseo;
  if (!s.rankTracking.enabled) throw new SkipRun("Rank tracking is switched off.", "disabled");
  const tracked = rowsOf<{ query: string }>(await ctx.db.execute(sql`select query from seo_tracked_keywords order by added_at`)).map((r) => r.query);
  if (!tracked.length) return { status: "succeeded", rows: 0, detail: { costUsd: 0, tracked: 0 } };
  const host = siteOrigin(ctx.deps.env ?? process.env).hostname;
  const day = ctx.now.toISOString().slice(0, 10);
  const pages = Math.ceil(s.rankTracking.depth / 10);
  return metered(ctx, deps, async (c) => {
    let rows = 0;
    for (const query of tracked) {
      const result = await c.post<SerpResult>("serp/google/organic/live/regular", { keyword: query, location_code: s.locationCode, language_code: s.languageCode, depth: s.rankTracking.depth }, EST.serpPage * pages);
      const r = readSerp(result, host);
      await ctx.db.execute(sql`
        insert into seo_serp_ranks (query, checked_on, location_code, language_code, position, url, ai_overview, item_types, top_results, checked_at)
        values (${query}, ${day}, ${s.locationCode}, ${s.languageCode}, ${r.position}, ${r.url}, ${r.aiOverview}, ${JSON.stringify(r.itemTypes)}::jsonb, ${JSON.stringify(r.top)}::jsonb, ${ctx.now.toISOString()})
        on conflict (query, checked_on, location_code) do update set position = excluded.position, url = excluded.url, ai_overview = excluded.ai_overview,
          item_types = excluded.item_types, top_results = excluded.top_results, checked_at = excluded.checked_at, language_code = excluded.language_code`);
      rows++;
      await ctx.heartbeat();
    }
    return { rows, detail: { tracked: tracked.length } };
  });
}

// --- Backlinks ---------------------------------------------------------------------------------------------------

type BacklinksSummary = Record<string, unknown> & { backlinks?: number; referring_domains?: number; rank?: number; broken_backlinks?: number; referring_domains_nofollow?: number; backlinks_spam_score?: number };
type ReferringDomain = { domain: string; rank?: number | null; backlinks?: number | null; first_seen?: string | null; backlinks_spam_score?: number | null };

export async function runBacklinks(ctx: RunContext, deps: DfsDeps = {}): Promise<RunOutcome> {
  if (!ctx.settings.dataforseo.backlinks.enabled) throw new SkipRun("Backlinks are switched off (the Backlinks API needs its own DataForSEO subscription).", "disabled");
  const target = bare(siteOrigin(ctx.deps.env ?? process.env).hostname);
  return metered(ctx, deps, async (c) => {
    const summary = await c.post<BacklinksSummary>("backlinks/summary/live", { target, include_subdomains: true }, EST.backlinksSummary);
    const domains = await c.post<{ items?: ReferringDomain[] | null }>("backlinks/referring_domains/live", { target, include_subdomains: true, limit: 1000, order_by: ["rank,desc"], exclude_internal_backlinks: true }, EST.referringDomains);
    const keep = ["backlinks", "referring_domains", "referring_main_domains", "referring_domains_nofollow", "rank", "broken_backlinks", "broken_pages", "backlinks_spam_score", "referring_ips"];
    const sum = Object.fromEntries(keep.filter((k) => summary?.[k] !== undefined).map((k) => [k, summary![k]]));
    const [snap] = rowsOf<{ id: string }>(await ctx.db.execute(sql`insert into seo_backlink_snapshots (target, summary, taken_at) values (${target}, ${JSON.stringify(sum)}::jsonb, ${ctx.now.toISOString()}) returning id`));
    const items = (domains?.items ?? []).filter((d) => d.domain);
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200).map((d) => sql`(${snap!.id}, ${bare(d.domain)}, ${int(d.rank)}, ${int(d.backlinks)}, ${d.first_seen ? new Date(d.first_seen).toISOString() : null}, ${int(d.backlinks_spam_score)})`);
      await ctx.db.execute(sql`insert into seo_referring_domains (snapshot_id, domain, rank, backlinks, first_seen, spam_score) values ${sql.join(chunk, sql`, `)} on conflict do nothing`);
    }
    // Keep a year of snapshots.
    await ctx.db.execute(sql`delete from seo_backlink_snapshots where taken_at < ${new Date(ctx.now.getTime() - 365 * 86_400_000).toISOString()}`);
    return { rows: items.length, detail: { snapshotId: snap!.id, referringDomains: sum.referring_domains ?? items.length } };
  });
}

// --- Read side (admin pages, reports) ----------------------------------------------------------------------------

export async function dataForSeoStatus(s: SeoSettings, env: Record<string, string | undefined> = process.env) {
  const db = await getDb();
  const jobs = rowsOf<{ job_type: string; status: string; finished_at: string | null; error: string | null }>(
    await db.execute(sql`select distinct on (job_type) job_type, status, finished_at::text, error from seo_sync_jobs where job_type in ('dataforseo_keywords', 'serp_ranks', 'backlinks') order by job_type, started_at desc`),
  );
  return { enabled: s.dataforseo.enabled, credentials: Boolean(dfsCredentials(env)), budgetUsd: s.dataforseo.monthlyBudgetUsd, spentUsd: round(await monthSpend(db)), lastRuns: jobs };
}

export async function serpHistory(queries: string[], days = 120) {
  if (!queries.length) return new Map<string, { latest: { position: number | null; aiOverview: boolean; checkedOn: string; top: { position: number; domain: string }[] } | null; positions: (number | null)[] }>();
  const db = await getDb();
  const rows = rowsOf<{ query: string; checked_on: string; position: number | null; ai_overview: boolean; top_results: { position: number; domain: string }[] }>(
    await db.execute(sql`select query, checked_on::text, position, ai_overview, top_results from seo_serp_ranks where query = any(${textArray(queries)}::text[]) and checked_on > current_date - ${days}::int order by query, checked_on`),
  );
  const out = new Map<string, { latest: { position: number | null; aiOverview: boolean; checkedOn: string; top: { position: number; domain: string }[] } | null; positions: (number | null)[] }>();
  for (const r of rows) {
    const e = out.get(r.query) ?? { latest: null, positions: [] };
    e.positions.push(r.position === null ? null : Number(r.position));
    e.latest = { position: r.position === null ? null : Number(r.position), aiOverview: Boolean(r.ai_overview), checkedOn: r.checked_on, top: (r.top_results ?? []).slice(0, 5) };
    out.set(r.query, e);
  }
  return out;
}

export async function backlinkOverview() {
  const db = await getDb();
  const snaps = rowsOf<{ id: string; taken_at: string; summary: Record<string, number> }>(await db.execute(sql`select id, taken_at::text, summary from seo_backlink_snapshots order by taken_at desc limit 2`));
  const [cur, prev] = snaps;
  if (!cur) return null;
  const top = rowsOf<{ domain: string; rank: number | null; backlinks: number | null; first_seen: string | null; spam_score: number | null }>(
    await db.execute(sql`select domain, rank, backlinks, first_seen::text, spam_score from seo_referring_domains where snapshot_id = ${cur.id} order by rank desc nulls last, backlinks desc nulls last limit 100`),
  );
  const diff = async (a: string, b: string) =>
    rowsOf<{ domain: string; rank: number | null; backlinks: number | null }>(
      await db.execute(sql`select domain, rank, backlinks from seo_referring_domains d where snapshot_id = ${a} and not exists (select 1 from seo_referring_domains o where o.snapshot_id = ${b} and o.domain = d.domain) order by rank desc nulls last limit 100`),
    );
  return {
    takenAt: cur.taken_at,
    previousAt: prev?.taken_at ?? null,
    summary: cur.summary,
    previousSummary: prev?.summary ?? null,
    top,
    gained: prev ? await diff(cur.id, prev.id) : [],
    lost: prev ? await diff(prev.id, cur.id) : [],
  };
}
