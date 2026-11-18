import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import type { ExtraTask } from "./drafts";

/**
 * The review queue's "Not reviewed" list and "Rescan" (owner request 2026-11-18: "user can rescan all for re-review,
 * and see what is not listed in review").
 *
 * - An article is **not reviewed** when it is published (blog or projects; news is time-bound and has its own desk),
 *   has no open draft, and either was never reviewed or its last review ended (published, rejected, rolled back or
 *   superseded) more than `staleDays` ago.
 * - **Rescan** asks for a fresh optimisation draft of each chosen article through the normal path (requestDraft:
 *   the SEO agent, or the legacy Claude job), with two general tasks so an article without open recommendations is
 *   reviewed too. At most RESCAN_MAX articles per request: each one is a model run with a cost. Drafts land in the
 *   queue as usual; nothing is published without a person's approval.
 */
export const RESCAN_MAX = 25;
export const DEFAULT_STALE_DAYS = 90;

export const RESCAN_TASKS: ExtraTask[] = [
  { id: "rescan-freshness", category: "freshness", problem: "Re-review the article: check that commands, flags, versions, links and facts are still current and correct, and fix what is outdated or wrong." },
  { id: "rescan-title-meta", category: "title_meta", problem: "Re-review the title and meta description: they must match what the article delivers and what readers search for." },
];

export type Unreviewed = { articleId: string; title: string; path: string; collection: string; publishedAt: string | null; lastReviewedAt: string | null; lastOutcome: string | null; openRecommendations: number };

export async function unreviewedArticles(opts: { staleDays?: number; q?: string; limit?: number } = {}): Promise<Unreviewed[]> {
  const db = await getDb();
  const stale = Math.max(1, Math.min(3650, Math.round(opts.staleDays ?? DEFAULT_STALE_DAYS)));
  const q = (opts.q ?? "").trim().slice(0, 100);
  const rows = rowsOf<{ id: string; title: string; collection: string; slug: string; published_at: string | null; last_at: string | null; last_status: string | null; recs: number }>(
    await db.execute(sql`
      select p.id, p.title, p.collection, p.slug, p.published_at, last.at as last_at, last.status as last_status,
        (select count(*)::int from seo_recommendations r where r.article_id = p.id and r.review_status in ('pending', 'approved') and r.implementation_status <> 'done') as recs
      from post p
      left join lateral (
        select greatest(d.decided_at, d.updated_at) as at, d.status from seo_drafts d
        where d.article_id = p.id and d.status in ('published', 'rejected', 'rolled_back', 'superseded')
        order by greatest(d.decided_at, d.updated_at) desc nulls last limit 1
      ) last on true
      where p.status = 'published' and p.deleted_at is null and p.collection in ('blog', 'projects')
        and not exists (select 1 from seo_drafts o where o.article_id = p.id and o.status in ('generating', 'ready_for_review', 'generation_failed', 'scheduled', 'publishing'))
        and (last.at is null or last.at < now() - make_interval(days => ${stale}))
        ${q ? sql`and p.title ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`}` : sql``}
      order by last.at nulls first, p.published_at nulls last, p.title
      limit ${Math.max(1, Math.min(1000, opts.limit ?? 500))}`),
  );
  return rows.map((r) => ({
    articleId: String(r.id),
    title: r.title,
    path: `/${r.collection}/${r.slug}`,
    collection: r.collection,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    lastReviewedAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    lastOutcome: r.last_status,
    openRecommendations: Number(r.recs),
  }));
}

export type RescanResult = { queued: number; skipped: { articleId: string; reason: string }[]; requested: number };

/**
 * Ask for a fresh draft of each article (given ids, or the not-reviewed list in its order), at most RESCAN_MAX.
 * `request` is requestDraft (injected so tests need no model).
 */
export async function rescanArticles(
  pick: { articleIds: string[] } | { all: true; limit: number; staleDays?: number },
  request: (articleId: string) => Promise<{ queued: boolean; reason?: string }>,
): Promise<RescanResult> {
  const ids = "articleIds" in pick ? [...new Set(pick.articleIds)].slice(0, RESCAN_MAX) : (await unreviewedArticles({ staleDays: pick.staleDays, limit: Math.min(RESCAN_MAX, Math.max(1, pick.limit)) })).map((a) => a.articleId);
  const result: RescanResult = { queued: 0, skipped: [], requested: ids.length };
  for (const id of ids) {
    try {
      const r = await request(id);
      if (r.queued) result.queued++;
      else result.skipped.push({ articleId: id, reason: r.reason ?? "already queued or in review" });
    } catch (e) {
      result.skipped.push({ articleId: id, reason: (e as Error).message.slice(0, 300) });
    }
  }
  return result;
}
