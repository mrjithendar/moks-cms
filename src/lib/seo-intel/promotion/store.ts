import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { createItem, updateItem } from "../calendar";
import { contentGaps, parseKwParams } from "../keywords";
import { safeQueries } from "../llm";
import { siteOrigin } from "../urls";
import { band, CHANNELS, checkDraft, ideaFingerprint, matchThreads, promoLink, sameSubject, scoreChannels, type ArticleFacts, type Thread } from "./channels";
import { CHANNEL_IDS, enabledChannels, getPromotionSettings, type ChannelId, type PromotionSettings } from "./settings";

/**
 * Promotion data (docs/seo/PROMOTION.md): opportunities per published article and channel, their drafted posts, and
 * content ideas. The scoring is deterministic (channels.ts); the model only writes text, through the seo-agent's
 * Promotion Crew, and everything it writes waits here for a person. Nothing in this module posts anywhere.
 */
export class PromotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const asJson = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.startsWith("{") ? v.slice(1, -1).split(",").map((t) => t.replace(/^"|"$/g, "")).filter(Boolean) : []);
const iso = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);
const words = (body: string) => (body.replace(/```[\s\S]*?```/g, " ").match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
/** Plain-text opening of an article for the copywriter: no code blocks, no MDX/HTML tags, no images. */
export const excerptOf = (body: string, max = 1800) =>
  body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// --- Signals ------------------------------------------------------------------------------------------------------

async function recentThreads(db: Db, limit = 300): Promise<Thread[]> {
  return rowsOf<{ community: string; title: string; url: string; score: number; comments: number }>(
    await db.execute(sql`select community, title, url, score, comments from seo_promo_signals where source = 'reddit' and fetched_at > now() - interval '14 days' order by score desc limit ${limit}`),
  ).map((r) => ({ community: r.community, title: r.title, url: r.url, score: Number(r.score), comments: Number(r.comments) }));
}

async function topQueries(db: Db, pageUrl: string, limit = 8): Promise<string[]> {
  const rows = rowsOf<{ query: string }>(
    await db.execute(sql`
      select query from seo_gsc_query_daily
      where search_type = 'web' and page = ${pageUrl} and date > (select max(date) - 28 from seo_gsc_query_daily)
      group by query order by sum(impressions) desc limit ${limit}`),
  );
  return safeQueries(rows.map((r) => r.query));
}

// --- Opportunities ------------------------------------------------------------------------------------------------

type ArticleRow = { id: string; title: string; description: string; body: string; category: string; tags: unknown; content_type: string; published_at: unknown; path: string; clicks28d: number | null };

export type DraftTarget = { channel: ChannelId; label: string; score: number; link: string; guidance: string; maxChars: number; hasTitle: boolean; linkInBody: boolean; threads: { community: string; title: string; url: string }[] };
export type ArticleContext = { articleId: string; title: string; path: string; url: string; description: string; excerpt: string; topQueries: string[]; channels: DraftTarget[] };

/**
 * Score every enabled channel for the target articles and upsert the rows; returns what the Promotion Crew needs to
 * draft posts. With an article id: that article (published only), re-scored, drafts regenerated unless a person edited
 * them. Without: the newest published articles that have no opportunities yet (settings.articlesPerRun).
 */
export async function refreshOpportunities(opts: { articleId?: string; limit?: number } = {}, now = new Date()): Promise<{ enabled: boolean; articles: ArticleContext[] }> {
  const s = await getPromotionSettings();
  if (!s.enabled) return { enabled: false, articles: [] };
  if (opts.articleId && !UUID.test(opts.articleId)) throw new PromotionError("Invalid article id.", 400);
  const db = await getDb();
  const origin = siteOrigin();
  const limit = Math.min(10, Math.max(1, opts.limit ?? s.articlesPerRun));
  const scope = opts.articleId ? sql`p.id = ${opts.articleId}` : sql`not exists (select 1 from seo_promo_opportunities o where o.article_id = p.id)`;
  const rows = rowsOf<ArticleRow>(
    await db.execute(sql`
      select p.id, p.title, p.description, p.body, p.category, p.tags, p.content_type, p.published_at, '/' || p.collection || '/' || p.slug as path,
        (select sum(g.clicks)::float8 from seo_gsc_page_daily g
          where g.page = ${origin.origin}::text || '/' || p.collection || '/' || p.slug and g.search_type = 'web' and g.date > (select max(date) - 28 from seo_gsc_page_daily)) as clicks28d
      from post p where p.status = 'published' and p.deleted_at is null and p.noindex = false and ${scope}
      order by p.published_at desc nulls last limit ${limit}`),
  );
  if (opts.articleId && !rows.length) throw new PromotionError("Only published articles can be promoted.", 409);
  const threads = await recentThreads(db);
  const channels = enabledChannels(s);
  const out: ArticleContext[] = [];
  for (const r of rows) {
    const tags = asList(r.tags);
    const facts: ArticleFacts = { title: r.title, contentType: r.content_type, category: r.category, tags, words: words(r.body), publishedAt: iso(r.published_at), clicks28d: Number(r.clicks28d ?? 0) };
    const matched = matchThreads(facts, threads);
    const targets: DraftTarget[] = [];
    for (const sc of scoreChannels(facts, matched, channels, now)) {
      const c = CHANNELS[sc.channel];
      const link = promoLink(origin, r.path, sc.channel, s);
      const evidence = { words: facts.words, clicks28d: Math.round(facts.clicks28d), threads: sc.channel === "reddit" ? matched : [] };
      const [row] = rowsOf<{ status: string; edited_by: string | null }>(
        await db.execute(sql`
          insert into seo_promo_opportunities (article_id, channel, score, reasons, evidence, link)
          values (${r.id}::uuid, ${sc.channel}, ${sc.score}, ${JSON.stringify(sc.reasons)}::jsonb, ${JSON.stringify(evidence)}::jsonb, ${link})
          on conflict (article_id, channel) do update set score = excluded.score, reasons = excluded.reasons, evidence = excluded.evidence, link = excluded.link, updated_at = now()
          returning status, edited_by`),
      );
      // Draft only what scores high enough and no person has touched: open rows, and (for a re-run on one article)
      // machine drafts nobody edited. Posted and dismissed rows are never redrafted.
      const draftable = row && (row.status === "open" || (opts.articleId !== undefined && row.status === "drafted" && !row.edited_by));
      if (draftable && sc.score >= s.minScore) {
        targets.push({ channel: sc.channel, label: c.label, score: sc.score, link, guidance: c.guidance, maxChars: c.maxChars, hasTitle: c.hasTitle, linkInBody: c.linkInBody, threads: sc.channel === "reddit" ? matched.map((t) => ({ community: t.community, title: t.title, url: t.url })) : [] });
      }
    }
    out.push({ articleId: r.id, title: r.title, path: r.path, url: `${origin.origin}${r.path}`, description: r.description, excerpt: excerptOf(r.body), topQueries: await topQueries(db, `${origin.origin}${r.path}`), channels: targets });
  }
  return { enabled: true, articles: out };
}

export const draftsSchema = z.object({
  runId: z.string().max(80).nullish(),
  posts: z
    .array(
      z.object({
        channel: z.enum(CHANNEL_IDS),
        title: z.string().trim().max(300).nullish(),
        body: z.string().trim().min(1).max(4000),
        notes: z.string().trim().max(600).nullish(),
      }),
    )
    .max(CHANNEL_IDS.length),
});

/** Store the crew's drafts for one article. A row a person edited, posted or dismissed is left alone. */
export async function saveDrafts(articleId: string, input: z.output<typeof draftsSchema>): Promise<{ saved: number; skipped: number }> {
  if (!UUID.test(articleId)) throw new PromotionError("Invalid article id.", 400);
  const db = await getDb();
  const origin = siteOrigin();
  const rows = rowsOf<{ id: string; channel: string; status: string; link: string; evidence: unknown; edited_by: string | null }>(await db.execute(sql`select id, channel, status, link, evidence, edited_by from seo_promo_opportunities where article_id = ${articleId}`));
  let saved = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const p of input.posts) {
    const row = rows.find((r) => r.channel === p.channel);
    if (!row || seen.has(p.channel) || !["open", "drafted"].includes(row.status) || row.edited_by) {
      skipped++;
      continue;
    }
    seen.add(p.channel);
    const allowed = asJson<{ threads?: Thread[] }>(row.evidence, {}).threads?.map((t) => t.url) ?? [];
    const title = CHANNELS[p.channel].hasTitle ? (p.title ?? "").trim() || null : null;
    const flags = checkDraft(p.channel, { title, body: p.body }, row.link, origin, allowed);
    await db.execute(sql`
      update seo_promo_opportunities set status = 'drafted', draft_title = ${title}, draft_body = ${p.body}, draft_notes = ${p.notes ?? null},
        draft_flags = ${JSON.stringify(flags)}::jsonb, draft_source = 'crew', run_id = ${input.runId ?? null}, updated_at = now()
      where id = ${row.id}`);
    saved++;
  }
  return { saved, skipped };
}

export type Opportunity = {
  id: string;
  channel: ChannelId;
  label: string;
  postUrl: string | null;
  guidance: string;
  maxChars: number;
  hasTitle: boolean;
  score: number;
  band: "high" | "medium" | "low";
  reasons: string[];
  threads: Thread[];
  link: string;
  status: "open" | "drafted" | "posted" | "dismissed";
  draftTitle: string | null;
  draftBody: string | null;
  draftNotes: string | null;
  flags: string[];
  editedBy: string | null;
  postedUrl: string | null;
  postedAt: string | null;
  updatedAt: string | null;
};
export type PromotedArticle = { articleId: string; title: string; path: string; publishedAt: string | null; opportunities: Opportunity[] };

const isChannel = (c: string): c is ChannelId => (CHANNEL_IDS as readonly string[]).includes(c);

function shapeOpportunity(r: Record<string, unknown>): Opportunity | null {
  const channel = String(r.channel);
  if (!isChannel(channel)) return null;
  const c = CHANNELS[channel];
  const score = Number(r.score);
  return {
    id: String(r.id),
    channel,
    label: c.label,
    postUrl: c.postUrl,
    guidance: c.guidance,
    maxChars: c.maxChars,
    hasTitle: c.hasTitle,
    score,
    band: band(score),
    reasons: asJson<string[]>(r.reasons, []),
    threads: asJson<{ threads?: Thread[] }>(r.evidence, {}).threads ?? [],
    link: String(r.link),
    status: String(r.status) as Opportunity["status"],
    draftTitle: (r.draft_title as string | null) ?? null,
    draftBody: (r.draft_body as string | null) ?? null,
    draftNotes: (r.draft_notes as string | null) ?? null,
    flags: asJson<string[]>(r.draft_flags, []),
    editedBy: (r.edited_by as string | null) ?? null,
    postedUrl: (r.posted_url as string | null) ?? null,
    postedAt: iso(r.posted_at),
    updatedAt: iso(r.updated_at),
  };
}

export const OPPORTUNITY_STATUSES = ["open", "drafted", "posted", "dismissed"] as const;

/** Opportunities grouped by article (newest article first, best channel first). */
export async function listOpportunities(opts: { status?: string; articleId?: string } = {}): Promise<PromotedArticle[]> {
  const db = await getDb();
  const parts = [sql`p.deleted_at is null`];
  if (opts.status && (OPPORTUNITY_STATUSES as readonly string[]).includes(opts.status)) parts.push(sql`o.status = ${opts.status}`);
  if (opts.articleId && UUID.test(opts.articleId)) parts.push(sql`o.article_id = ${opts.articleId}`);
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select o.*, p.title as article_title, '/' || p.collection || '/' || p.slug as article_path, p.published_at as article_published_at
      from seo_promo_opportunities o join post p on p.id = o.article_id
      where ${sql.join(parts, sql` and `)}
      order by p.published_at desc nulls last, o.article_id, o.score desc, o.channel limit 600`),
  );
  const by = new Map<string, PromotedArticle>();
  for (const r of rows) {
    const o = shapeOpportunity(r);
    if (!o) continue;
    const id = String(r.article_id);
    const a = by.get(id) ?? { articleId: id, title: String(r.article_title), path: String(r.article_path), publishedAt: iso(r.article_published_at), opportunities: [] };
    a.opportunities.push(o);
    by.set(id, a);
  }
  return [...by.values()];
}

export const opportunityPatch = z
  .object({
    action: z.enum(["save", "posted", "dismiss", "reopen"]),
    title: z.string().trim().max(300).nullish(),
    body: z.string().trim().min(1).max(4000).optional(),
    postedUrl: z.union([z.string().trim().url().max(500).regex(/^https:\/\//, "Use an https URL"), z.literal(""), z.null()]).optional(),
  })
  .strict();

/** A person's decision on one opportunity: edit the draft, record that it was posted, dismiss it or reopen it. */
export async function updateOpportunity(id: string, patch: z.output<typeof opportunityPatch>, actorLabel: string) {
  if (!UUID.test(id)) throw new PromotionError("Opportunity not found.", 404);
  const db = await getDb();
  const [cur] = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_promo_opportunities where id = ${id}`));
  if (!cur) throw new PromotionError("Opportunity not found.", 404);
  const channel = String(cur.channel);
  if (!isChannel(channel)) throw new PromotionError("Unknown channel.", 409);
  const status = String(cur.status);
  const before = { status, title: cur.draft_title ?? null, postedUrl: cur.posted_url ?? null };
  if (patch.action === "save") {
    if (!patch.body) throw new PromotionError("Write the post text first.", 400);
    if (status === "posted") throw new PromotionError("This post is recorded as posted. Reopen it to edit.", 409);
    const title = CHANNELS[channel].hasTitle ? (patch.title ?? "").trim() || null : null;
    const allowed = asJson<{ threads?: Thread[] }>(cur.evidence, {}).threads?.map((t) => t.url) ?? [];
    const flags = checkDraft(channel, { title, body: patch.body }, String(cur.link), siteOrigin(), allowed);
    await db.execute(sql`
      update seo_promo_opportunities set status = 'drafted', draft_title = ${title}, draft_body = ${patch.body}, draft_flags = ${JSON.stringify(flags)}::jsonb,
        draft_source = coalesce(draft_source, 'manual'), edited_by = ${actorLabel.slice(0, 200)}, updated_at = now()
      where id = ${id}`);
    return { before, after: { status: "drafted", title, flags } };
  }
  if (patch.action === "posted") {
    if (status === "dismissed") throw new PromotionError("Reopen this opportunity first.", 409);
    await db.execute(sql`update seo_promo_opportunities set status = 'posted', posted_at = now(), posted_url = ${patch.postedUrl || null}, updated_at = now() where id = ${id}`);
    return { before, after: { status: "posted", postedUrl: patch.postedUrl || null } };
  }
  if (patch.action === "dismiss") {
    await db.execute(sql`update seo_promo_opportunities set status = 'dismissed', updated_at = now() where id = ${id}`);
    return { before, after: { status: "dismissed" } };
  }
  const next = cur.draft_body ? "drafted" : "open";
  await db.execute(sql`update seo_promo_opportunities set status = ${next}, posted_at = null, posted_url = null, updated_at = now() where id = ${id}`);
  return { before, after: { status: next } };
}

// --- Content ideas ------------------------------------------------------------------------------------------------

type GscTopic = { topic: string; impressions: number; bestPosition: number | null; queries: string[] };
type GscQuery = { query: string; impressions: number; position: number | null };
type SignalData = { topics: GscTopic[]; queries: GscQuery[]; threads: Thread[]; covered: string[]; planned: string[] };

async function signalData(db: Db): Promise<SignalData> {
  const gaps = await contentGaps(parseKwParams({ view: "gaps", limit: "15" }));
  const topics = gaps
    .map((g) => ({ topic: g.parentTopic, impressions: Math.round(g.impressions), bestPosition: g.bestPosition === null ? null : Number(g.bestPosition.toFixed(1)), queries: safeQueries(g.topQueries) }))
    .filter((g) => safeQueries([g.topic]).length === 1);
  // Page-two queries: real impressions, average position 8–30. A dedicated article could move them onto page one.
  const q = rowsOf<{ query: string; impressions: number; position: number | null }>(
    await db.execute(sql`
      select query, impressions, position from (
        select query, sum(impressions)::float8 as impressions,
          sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
        from seo_gsc_query_daily where search_type = 'web' and date > (select max(date) - 28 from seo_gsc_query_daily)
        group by query) x
      where impressions >= 30 and position between 8 and 30
      order by impressions desc limit 60`),
  );
  const keep = new Set(safeQueries(q.map((r) => r.query)));
  const queries = q.filter((r) => keep.has(r.query)).slice(0, 40).map((r) => ({ query: r.query, impressions: Math.round(Number(r.impressions)), position: r.position === null ? null : Number(Number(r.position).toFixed(1)) }));
  const threads = (await recentThreads(db, 40)).filter((t) => t.score > 0);
  const covered = rowsOf<{ title: string }>(await db.execute(sql`select title from post where status = 'published' and deleted_at is null order by published_at desc nulls last limit 300`)).map((r) => r.title);
  const planned = [
    ...rowsOf<{ title: string }>(await db.execute(sql`select title from seo_editorial_calendar where status <> 'dropped' order by created_at desc limit 200`)),
    ...rowsOf<{ title: string }>(await db.execute(sql`select title from seo_content_ideas order by created_at desc limit 300`)),
  ].map((r) => r.title);
  return { topics, queries, threads, covered, planned };
}

/** Everything the strategist may use, and nothing else: Search Console demand, fetched Reddit threads, what exists. */
export async function ideaSignals() {
  const s = await getPromotionSettings();
  if (!s.enabled) return { enabled: false as const };
  const d = await signalData(await getDb());
  return {
    enabled: true as const,
    max: s.ideasPerRun,
    channels: enabledChannels(s).map((c) => ({ id: c, label: CHANNELS[c].label })),
    gsc: { topics: d.topics, queries: d.queries },
    reddit: d.threads.map((t) => ({ community: t.community, title: t.title, url: t.url, score: t.score, comments: t.comments })),
    covered: d.covered.slice(0, 200),
    planned: d.planned.slice(0, 200),
  };
}

export const ideasSchema = z.object({
  runId: z.string().max(80).nullish(),
  ideas: z
    .array(
      z.object({
        title: z.string().trim().min(10).max(160),
        angle: z.string().trim().max(600).default(""),
        outline: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
        target_query: z.string().trim().max(120).nullish(),
        channels: z.array(z.string().trim().max(40)).max(8).default([]),
        evidence: z.array(z.object({ type: z.enum(["gsc_query", "gsc_topic", "reddit"]), value: z.string().trim().min(1).max(500) })).max(12).default([]),
      }),
    )
    .max(20),
});

export type IdeaSignal = { type: "gsc_query" | "gsc_topic" | "reddit"; label: string; url?: string; impressions?: number; position?: number | null; score?: number; comments?: number };

/** 0–100 from verified evidence only: search demand (impressions), community interest (threads, upvotes), both = bonus. */
export function ideaScore(signals: IdeaSignal[]): number {
  const impressions = signals.filter((s) => s.type !== "reddit").reduce((n, s) => n + (s.impressions ?? 0), 0);
  const threads = signals.filter((s) => s.type === "reddit");
  const upvotes = threads.reduce((n, s) => n + (s.score ?? 0), 0);
  const search = Math.min(40, impressions / 25);
  const community = Math.min(30, threads.length * 10 + upvotes / 50);
  return Math.round(Math.min(100, 20 + search + community + (search > 0 && community > 0 ? 10 : 0)));
}

/**
 * Store the strategist's ideas. Each piece of evidence is checked against the data the site holds (a Search Console
 * query or topic from the signals, a Reddit thread that was fetched); anything else is dropped, and an idea with no
 * verified evidence is not stored. Ideas the site already covers, has planned, or the owner dismissed are skipped.
 */
export async function saveIdeas(input: z.output<typeof ideasSchema>): Promise<{ saved: number; skipped: { title: string; reason: string }[] }> {
  const db = await getDb();
  const d = await signalData(db);
  const topics = new Map<string, GscTopic>(d.topics.map((t) => [t.topic.toLowerCase(), t]));
  const queries = new Map<string, { impressions: number; position: number | null }>(d.queries.map((q) => [q.query.toLowerCase(), q]));
  for (const t of d.topics) for (const q of t.queries) if (!queries.has(q.toLowerCase())) queries.set(q.toLowerCase(), { impressions: 0, position: t.bestPosition });
  const threads = new Map<string, Thread>(d.threads.map((t) => [t.url, t]));
  const skipped: { title: string; reason: string }[] = [];
  let saved = 0;
  for (const idea of input.ideas) {
    const fp = ideaFingerprint(idea.title);
    if (!fp) {
      skipped.push({ title: idea.title, reason: "empty title" });
      continue;
    }
    const signals: IdeaSignal[] = [];
    const seen = new Set<string>();
    for (const e of idea.evidence) {
      const key = `${e.type}:${e.value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (e.type === "reddit") {
        const t = threads.get(e.value);
        if (t) signals.push({ type: "reddit", label: `r/${t.community}: ${t.title}`, url: t.url, score: t.score, comments: t.comments });
      } else if (e.type === "gsc_topic") {
        const t = topics.get(e.value.toLowerCase());
        if (t) signals.push({ type: "gsc_topic", label: t.topic, impressions: t.impressions, position: t.bestPosition });
      } else {
        const q = queries.get(e.value.toLowerCase());
        if (q) signals.push({ type: "gsc_query", label: e.value.toLowerCase(), impressions: q.impressions, position: q.position });
      }
    }
    if (!signals.length) {
      skipped.push({ title: idea.title, reason: "no verified evidence" });
      continue;
    }
    if (d.covered.some((t) => sameSubject(t, idea.title))) {
      skipped.push({ title: idea.title, reason: "already published" });
      continue;
    }
    if (d.planned.some((t) => sameSubject(t, idea.title, 0.75))) {
      skipped.push({ title: idea.title, reason: "already planned or suggested" });
      continue;
    }
    const channels = idea.channels.filter(isChannel);
    const targetQuery = idea.target_query && queries.has(idea.target_query.toLowerCase()) ? idea.target_query.toLowerCase() : null;
    const source = signals.some((s) => s.type === "reddit") ? (signals.some((s) => s.type !== "reddit") ? "mixed" : "reddit") : "gsc";
    const inserted = rowsOf<{ id: string }>(
      await db.execute(sql`
        insert into seo_content_ideas (fingerprint, title, angle, outline, target_query, channels, signals, score, source, run_id)
        values (${fp}, ${idea.title}, ${idea.angle}, ${JSON.stringify(idea.outline)}::jsonb, ${targetQuery}, ${JSON.stringify(channels)}::jsonb, ${JSON.stringify(signals)}::jsonb, ${ideaScore(signals)}, ${source}, ${input.runId ?? null})
        on conflict (fingerprint) do nothing returning id`),
    );
    if (inserted.length) {
      saved++;
      d.planned.push(idea.title);
    } else skipped.push({ title: idea.title, reason: "already suggested" });
  }
  return { saved, skipped };
}

export const IDEA_STATUSES = ["new", "saved", "dismissed", "sent"] as const;
export type Idea = { id: string; title: string; angle: string; outline: string[]; targetQuery: string | null; channels: { id: ChannelId; label: string }[]; signals: IdeaSignal[]; score: number; band: "high" | "medium" | "low"; source: string; status: (typeof IDEA_STATUSES)[number]; calendarId: string | null; createdAt: string | null };

export async function listIdeas(opts: { status?: string } = {}): Promise<Idea[]> {
  const db = await getDb();
  const where = opts.status && (IDEA_STATUSES as readonly string[]).includes(opts.status) ? sql`status = ${opts.status}` : sql`status in ('new', 'saved')`;
  return rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_content_ideas where ${where} order by score desc, created_at desc limit 200`)).map((r) => {
    const score = Number(r.score);
    return {
      id: String(r.id),
      title: String(r.title),
      angle: String(r.angle ?? ""),
      outline: asJson<string[]>(r.outline, []),
      targetQuery: (r.target_query as string | null) ?? null,
      channels: asJson<string[]>(r.channels, []).filter(isChannel).map((c) => ({ id: c, label: CHANNELS[c].label })),
      signals: asJson<IdeaSignal[]>(r.signals, []),
      score,
      band: band(score),
      source: String(r.source),
      status: String(r.status) as Idea["status"],
      calendarId: (r.calendar_id as string | null) ?? null,
      createdAt: iso(r.created_at),
    };
  });
}

export const ideaPatch = z.object({ action: z.enum(["calendar", "save", "dismiss", "restore"]) }).strict();

/**
 * calendar: the idea becomes an approved item on the editorial calendar with its brief (angle, outline, queries), where
 * the existing flow takes over (schedule it → draft post → Editorial Crew → review queue). save / dismiss / restore
 * only change its status here. A dismissed idea keeps its fingerprint, so it is not suggested again.
 */
export async function updateIdea(id: string, action: z.output<typeof ideaPatch>["action"]): Promise<{ status: string; calendarId?: string }> {
  if (!UUID.test(id)) throw new PromotionError("Idea not found.", 404);
  const db = await getDb();
  const [cur] = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_content_ideas where id = ${id}`));
  if (!cur) throw new PromotionError("Idea not found.", 404);
  if (action !== "calendar") {
    if (String(cur.status) === "sent") throw new PromotionError("This idea is already on the editorial calendar.", 409);
    const status = action === "save" ? "saved" : action === "dismiss" ? "dismissed" : "new";
    await db.execute(sql`update seo_content_ideas set status = ${status}, updated_at = now() where id = ${id}`);
    return { status };
  }
  if (cur.calendar_id) return { status: "sent", calendarId: String(cur.calendar_id) };
  const signals = asJson<IdeaSignal[]>(cur.signals, []);
  const outline = asJson<string[]>(cur.outline, []).map((h) => h.slice(0, 200)).filter(Boolean).slice(0, 30);
  const supportingQueries = [...new Set([cur.target_query as string | null, ...signals.filter((s) => s.type !== "reddit").map((s) => s.label)].filter((q): q is string => Boolean(q)))].map((q) => q.slice(0, 200)).slice(0, 30);
  const notes = ["Content idea from Promotion (suggested because it has an audience to promote to).", ...signals.map((s) => `- ${s.type === "reddit" ? `Reddit thread (${s.score ?? 0} upvotes): ${s.label} ${s.url ?? ""}` : `Search Console ${s.type === "gsc_topic" ? "topic" : "query"}: ${s.label} (${s.impressions ?? 0} impressions, 28 days)`}`)].join("\n").slice(0, 2000);
  const calendarId = await createItem({ title: String(cur.title).slice(0, 200), notes });
  await updateItem(calendarId, { brief: { gap: String(cur.angle ?? "").slice(0, 1000), outline, supportingQueries } });
  await db.execute(sql`update seo_content_ideas set status = 'sent', calendar_id = ${calendarId}, updated_at = now() where id = ${id}`);
  return { status: "sent", calendarId };
}

// --- Overview -----------------------------------------------------------------------------------------------------

export async function promotionCounts(): Promise<{ open: number; drafted: number; posted: number; dismissed: number; ideas: number }> {
  const db = await getDb();
  const rows = rowsOf<{ status: string; n: number }>(await db.execute(sql`select o.status, count(*)::int as n from seo_promo_opportunities o join post p on p.id = o.article_id where p.deleted_at is null group by o.status`));
  const [i] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_content_ideas where status in ('new', 'saved')`));
  const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { open: n("open"), drafted: n("drafted"), posted: n("posted"), dismissed: n("dismissed"), ideas: Number(i?.n ?? 0) };
}

export type { PromotionSettings };
