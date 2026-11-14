import type { TopicsSettings } from "./settings";

/**
 * Trend collectors for topic discovery (docs/seo/TOPICS.md). Each reads a public listing API, keeps only the title, the
 * link and the counts (no usernames, no bodies), and never throws: a source that fails reports "error" and the run
 * goes on with the others. Reddit is not fetched here: its threads come from the table Promotion already fills.
 *
 * - Hacker News: Algolia search API (no key).
 * - dev.to: public articles API (no key), top of the week per tag.
 * - GitHub: repository search (no key; 10 requests a minute unauthenticated, so at most 8 terms a run).
 * - X: API v2 recent search. Off until an API bearer token is saved (Admin → Advanced settings, X_BEARER_TOKEN) and
 *   the source is switched on; recent search needs a paid X API plan.
 */
export type TrendSource = "hackernews" | "devto" | "github" | "reddit" | "x";
export type Signal = { source: TrendSource; externalId: string; title: string; url: string; score: number; comments: number; postedAt: string | null };
export type SourceStatus = "ok" | "off" | "not_configured" | "error";
export type SourceResult = { source: TrendSource; status: SourceStatus; signals: Signal[]; error?: string };
export type SourceDeps = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; now?: Date };

const TIMEOUT_MS = 10_000;
const USER_AGENT = "jithendar.com topic discovery (+https://jithendar.com)";
const clean = (s: unknown, max = 240) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const int = (n: unknown) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0);
const iso = (v: unknown): string | null => {
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

async function getJson(url: string, deps: SourceDeps, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await (deps.fetchImpl ?? fetch)(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Run one collector; any failure becomes an "error" result with whatever was collected before it. */
async function guarded(source: TrendSource, run: (out: Signal[]) => Promise<void>): Promise<SourceResult> {
  const signals: Signal[] = [];
  try {
    await run(signals);
    return { source, status: "ok", signals: dedupe(signals) };
  } catch (e) {
    return { source, status: "error", signals: dedupe(signals), error: clean(e instanceof Error ? e.message : e, 200) };
  }
}

function dedupe(rows: Signal[]): Signal[] {
  const seen = new Map<string, Signal>();
  for (const r of rows) if (r.title && r.url && !seen.has(r.externalId)) seen.set(r.externalId, r);
  return [...seen.values()];
}

export function hackerNews(s: TopicsSettings, deps: SourceDeps = {}): Promise<SourceResult> {
  const since = Math.floor(((deps.now ?? new Date()).getTime() - 7 * 86_400_000) / 1000);
  return guarded("hackernews", async (out) => {
    for (const term of s.terms.slice(0, 12)) {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(term)}&tags=story&numericFilters=${encodeURIComponent(`created_at_i>${since},points>${s.hnMinPoints}`)}&hitsPerPage=20`;
      const data = (await getJson(url, deps)) as { hits?: Record<string, unknown>[] };
      for (const h of data.hits ?? []) {
        const id = clean(h.objectID, 40);
        if (!id) continue;
        out.push({ source: "hackernews", externalId: id, title: clean(h.title), url: clean(h.url, 500) || `https://news.ycombinator.com/item?id=${id}`, score: int(h.points), comments: int(h.num_comments), postedAt: iso(h.created_at) });
      }
    }
  });
}

export function devTo(s: TopicsSettings, deps: SourceDeps = {}): Promise<SourceResult> {
  const tags = [...new Set(s.terms.map((t) => t.replace(/[^a-z0-9]/g, "")).filter((t) => t.length >= 2))].slice(0, 12);
  return guarded("devto", async (out) => {
    for (const tag of tags) {
      const data = (await getJson(`https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&top=7&per_page=20`, deps)) as Record<string, unknown>[];
      for (const a of Array.isArray(data) ? data : []) {
        const id = clean(a.id, 40);
        if (!id) continue;
        out.push({ source: "devto", externalId: id, title: clean(a.title), url: clean(a.url, 500), score: int(a.positive_reactions_count), comments: int(a.comments_count), postedAt: iso(a.published_at) });
      }
    }
  });
}

export function github(s: TopicsSettings, deps: SourceDeps = {}): Promise<SourceResult> {
  const since = new Date((deps.now ?? new Date()).getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return guarded("github", async (out) => {
    for (const term of s.terms.slice(0, 8)) {
      const q = `${term} in:name,description,topics created:>${since} stars:>50`;
      const data = (await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`, deps, { Accept: "application/vnd.github+json" })) as { items?: Record<string, unknown>[] };
      for (const r of data.items ?? []) {
        const id = clean(r.id, 40);
        if (!id) continue;
        out.push({ source: "github", externalId: id, title: clean(`${clean(r.full_name, 100)}: ${clean(r.description, 160)}`), url: clean(r.html_url, 500), score: int(r.stargazers_count), comments: int(r.forks_count), postedAt: iso(r.created_at) });
      }
    }
  });
}

/** X recent search (API v2). Groups of terms are OR-ed into one query each to stay under the query length limit. */
export async function xPosts(s: TopicsSettings, deps: SourceDeps = {}): Promise<SourceResult> {
  const token = (deps.env ?? process.env).X_BEARER_TOKEN?.trim();
  if (!token) return { source: "x", status: "not_configured", signals: [] };
  const groups: string[][] = [];
  for (let i = 0; i < Math.min(s.terms.length, 18); i += 6) groups.push(s.terms.slice(i, i + 6));
  return guarded("x", async (out) => {
    for (const g of groups) {
      const query = `(${g.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ")}) lang:en -is:retweet -is:reply has:links`;
      const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=50&sort_order=relevancy&tweet.fields=created_at,public_metrics`;
      const data = (await getJson(url, deps, { Authorization: `Bearer ${token}` })) as { data?: Record<string, unknown>[] };
      for (const p of data.data ?? []) {
        const id = clean(p.id, 40);
        const m = (p.public_metrics ?? {}) as Record<string, unknown>;
        const title = clean(String(p.text ?? "").replace(/https?:\/\/\S+/g, ""), 200);
        if (!/^\d{5,25}$/.test(id) || title.length < 15) continue;
        out.push({ source: "x", externalId: id, title, url: `https://x.com/i/status/${id}`, score: int(m.like_count) + 2 * int(m.retweet_count), comments: int(m.reply_count), postedAt: iso(p.created_at) });
      }
    }
  });
}

/** Every enabled network source, in parallel. */
export async function collectTrends(s: TopicsSettings, deps: SourceDeps = {}): Promise<SourceResult[]> {
  const off = (source: TrendSource): SourceResult => ({ source, status: "off", signals: [] });
  return Promise.all([s.sources.hackernews ? hackerNews(s, deps) : off("hackernews"), s.sources.devto ? devTo(s, deps) : off("devto"), s.sources.github ? github(s, deps) : off("github"), s.sources.x ? xPosts(s, deps) : off("x")]);
}
