import { sql } from "drizzle-orm";
import { collections } from "@/config/taxonomy";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";

/**
 * URL normalisation for joining Search Console pages, GA4 landing pages, crawled URLs and articles.
 *
 * Rules (documented in docs/seo/SCHEMA.md):
 * - Hosts of this site (the canonical host and its `www.` variant) become the canonical origin (https, apex), so
 *   http://, https://www. and https:// rows for the same page are one page. Other hosts keep their own host.
 * - Query strings and fragments are dropped (GA4's landingPagePlusQueryString, tracking parameters).
 * - Trailing slashes are removed (except the root): the site 308-redirects them to the slash-less URL.
 * - Paths are lower-cased: every route of this site (slugs, categories, tags) is lower-case kebab-case.
 * - Percent-encoding is normalised by the URL parser; `//` runs collapse to `/`.
 */
export type Normalized = { url: string; path: string; internal: boolean };

export function siteOrigin(env: Record<string, string | undefined> = process.env): URL {
  return new URL(env.SITE_URL?.trim() || "https://jithendar.com");
}

export function normalizeUrl(raw: string, origin: URL = siteOrigin()): Normalized | null {
  const input = raw.trim();
  if (!input) return null;
  let u: URL;
  try {
    // GA4 landing pages are paths ("/blog/x?utm=…"); GSC pages are absolute URLs.
    u = input.startsWith("/") ? new URL(input, origin) : new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const siteHost = origin.hostname.toLowerCase();
  const internal = host === siteHost || host === `www.${siteHost}` || `www.${host}` === siteHost;
  let path = u.pathname.replace(/\/{2,}/g, "/").toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  const base = internal ? `${origin.protocol}//${origin.host}` : `https://${host}${u.port ? `:${u.port}` : ""}`;
  return { url: `${base}${path === "/" ? "/" : path}`, path, internal };
}

const ARTICLE_PATH = new RegExp(`^/(${collections.join("|")})/([a-z0-9]+(?:-[a-z0-9]+)*)$`);

export function articlePathParts(path: string): { collection: string; slug: string } | null {
  const m = ARTICLE_PATH.exec(path);
  return m ? { collection: m[1]!, slug: m[2]! } : null;
}

/**
 * Article ids for normalised paths: direct match on collection/slug, else through the `redirect` table (renamed
 * slugs keep their old URLs in Search Console for a while). Paths without a post map to null.
 */
export async function resolveArticleIds(db: Db, paths: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(paths)];
  if (!unique.length) return out;
  const posts = rowsOf<{ id: string; collection: string; slug: string }>(
    await db.execute(sql`select id, collection, slug from post where deleted_at is null`),
  );
  const byPath = new Map(posts.map((p) => [`/${p.collection}/${p.slug}`, p.id]));
  const redirects = rowsOf<{ from_path: string; to_path: string }>(await db.execute(sql`select from_path, to_path from redirect`));
  const redirectMap = new Map(redirects.map((r) => [r.from_path.toLowerCase(), r.to_path.toLowerCase()]));
  for (const path of unique) {
    let target = path;
    // Follow at most 5 redirects (renamed more than once).
    for (let i = 0; i < 5 && !byPath.has(target) && redirectMap.has(target); i++) target = redirectMap.get(target)!;
    out.set(path, byPath.get(target) ?? null);
  }
  return out;
}

/** Record normalised URLs in seo_url_map (insert new ones, refresh last_seen and article id). */
export async function upsertUrlMap(db: Db, urls: Normalized[], now = new Date()): Promise<void> {
  const unique = [...new Map(urls.map((u) => [u.url, u])).values()];
  if (!unique.length) return;
  const ids = await resolveArticleIds(db, unique.map((u) => u.path));
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const values = sql.join(
      chunk.map((u) => sql`(${u.url}, ${u.path}, ${u.internal ? ids.get(u.path) ?? null : null}::uuid, ${u.internal}, ${now.toISOString()}, ${now.toISOString()})`),
      sql`, `,
    );
    await db.execute(sql`
      insert into seo_url_map (url, path, article_id, is_canonical, first_seen, last_seen) values ${values}
      on conflict (url) do update set article_id = excluded.article_id, last_seen = excluded.last_seen`);
  }
}
