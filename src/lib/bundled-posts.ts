import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { auditSafe } from "./audit";
import { invalidateContent } from "./content";
import { articleRow } from "./content/import";
import { contentRoot, loadContent } from "./content/load";
import { log } from "./log";

/**
 * Posts shipped in content/{blog,news,projects}/*.mdx reach Postgres at /setup. Files added later become
 * **drafts automatically** (syncBundledPosts(), at server start): there is nothing to click in Admin → Posts.
 * A file is only ever turned into a post once: the bundled_import ledger remembers it, so a post an editor
 * deleted permanently is not created again on the next start. Nothing is published automatically: every
 * import is a draft with no publish date, whatever the file's frontmatter says.
 */
export type BundledImport = { collection: string; slug: string; id: string };

const SYSTEM = { id: null, label: "system (content sync)" };

export async function syncBundledPosts(): Promise<BundledImport[]> {
  let articles;
  try {
    articles = loadContent(contentRoot()).articles;
  } catch (err) {
    log.warn("bundled content unavailable", { err });
    return [];
  }
  const db = await getDb();
  // Before /setup there is no admin to own the drafts; setup imports the content itself.
  const [admin] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.role, "admin")).orderBy(asc(schema.user.createdAt)).limit(1);
  if (!admin) return [];

  const key = (collection: string, slug: string) => `${collection}/${slug}`;
  const existing = new Set((await db.select({ c: schema.post.collection, s: schema.post.slug }).from(schema.post)).map((r) => key(r.c, r.s)));
  const seen = new Set((await db.select({ c: schema.bundledImport.collection, s: schema.bundledImport.slug }).from(schema.bundledImport)).map((r) => key(r.c, r.s)));
  const profiles = new Map((await db.select({ slug: schema.authorProfile.slug, userId: schema.authorProfile.userId }).from(schema.authorProfile)).map((p) => [p.slug, p.userId]));

  const imported: BundledImport[] = [];
  for (const article of articles) {
    const k = key(article.collection, article.slug);
    if (seen.has(k)) continue;
    if (!existing.has(k)) {
      // The byline is the file's author when that profile exists, otherwise the first admin.
      const authorId = profiles.get(article.frontmatter.author) ?? admin.id;
      const [row] = await db
        .insert(schema.post)
        .values({ ...articleRow(article, authorId), status: "draft", publishedAt: null })
        .onConflictDoNothing() // another replica starting at the same moment
        .returning({ id: schema.post.id });
      if (row) {
        imported.push({ collection: article.collection, slug: article.slug, id: row.id });
        await auditSafe(SYSTEM, "post.import", k, { from: `content/${k}.mdx`, automatic: true });
      }
    }
    // Also recorded for files whose post already existed (setup, earlier manual imports).
    await db.insert(schema.bundledImport).values({ collection: article.collection, slug: article.slug }).onConflictDoNothing();
  }
  if (imported.length) {
    invalidateContent();
    log.info("bundled posts imported as drafts", { event: "bundled_posts_imported", count: imported.length, posts: imported.map((i) => `${i.collection}/${i.slug}`) });
  }
  return imported;
}
