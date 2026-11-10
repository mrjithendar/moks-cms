import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { auditArticle } from "./audit-article";
import { loadAnalysisData } from "./data";
<<<<<<< HEAD
import { metricCounts } from "./issue-details";
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd

/** Content optimisation overview: every published article with its current audit score (computed live, no I/O beyond reads). */
export async function contentOverview(now = new Date()) {
  const db = await getDb();
  const d = await loadAnalysisData(db);
  const recs = rowsOf<{ article_id: string; n: number }>(await db.execute(sql`select article_id, count(*)::int as n from seo_recommendations where review_status = 'pending' and article_id is not null group by article_id`));
  const recBy = new Map(recs.map((r) => [r.article_id, Number(r.n)]));
  return d.articles
    .map((a) => {
      const audit = auditArticle(a, { knownPaths: d.knownPaths, now });
      const m = d.pages.get(a.url);
      return {
        id: a.id,
        title: a.title,
        path: a.path,
        category: a.category,
<<<<<<< HEAD
        collection: a.collection,
        run: audit.contentHash,
        counts: metricCounts(audit, a.body),
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
        score: audit.score,
        errors: audit.findings.filter((f) => f.severity === "error").length,
        warnings: audit.findings.filter((f) => f.severity === "warning").length,
        clicks: m?.cur.clicks ?? null,
        impressions: m?.cur.impressions ?? null,
        pendingRecommendations: recBy.get(a.id) ?? 0,
        updatedAt: (a.updatedAt ?? a.publishedAt)?.toISOString() ?? null,
      };
    })
    .sort((x, y) => x.score - y.score);
}

export async function linkSuggestions(status = "suggested") {
  const db = await getDb();
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select l.id, l.source_article_id, s.title as source_title, s.collection as sc, s.slug as ss, l.target_article_id, t.title as target_title, t.collection as tc, t.slug as ts,
        l.anchor_text, l.reason, l.score, l.status
      from seo_internal_link_suggestions l join post s on s.id = l.source_article_id join post t on t.id = l.target_article_id
      where l.status = ${status} order by l.score desc limit 300`),
  );
  return rows.map((r) => ({
    id: String(r.id),
    sourceId: String(r.source_article_id),
    sourceTitle: String(r.source_title),
    sourcePath: `/${r.sc}/${r.ss}`,
    targetId: String(r.target_article_id),
    targetTitle: String(r.target_title),
    targetPath: `/${r.tc}/${r.ts}`,
    anchor: String(r.anchor_text),
    reason: String(r.reason),
    score: Number(r.score),
    status: String(r.status),
  }));
}
