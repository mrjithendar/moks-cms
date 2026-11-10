import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "../audit";
import { toIsoOffset } from "../dates-iso";
import { log } from "../log";
import { getPostRow, updatePost, type Actor } from "../posts";
import { submitAfterPublish } from "../seo-intel/submission";

/**
 * "Add correction / update" on published news (docs/news/JOBS.md). An admin action in the editor's own update path:
 * appends a dated note to the post's `corrections` (the article page shows them in its Corrections box), sets
 * `updatedAt` (→ JSON-LD dateModified, sitemap lastmod, "Updated" on the page) and resubmits through the v2 submission
 * path (IndexNow + Search Console sitemap resubmission incl. the news sitemap). The only updatePost call in src/lib/news.
 */
export async function addCorrection(actor: Actor, postId: string, note: string, now = new Date()) {
  if (actor.role !== "admin") throw Object.assign(new Error("Admins only."), { status: 403 });
  const text = note.trim();
  if (text.length < 10 || text.length > 1000) throw Object.assign(new Error("Write the correction in 10–1,000 characters."), { status: 400 });
  const current = await getPostRow(actor, postId);
  if (current.status !== "published" || current.collection !== "news") throw Object.assign(new Error("Corrections are for published news articles."), { status: 409 });
  const at = toIsoOffset(now);
  const corrections = [...((current.corrections as { date: string; note: string }[] | null) ?? []), { date: at, note: text }];
  const row = await updatePost(actor, postId, { corrections, updatedAt: at }, { baseVersion: current.version, reason: "correction", notifySearchEngines: false });
  const db = await getDb();
  await submitAfterPublish(db, { draftId: null, articleId: postId, path: `/${row.collection}/${row.slug}`, reason: "edit" }, { actor }).catch((e) => log.warn("news correction submission failed", { err: e, operation: "news_correction" }));
  await audit(actor, "news.correction.add", postId, { note: text, version: row.version });
  return { version: row.version, corrections: corrections.length, updatedAt: at };
}

/** "This news may be outdated": when the article's job set an expiry and it has passed, with the newest coverage. */
export async function newsExpiry(postId: string, now = new Date()): Promise<{ newer: { title: string; path: string } | null } | null> {
  try {
    const db = await getDb();
    const [a] = rowsOf<{ expires_after_days: number | null; published_at: string | null; category: string }>(
      await db.execute(sql`select a.expires_after_days, coalesce(a.published_at, p.published_at)::text as published_at, p.category from news_articles a join post p on p.id = a.post_id where a.post_id = ${postId} and a.status = 'published' order by a.created_at desc limit 1`),
    );
    if (!a?.expires_after_days || !a.published_at) return null;
    if (Date.parse(a.published_at) + a.expires_after_days * 86_400_000 > now.getTime()) return null;
    const [n] = rowsOf<{ title: string; path: string }>(
      await db.execute(sql`select title, '/' || collection || '/' || slug as path from post where collection = 'news' and status = 'published' and deleted_at is null and noindex = false and category = ${a.category} and published_at > ${a.published_at} order by published_at desc limit 1`),
    );
    return { newer: n ?? null };
  } catch {
    return null; // the notice is optional; the article always renders
  }
}
