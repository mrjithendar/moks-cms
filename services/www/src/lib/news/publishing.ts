import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "../posts";

/**
 * What publishNewArticle (seo-intel/publish.ts, the existing approval-only path) adds for news desk drafts: the
 * reviewed metadata goes onto the CMS post, and the outcome feeds the learning loop. Nothing here can publish on its
 * own; both functions are called only from inside publishNewArticle after the approval was verified.
 */
type NewsDoc = {
  news?: {
    categories?: string[];
    tags?: string[];
    sources?: { title?: string; publisher?: string; url: string }[];
    image?: { src?: string; alt?: string; width?: number; height?: number; variants?: Record<string, string> } | null;
  };
};

const MEDIA = /^\/media\/[0-9a-f-]{36}\/[^/?#]+$/i;

/** Extra post fields for the publish patch when the draft is a news desk draft (empty otherwise). */
export async function newsPublishPatch(db: Db, doc: unknown): Promise<Record<string, unknown>> {
  const n = (doc as NewsDoc | null)?.news;
  if (!n) return {};
  const patch: Record<string, unknown> = { contentType: "news" };
  const cat = n.categories?.[0];
  if (cat) {
    const [ok] = rowsOf<{ slug: string }>(await db.execute(sql`select slug from category where slug = ${cat}`));
    if (ok) patch.category = ok.slug;
  }
  if (n.tags) patch.tags = n.tags.slice(0, 10);
  const sources = (n.sources ?? []).filter((s) => /^https?:\/\//.test(s.url)).map((s) => ({ title: s.title || s.url, url: s.url, publisher: s.publisher || new URL(s.url).hostname }));
  if (sources.length) patch.sources = sources;
  const img = n.image;
  if (img?.src && MEDIA.test(img.src) && img.alt) {
    patch.featuredImage = { src: img.src, alt: img.alt.slice(0, 300), width: img.width ?? 1600, height: img.height ?? 900 };
    const og = img.variants?.og;
    if (og && MEDIA.test(og)) patch.socialImage = { src: og, alt: img.alt.slice(0, 300), width: 1200, height: 630 };
  }
  return patch;
}

/** After a successful publish: news_articles → published, approval recorded with the edit distance (learning loop). */
export async function onNewsPublished(db: Db, draftId: string, actor: Actor, finalBody: string) {
  const [a] = rowsOf<{ id: string }>(await db.execute(sql`select id from news_articles where draft_id = ${draftId} limit 1`));
  if (!a) return;
  const { recordReview } = await import("./service");
  await recordReview(actor, draftId, "approved", { finalBody });
  await db.execute(sql`update news_articles set status = 'published', published_at = now(), updated_at = now() where id = ${a.id}`);
}
