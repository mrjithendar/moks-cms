import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { similarity, tokens } from "../keywords";
import { dataForSeoDifficulty, proxyDifficulty } from "./difficulty";
import { getTopicsSettings, type TopicsSettings } from "./settings";
import { collectTrends, type Signal, type SourceDeps, type SourceStatus } from "./sources";

/**
 * Topic discovery (docs/seo/TOPICS.md): what is worth writing next, with the evidence.
 *
 * Inputs: Search Console queries the site gets impressions for without ranking well (28 days), and trending items from
 * public sources (7 to 30 days). Both are filtered to the site's subjects (settings.terms), grouped into topics by
 * shared words, dropped when the site or the editorial calendar already has the topic, and scored 0 to 100:
 *
 *   score = weighted mean of  demand (search impressions)  · trend (points and comments, newer counts more,
 *           several sources count more)  · fit (share of the topic's words the site already writes about)
 *           · ease (100 − keyword difficulty; the proxy unless DataForSEO is on).
 *
 * Deterministic, no model call: grouping is lexical (the same token similarity the keyword clusters use), so the same
 * inputs always give the same list and every number on a candidate can be traced to its evidence.
 */
export type Keyword = { query: string; impressions: number; clicks: number; position: number | null };
export type Parts = { demand: number; trend: number; fit: number; ease: number };
export type Candidate = {
  key: string;
  title: string;
  kind: "keyword" | "trend" | "both";
  queries: string[];
  signals: Signal[];
  impressions: number;
  position: number | null;
  parts: Parts;
  score: number;
  difficulty: number;
  difficultySource: "proxy" | "dataforseo";
  reasons: string[];
};

const SOURCE_NAMES: Record<Signal["source"], string> = { hackernews: "Hacker News", devto: "dev.to", github: "GitHub", reddit: "Reddit", x: "X" };
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const logScale = (v: number, full: number) => clamp((100 * Math.log10(1 + Math.max(0, v))) / Math.log10(1 + full));

/** Stable identity of a topic: its significant words, sorted. */
export const topicKey = (text: string) => [...tokens(text)].sort().join("-").slice(0, 160);

type Group = { title: string; tok: Set<string>; queries: string[]; signals: Signal[]; impressions: number; position: number | null };

export function buildCandidates(input: { keywords: Keyword[]; signals: Signal[]; siteTitles: string[]; taken: string[]; settings: TopicsSettings; now: Date; difficulty?: Map<string, number> | null }): Candidate[] {
  const { settings: s, now } = input;
  const termTokens = new Set(s.terms.flatMap((t) => [...tokens(t)]));
  const vocab = new Set(input.siteTitles.flatMap((t) => [...tokens(t)]));
  const relevant = (tok: Set<string>) => [...tok].some((t) => termTokens.has(t));

  // Search demand the site does not serve well yet: queries with impressions that rank outside the top 8.
  const groups: Group[] = [];
  const kws = input.keywords.filter((k) => k.impressions >= s.minImpressions && (k.position === null || k.position > 8)).sort((a, b) => b.impressions - a.impressions);
  for (const k of s.sources.searchConsole ? kws : []) {
    const tok = tokens(k.query);
    if (tok.size < 2 || !relevant(tok)) continue;
    const g = groups.find((x) => similarity(x.tok, tok) >= 0.6);
    if (g) {
      g.impressions += k.impressions;
      if (g.queries.length < 10) g.queries.push(k.query);
    } else groups.push({ title: k.query, tok, queries: [k.query], signals: [], impressions: k.impressions, position: k.position });
  }

  // Trends: items about the site's subjects, grouped by shared words; a trend that matches a query group joins it.
  const weightOf = (x: Signal) => x.score + 2 * x.comments;
  const trendGroups: Group[] = [];
  for (const sig of [...input.signals].sort((a, b) => weightOf(b) - weightOf(a))) {
    const tok = tokens(sig.title);
    if (tok.size < 2 || !relevant(tok)) continue;
    const kw = groups.find((x) => similarity(x.tok, tok) >= 0.45);
    if (kw) {
      if (kw.signals.length < 8) kw.signals.push(sig);
      continue;
    }
    const g = trendGroups.find((x) => similarity(x.tok, tok) >= 0.5);
    if (g) {
      if (g.signals.length < 8) g.signals.push(sig);
    } else trendGroups.push({ title: sig.title, tok, queries: [], signals: [sig], impressions: 0, position: null });
  }

  const takenTok = input.taken.map((t) => tokens(t)).filter((t) => t.size > 0);
  const totalWeight = s.weights.demand + s.weights.trend + s.weights.fit + s.weights.ease;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const g of [...groups, ...trendGroups]) {
    const key = topicKey(g.title);
    if (!key || seen.has(key)) continue;
    if (takenTok.some((t) => similarity(t, g.tok) >= 0.6)) continue; // already written or already planned
    seen.add(key);
    const fitShare = [...g.tok].filter((t) => vocab.has(t)).length / g.tok.size;
    const trendOnly = g.impressions === 0;
    const sources = [...new Set(g.signals.map((x) => x.source))];
    const heat = g.signals.reduce((sum, x) => {
      const ageDays = x.postedAt ? Math.max(0, (now.getTime() - new Date(x.postedAt).getTime()) / 86_400_000) : 7;
      return sum + weightOf(x) * 0.5 ** (ageDays / 7);
    }, 0);
    const proxy = proxyDifficulty({ words: g.tok.size, position: g.position, fit: fitShare, trendOnly });
    const measured = input.difficulty?.get(g.title.toLowerCase().trim());
    const difficulty = measured ?? proxy.value;
    const parts: Parts = {
      demand: round1(logScale(g.impressions, 5000)),
      trend: round1(g.signals.length ? clamp(logScale(heat, 2000) + 10 * (sources.length - 1)) : 0),
      fit: round1(100 * fitShare),
      ease: round1(100 - difficulty),
    };
    const score = round1((s.weights.demand * parts.demand + s.weights.trend * parts.trend + s.weights.fit * parts.fit + s.weights.ease * parts.ease) / totalWeight);
    if (score < s.minScore) continue;
    const reasons: string[] = [];
    if (g.impressions > 0) reasons.push(`${Math.round(g.impressions)} search impressions in 28 days${g.position !== null ? ` at average position ${g.position.toFixed(1)}` : ""}, and no article targets it yet.`);
    if (g.signals.length) {
      const top = g.signals[0]!;
      reasons.push(`${g.signals.length} trending item${g.signals.length === 1 ? "" : "s"} on ${sources.map((x) => SOURCE_NAMES[x]).join(", ")} (top: ${top.score} points, ${top.comments} comments).`);
    }
    reasons.push(`${Math.round(100 * fitShare)}% of its words are subjects the site already writes about.`);
    reasons.push(measured !== undefined ? `Keyword difficulty ${Math.round(difficulty)}/100 (DataForSEO).` : `Keyword difficulty ${Math.round(difficulty)}/100 (proxy${proxy.reasons.length ? `: ${proxy.reasons.join(", ")}` : ""}).`);
    out.push({ key, title: g.title.slice(0, 200), kind: trendOnly ? "trend" : g.signals.length ? "both" : "keyword", queries: g.queries, signals: g.signals, impressions: g.impressions, position: g.position, parts, score, difficulty: round1(difficulty), difficultySource: measured !== undefined ? "dataforseo" : "proxy", reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, s.maxCandidates);
}

// --- Storage and the job ---------------------------------------------------------------------------------------------

export type DiscoveryResult = { status: "succeeded" | "skipped" | "partial"; candidates: number; signals: number; sources: Record<string, SourceStatus>; difficulty: "proxy" | "dataforseo"; reason?: string };

async function storeSignals(db: Db, signals: Signal[]) {
  for (const x of signals) {
    await db.execute(sql`
      insert into seo_topic_signals (source, external_id, title, url, score, comments, posted_at, fetched_at)
      values (${x.source}, ${x.externalId}, ${x.title}, ${x.url}, ${x.score}, ${x.comments}, ${x.postedAt}::timestamptz, now())
      on conflict (source, external_id) do update set title = excluded.title, url = excluded.url, score = excluded.score, comments = excluded.comments, fetched_at = now()`);
  }
}

/** Collect, score and store. Never throws for a source that fails; the outcome says which sources answered. */
export async function runTopicDiscovery(db: Db, deps: SourceDeps = {}): Promise<DiscoveryResult> {
  const s = await getTopicsSettings();
  const now = deps.now ?? new Date();
  if (!s.enabled) return { status: "skipped", candidates: 0, signals: 0, sources: {}, difficulty: "proxy", reason: "Topic discovery is switched off." };

  const results = await collectTrends(s, deps);
  await storeSignals(db, results.flatMap((r) => r.signals));
  await db.execute(sql`delete from seo_topic_signals where fetched_at < ${new Date(now.getTime() - 30 * 86_400_000).toISOString()}::timestamptz`);
  const sources: Record<string, SourceStatus> = Object.fromEntries(results.map((r) => [r.source, r.status]));
  sources.reddit = s.sources.reddit ? "ok" : "off";
  sources.searchConsole = s.sources.searchConsole ? "ok" : "off";

  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const stored = rowsOf<{ source: Signal["source"]; external_id: string; title: string; url: string; score: number; comments: number; posted_at: string | null }>(
    await db.execute(sql`select source, external_id, title, url, score, comments, posted_at from seo_topic_signals where fetched_at >= ${since}::timestamptz`),
  );
  const reddit = s.sources.reddit
    ? rowsOf<{ external_id: string; title: string; url: string; score: number; comments: number; posted_at: string | null }>(
        await db.execute(sql`select external_id, title, url, score, comments, posted_at from seo_promo_signals where source = 'reddit' and fetched_at >= ${since}::timestamptz`),
      )
    : [];
  const signals: Signal[] = [
    ...stored.map((r) => ({ source: r.source, externalId: r.external_id, title: r.title, url: r.url, score: Number(r.score), comments: Number(r.comments), postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null })),
    ...reddit.map((r) => ({ source: "reddit" as const, externalId: r.external_id, title: r.title, url: r.url, score: Number(r.score), comments: Number(r.comments), postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null })),
  ].filter((x) => (x.source === "reddit" ? true : s.sources[x.source]));

  const from = new Date(now.getTime() - 28 * 86_400_000).toISOString().slice(0, 10);
  const keywords = s.sources.searchConsole
    ? rowsOf<{ query: string; impressions: number; clicks: number; position: number | null }>(
        await db.execute(sql`
          select query, sum(impressions)::float8 as impressions, sum(clicks)::float8 as clicks,
            (sum(position * impressions) / nullif(sum(case when position is null then 0 else impressions end), 0))::float8 as position
          from seo_gsc_query_daily where search_type = 'web' and date >= ${from}::date
          group by query having sum(impressions) >= ${s.minImpressions} order by 2 desc limit 2000`),
      ).map((r) => ({ query: r.query, impressions: Number(r.impressions), clicks: Number(r.clicks), position: r.position === null ? null : Number(r.position) }))
    : [];
  const siteTitles = rowsOf<{ title: string }>(await db.execute(sql`select title from post where deleted_at is null`)).map((r) => r.title);
  const planned = rowsOf<{ title: string }>(await db.execute(sql`select title from seo_editorial_calendar where status <> 'dropped'`)).map((r) => r.title);
  const base = { keywords, signals, siteTitles, taken: [...siteTitles, ...planned], settings: s, now };

  let candidates = buildCandidates(base);
  const measured = await dataForSeoDifficulty(candidates.map((c) => c.title), s, deps);
  if (measured) candidates = buildCandidates({ ...base, difficulty: measured });

  for (const c of candidates) {
    await db.execute(sql`
      insert into seo_topic_candidates (key, title, kind, queries, signals, impressions, position, parts, score, difficulty, difficulty_source, reasons)
      values (${c.key}, ${c.title}, ${c.kind}, ${JSON.stringify(c.queries)}::jsonb, ${JSON.stringify(c.signals)}::jsonb, ${c.impressions}, ${c.position}, ${JSON.stringify(c.parts)}::jsonb, ${c.score}, ${c.difficulty}, ${c.difficultySource}, ${JSON.stringify(c.reasons)}::jsonb)
      on conflict (key) do update set title = excluded.title, kind = excluded.kind, queries = excluded.queries, signals = excluded.signals, impressions = excluded.impressions, position = excluded.position,
        parts = excluded.parts, score = excluded.score, difficulty = excluded.difficulty, difficulty_source = excluded.difficulty_source, reasons = excluded.reasons, updated_at = now()`);
  }
  // Candidates nobody acted on that no longer come up are forgotten after 30 days.
  await db.execute(sql`delete from seo_topic_candidates where status = 'new' and updated_at < ${new Date(now.getTime() - 30 * 86_400_000).toISOString()}::timestamptz`);

  const failed = results.some((r) => r.status === "error");
  return { status: failed ? "partial" : "succeeded", candidates: candidates.length, signals: signals.length, sources, difficulty: measured ? "dataforseo" : "proxy" };
}

// --- The admin list ------------------------------------------------------------------------------------------------

export type StoredTopic = Candidate & { id: string; status: "new" | "scheduled" | "dismissed"; calendarId: string | null; firstSeen: string; updatedAt: string };

const shape = (r: Record<string, unknown>): StoredTopic => ({
  id: String(r.id),
  key: String(r.key),
  title: String(r.title),
  kind: String(r.kind) as Candidate["kind"],
  queries: (r.queries as string[]) ?? [],
  signals: (r.signals as Signal[]) ?? [],
  impressions: Number(r.impressions),
  position: r.position === null || r.position === undefined ? null : Number(r.position),
  parts: (r.parts as Parts) ?? { demand: 0, trend: 0, fit: 0, ease: 0 },
  score: Number(r.score),
  difficulty: Number(r.difficulty),
  difficultySource: String(r.difficulty_source) === "dataforseo" ? "dataforseo" : "proxy",
  reasons: (r.reasons as string[]) ?? [],
  status: String(r.status) as StoredTopic["status"],
  calendarId: (r.calendar_id as string | null) ?? null,
  firstSeen: new Date(String(r.first_seen)).toISOString(),
  updatedAt: new Date(String(r.updated_at)).toISOString(),
});

export async function listTopics(db: Db, status: StoredTopic["status"] = "new", limit = 100): Promise<StoredTopic[]> {
  return rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_topic_candidates where status = ${status} order by score desc, key limit ${Math.max(1, Math.min(200, limit))}`)).map(shape);
}

export async function dismissTopic(db: Db, id: string): Promise<boolean> {
  return rowsOf(await db.execute(sql`update seo_topic_candidates set status = 'dismissed', updated_at = now() where id = ${id} and status = 'new' returning id`)).length > 0;
}

export type CalendarPlacement = { status: "approved" | "suggested"; targetDate?: string | null; targetTime?: string | null; notes?: string; source?: string };

/**
 * Turn a candidate into an editorial-calendar item (the same table and brief the calendar already uses, so the
 * Editorial Crew writes it like any other item). The candidate is marked scheduled. Returns null when the candidate
 * does not exist or was already used.
 */
export async function topicToCalendar(db: Db, id: string, place: CalendarPlacement = { status: "approved" }): Promise<{ calendarId: string; topic: StoredTopic } | null> {
  const [row] = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_topic_candidates where id = ${id} and status = 'new'`));
  if (!row) return null;
  const t = shape(row);
  const title = t.title.charAt(0).toUpperCase() + t.title.slice(1);
  const brief = {
    gap: t.reasons.slice(0, 2).join(" "),
    supportingQueries: t.queries.slice(0, 30),
    notes: place.notes ?? `From topic discovery (score ${t.score}/100). ${t.reasons.join(" ")}`.slice(0, 4000),
    source: place.source ?? "topic_discovery",
    topicId: t.id,
  };
  const evidence = t.signals.slice(0, 8).map((x) => ({ source: x.source, title: x.title, url: x.url, score: x.score, comments: x.comments }));
  const band = t.score >= 70 ? "high" : t.score >= 50 ? "medium" : "low";
  const [cal] = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into seo_editorial_calendar (fingerprint, title, status, kind, priority_score, priority_band, target_date, target_time, brief, evidence)
      values (${`topic:${t.key}`}, ${title}, ${place.status}, ${t.impressions > 0 ? "measured" : "editorial_idea"}, ${t.score}, ${band}, ${place.targetDate ?? null}::date, ${place.targetDate ? (place.targetTime ?? null) : null}::time, ${JSON.stringify(brief)}::jsonb, ${JSON.stringify(evidence)}::jsonb)
      on conflict (fingerprint) do nothing returning id`),
  );
  if (!cal) return null;
  await db.execute(sql`update seo_topic_candidates set status = 'scheduled', calendar_id = ${cal.id}::uuid, updated_at = now() where id = ${id}`);
  return { calendarId: cal.id, topic: t };
}
