import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/palette?q= — articles and Search Console queries for the ⌘K palette (top 8 each). */
export const GET = seoRoute("palette", { rate: { max: 240, windowSeconds: 60 } }, async (_req, ctx) => {
  const q = (ctx.query.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return json([]);
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const db = await getDb();
  const articles = rowsOf<{ id: string; title: string; collection: string; slug: string }>(await db.execute(sql`select id, title, collection, slug from post where deleted_at is null and (title ilike ${like} or slug ilike ${like}) order by saved_at desc limit 8`));
  const queries = rowsOf<{ query: string }>(await db.execute(sql`select query from seo_gsc_query_daily where search_type = 'web' and query ilike ${like} and date > (select max(date) - 28 from seo_gsc_query_daily) group by query order by sum(impressions) desc limit 8`));
  return json([
    ...articles.map((a) => ({ label: a.title, hint: `/${a.collection}/${a.slug}`, href: `/admin/seo/articles/${a.id}`, group: "Article" })),
    ...queries.map((r) => ({ label: r.query, hint: "Search Console query", href: `/admin/seo/keywords?q=${encodeURIComponent(r.query)}`, group: "Keyword" })),
  ]);
});
