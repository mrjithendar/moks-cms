import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { AuditInput } from "./audit-article";
import { decaySignals, mlDecision, type DecaySignal, type MlDecision } from "./ml";
import { addDays } from "./sqlutil";
import { siteOrigin } from "./urls";

/**
 * Everything the recommendation rules read, loaded once per analysis run. Search Console "web" data only (the
 * rules reason about classic search results). Periods: the latest 28 days with data, the 28 days before, and the
 * same 28 days a year earlier (year-over-year, when that history exists).
 */
export type Metric = { clicks: number; impressions: number; position: number | null };
export type Article = AuditInput & { url: string; path: string; status: string };

export type AnalysisData = {
  asOf: string | null;
  periods: { cur: [string, string]; prev: [string, string]; yoy: [string, string] } | null;
  pageQuery: { page: string; query: string; clicks: number; impressions: number; position: number | null }[];
  pages: Map<string, { cur: Metric; prev: Metric | null; yoy: Metric | null }>;
  yoyAvailable: boolean;
  articles: Article[];
  articleByUrl: Map<string, Article>;
  knownPaths: Set<string>;
  /** v5 ML outputs the rules may use (ml.ts decides model vs rule); absent = rules only. */
  ml?: { decay: { decision: MlDecision; signals: Map<string, DecaySignal> } };
};

const metric = (r: Record<string, unknown> | undefined): Metric | null =>
  r ? { clicks: Number(r.clicks ?? 0), impressions: Number(r.impressions ?? 0), position: r.position === null || r.position === undefined ? null : Number(r.position) } : null;

export async function loadArticles(db: Db, opts: { includeDrafts?: boolean } = {}): Promise<Article[]> {
  const origin = siteOrigin();
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select id, collection, slug, title, description, body, category, tags, content_type, seo_title, seo_description, featured_image,
        published_at, updated_at, noindex, canonical_url, status
      from post where deleted_at is null ${opts.includeDrafts ? sql`` : sql`and status = 'published'`}`),
  );
  return rows.map((r) => {
    const path = `/${r.collection}/${r.slug}`;
    return {
      id: String(r.id),
      collection: String(r.collection),
      slug: String(r.slug),
      title: String(r.title),
      description: String(r.description),
      body: String(r.body ?? ""),
      category: String(r.category),
      tags: (r.tags as string[] | null) ?? [],
      contentType: String(r.content_type),
      seoTitle: (r.seo_title as string | null) ?? null,
      seoDescription: (r.seo_description as string | null) ?? null,
      featuredImage: (r.featured_image as { src: string; alt: string } | null) ?? null,
      publishedAt: r.published_at ? new Date(String(r.published_at)) : null,
      updatedAt: r.updated_at ? new Date(String(r.updated_at)) : null,
      noindex: Boolean(r.noindex),
      canonicalUrl: (r.canonical_url as string | null) ?? null,
      status: String(r.status),
      path,
      url: `${origin.protocol}//${origin.host}${path}`,
    };
  });
}

export async function loadAnalysisData(db: Db): Promise<AnalysisData> {
  const articles = await loadArticles(db);
  const articleByUrl = new Map(articles.map((a) => [a.url, a]));
  const knownPaths = new Set<string>(["/", "/blog", "/news", "/projects", "/search", "/about", ...articles.map((a) => a.path)]);
  const cats = rowsOf<{ slug: string }>(await db.execute(sql`select slug from category`));
  for (const c of cats) knownPaths.add(`/category/${c.slug}`);
  const pagesRows = rowsOf<{ slug: string }>(await db.execute(sql`select slug from page where deleted_at is null`));
  for (const p of pagesRows) knownPaths.add(`/${p.slug}`);

  const [latest] = rowsOf<{ d: string | null }>(await db.execute(sql`select max(date)::text as d from seo_gsc_daily_totals where search_type = 'web'`));
  const asOf = latest?.d ?? null;
  if (!asOf) return { asOf, periods: null, pageQuery: [], pages: new Map(), yoyAvailable: false, articles, articleByUrl, knownPaths };
  const cur: [string, string] = [addDays(asOf, -27), asOf];
  const prev: [string, string] = [addDays(asOf, -55), addDays(asOf, -28)];
  const yoy: [string, string] = [addDays(asOf, -27 - 364), addDays(asOf, -364)];

  const agg = (range: [string, string]) => sql`
    select page, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
      sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
    from seo_gsc_page_daily where search_type = 'web' and date between ${range[0]} and ${range[1]} group by page`;
  const [c, p, y] = await Promise.all([agg(cur), agg(prev), agg(yoy)].map(async (q) => rowsOf<Record<string, unknown>>(await db.execute(q))));
  const [yoyCount] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_gsc_daily_totals where search_type = 'web' and date between ${yoy[0]} and ${yoy[1]}`));
  const yoyAvailable = Number(yoyCount?.n ?? 0) >= 20;
  const pages = new Map<string, { cur: Metric; prev: Metric | null; yoy: Metric | null }>();
  const prevBy = new Map(p!.map((r) => [String(r.page), r]));
  const yoyBy = new Map(y!.map((r) => [String(r.page), r]));
  for (const r of c!) pages.set(String(r.page), { cur: metric(r)!, prev: metric(prevBy.get(String(r.page))), yoy: yoyAvailable ? metric(yoyBy.get(String(r.page))) : null });
  // Pages that had clicks before but none now (fully decayed) still need evaluating.
  for (const r of p!) if (!pages.has(String(r.page))) pages.set(String(r.page), { cur: { clicks: 0, impressions: 0, position: null }, prev: metric(r), yoy: yoyAvailable ? metric(yoyBy.get(String(r.page))) : null });

  const pq = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select page, query, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
        sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
      from seo_gsc_query_daily where search_type = 'web' and date between ${cur[0]} and ${cur[1]} group by page, query`),
  );
  const decision = await mlDecision(db, "decay");
  const ml = { decay: { decision, signals: decision.mode === "model" ? await decaySignals(db) : new Map<string, DecaySignal>() } };
  return {
    asOf,
    ml,
    periods: { cur, prev, yoy },
    pageQuery: pq.map((r) => ({ page: String(r.page), query: String(r.query), clicks: Number(r.clicks), impressions: Number(r.impressions), position: r.position === null ? null : Number(r.position) })),
    pages,
    yoyAvailable,
    articles,
    articleByUrl,
    knownPaths,
  };
}
