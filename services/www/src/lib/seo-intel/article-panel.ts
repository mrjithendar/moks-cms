import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { recordSeoContentAudit } from "../metrics";
import { auditArticle } from "./audit-article";
import { loadAnalysisData, loadArticles } from "./data";
import { listOptimizations } from "./optimize";
import { listRecommendations } from "./recommendations";
import { addDays } from "./sqlutil";

/**
 * Everything the article SEO panel shows: Search Console + GA4 performance (separately labelled), ranking queries,
 * current metadata, heading analysis and audit findings, internal-link suggestions, recommendations and proposals.
 * Each audit run is stored in seo_content_audits (only when the content changed since the last stored audit).
 */
export async function articlePanel(id: string, now = new Date()) {
  const db = await getDb();
  const article = (await loadArticles(db, { includeDrafts: true })).find((a) => a.id === id);
  if (!article) return null;
  const data = await loadAnalysisData(db);
  const [latest] = rowsOf<{ d: string | null }>(await db.execute(sql`select max(date)::text as d from seo_gsc_page_daily`));
  const end = latest?.d ?? now.toISOString().slice(0, 10);
  const start = addDays(end, -27);
  const queries = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select query, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
        sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
      from seo_gsc_query_daily where page = ${article.url} and search_type = 'web' and date between ${start} and ${end}
      group by query order by impressions desc limit 25`),
  ).map((r) => ({ query: String(r.query), clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.impressions) ? Number(r.clicks) / Number(r.impressions) : 0, position: r.position === null ? null : Number(r.position) }));
  const gscTrend = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select date::text as date, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions from seo_gsc_page_daily where page = ${article.url} and search_type = 'web' and date between ${addDays(end, -89)} and ${end} group by date order by date`),
  ).map((r) => ({ date: String(r.date), clicks: Number(r.clicks), impressions: Number(r.impressions) }));
  const [ga] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select sum(sessions)::float8 as sessions, sum(sessions) filter (where channel_group = 'Organic Search')::float8 as organic, sum(engaged_sessions)::float8 as engaged, sum(user_engagement_duration)::float8 as duration
      from seo_ga4_page_daily where landing_page = ${article.url} and date between ${start} and ${end}`),
  );
  const audit = auditArticle(article, { knownPaths: data.knownPaths, now, topQueries: queries.map((q) => q.query) });
  const [last] = rowsOf<{ content_hash: string }>(await db.execute(sql`select content_hash from seo_content_audits where article_id = ${id} order by audited_at desc limit 1`));
  if (last?.content_hash !== audit.contentHash) {
    await db.execute(sql`insert into seo_content_audits (article_id, content_hash, score, findings) values (${id}, ${audit.contentHash}, ${audit.score}, ${JSON.stringify(audit.findings)}::jsonb)`);
    recordSeoContentAudit();
  }
  const links = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select t.id, t.title, t.collection, t.slug, l.reason, l.score from seo_internal_link_suggestions l join post t on t.id = l.target_article_id where l.source_article_id = ${id} and l.status = 'suggested' order by l.score desc limit 10`),
  ).map((r) => ({ id: String(r.id), title: String(r.title), path: `/${r.collection}/${r.slug}`, reason: String(r.reason), score: Number(r.score) }));
  const sessions = Number(ga?.sessions ?? 0);
  const gscTotals = queries.length || gscTrend.length ? data.pages.get(article.url)?.cur ?? null : null;
  return {
    article: { id: article.id, body: article.body, title: article.title, path: article.path, url: article.url, status: article.status, category: article.category, tags: article.tags, contentType: article.contentType, seoTitle: article.seoTitle, seoDescription: article.seoDescription, description: article.description, publishedAt: article.publishedAt?.toISOString() ?? null, updatedAt: article.updatedAt?.toISOString() ?? null, noindex: article.noindex, canonicalUrl: article.canonicalUrl, featuredImage: article.featuredImage },
    period: { start, end },
    gsc: gscTotals,
    gscTrend,
    ga4: { sessions, organic: Number(ga?.organic ?? 0), engagementRate: sessions ? Number(ga?.engaged ?? 0) / sessions : null, avgEngagementSeconds: sessions ? Number(ga?.duration ?? 0) / sessions : null },
    queries,
    audit,
    structuredData: [
      { check: "headline ≤ 110 characters", ok: article.title.length <= 110 },
      { check: "image (cover) present", ok: Boolean(article.featuredImage) },
      { check: "datePublished present", ok: Boolean(article.publishedAt) || article.status !== "published" },
      { check: "dateModified ≥ datePublished", ok: !article.updatedAt || !article.publishedAt || article.updatedAt >= article.publishedAt },
      { check: "description present", ok: article.description.trim().length > 0 },
    ],
    links,
    recommendations: (await listRecommendations({ status: "all", articleId: id, limit: 50 })).rows,
    optimizations: await listOptimizations(id),
  };
}
