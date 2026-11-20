import { eq, inArray } from "drizzle-orm";
import { PAGE_SIZE, tagSlug } from "@/config/taxonomy";
import { getDb, schema } from "@/db";
import type { PurgeOutcome } from "./cloudflare";
import { log } from "./log";

/**
 * Purge on publish (W3 Total Cache's "purge policy"): when content changes, Cloudflare's copies of the affected pages
 * are purged too, so readers see the change at once instead of after Cloudflare's own refresh.
 *
 * - A post, news story or project: its page and every page that lists it (relatedPostPaths). A page from Admin →
 *   Pages: its address and the home page. Site-wide changes (Appearance, menus, categories): everything.
 * - Admin → Cache → Cloudflare settings → "Purge Cloudflare when content changes": related (the default), everything
 *   on every change, or off. Nothing happens until a zone ID and API token are saved there.
 * - Changes are collected for a few seconds and sent together, after the cache bus has cleared the other servers'
 *   page caches (about a second): otherwise Cloudflare could fetch the old page again from a server not cleared yet.
 *   Runs on the server that made the change, in the background: a save never waits for Cloudflare, and a failure is
 *   logged and shown in Admin → Cache, never raised.
 *
 * Posts, pages and settings import this module, so it stays free of server-only imports: Cloudflare and the stored
 * credentials are loaded when a purge is sent. Under Vitest nothing is sent on a timer; tests call flushCdnPurge().
 */
export type PurgePolicy = "related" | "everything" | "off";

export function purgePolicy(env: Record<string, string | undefined>): PurgePolicy {
  const v = env.CLOUDFLARE_PURGE_ON_PUBLISH?.trim();
  return v === "everything" || v === "off" ? v : "related";
}

/** A post as it was or is now (before and after a change), enough to find the pages that list it. */
export type PostRef = { collection: string; slug: string; category: string; tags: string[]; authorId: string };
/** What the published site looks like now, for page counts. */
export type ListingCounts = { collection: Map<string, number>; category: Map<string, number>; tag: Map<string, number>; author: Map<string, number> };

/** `base`, then `base/page/2…` up to the page a list of n + 1 items needs (the +1 covers a list that just got shorter). */
function paged(base: string, n: number): string[] {
  const last = Math.max(1, Math.ceil((n + 1) / PAGE_SIZE));
  return [base, ...Array.from({ length: last - 1 }, (_, i) => `${base}/page/${i + 2}`)];
}

/** Pure: every public path that shows this post or a list it is in. */
export function relatedPostPaths(post: PostRef, counts: ListingCounts, authorSlug: string | null): string[] {
  const out = new Set<string>(["/", `/${post.collection}/${post.slug}`, "/feed.xml", "/sitemap.xml", "/search-index.json", "/llms.txt"]);
  if (post.collection === "news") {
    out.add("/news/feed.xml");
    out.add("/news-sitemap.xml");
  }
  for (const p of paged(`/${post.collection}`, counts.collection.get(post.collection) ?? 0)) out.add(p);
  if (post.category) {
    for (const p of paged(`/category/${post.category}`, counts.category.get(post.category) ?? 0)) out.add(p);
    out.add(`/category/${post.category}/feed.xml`);
  }
  for (const tag of post.tags) {
    const t = tagSlug(tag);
    if (t) for (const p of paged(`/tag/${t}`, counts.tag.get(t) ?? 0)) out.add(p);
  }
  if (authorSlug) for (const p of paged(`/authors/${authorSlug}`, counts.author.get(authorSlug) ?? 0)) out.add(p);
  return [...out];
}

type Change = { posts?: PostRef[]; paths?: string[]; everything?: boolean };
type Queue = { posts: PostRef[]; paths: Set<string>; everything: boolean; timer?: ReturnType<typeof setTimeout> };
export type LastPurge = { at: string; what: string; outcome: PurgeOutcome };

const g = globalThis as unknown as { __cdnPurge?: Queue; __cdnPurgeLast?: LastPurge | null };
const queue = (): Queue => (g.__cdnPurge ??= { posts: [], paths: new Set(), everything: false });

/** Collects changes for this long before sending them to Cloudflare (see the module comment). */
const SETTLE_MS = 3000;

/** The last automatic purge on this server (Admin → Cache shows it). */
export function lastAutoPurge(): LastPurge | null {
  return g.__cdnPurgeLast ?? null;
}

/** Content changed: purge Cloudflare's copies soon, per the policy. Synchronous, never throws, never waits. */
export function queueCdnPurge(change: Change) {
  const q = queue();
  if (change.posts) q.posts.push(...change.posts);
  for (const p of change.paths ?? []) q.paths.add(p);
  if (change.everything) q.everything = true;
  if (q.timer || process.env.VITEST) return;
  q.timer = setTimeout(() => {
    void flushCdnPurge().catch((err) => log.warn("purge on publish failed", { event: "cloudflare_auto_purge_failed", err }));
  }, SETTLE_MS);
  q.timer.unref?.();
}

async function listingCounts(): Promise<ListingCounts> {
  const { getPublishedContent } = await import("./content");
  const counts: ListingCounts = { collection: new Map(), category: new Map(), tag: new Map(), author: new Map() };
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const a of await getPublishedContent({ preview: false })) {
    inc(counts.collection, a.collection);
    inc(counts.category, a.frontmatter.category);
    for (const t of a.frontmatter.tags) inc(counts.tag, tagSlug(t));
    inc(counts.author, a.frontmatter.author);
  }
  return counts;
}

/** Send what was collected. Exported for tests; normally called by the timer. */
export async function flushCdnPurge(): Promise<LastPurge | null> {
  const q = queue();
  const posts = q.posts.splice(0);
  const paths = new Set(q.paths);
  const everythingAsked = q.everything;
  q.paths.clear();
  q.everything = false;
  if (q.timer) clearTimeout(q.timer);
  q.timer = undefined;
  if (!posts.length && !paths.size && !everythingAsked) return null;

  const [{ cloudflareConfig, purgeCloudflare, siteUrls }, { effectiveEnv }] = await Promise.all([import("./cloudflare"), import("./runtime-settings")]);
  const env = await effectiveEnv();
  const policy = purgePolicy(env);
  const cfg = await cloudflareConfig(env);
  if (!cfg || policy === "off") return null;

  let result: LastPurge;
  if (everythingAsked || policy === "everything") {
    result = { at: new Date().toISOString(), what: "everything", outcome: await purgeCloudflare(cfg, { everything: true }) };
  } else {
    if (posts.length) {
      const db = await getDb();
      const ids = [...new Set(posts.map((p) => p.authorId))];
      const profiles = ids.length ? await db.select({ userId: schema.authorProfile.userId, slug: schema.authorProfile.slug }).from(schema.authorProfile).where(ids.length === 1 ? eq(schema.authorProfile.userId, ids[0]!) : inArray(schema.authorProfile.userId, ids)) : [];
      const slugOf = new Map(profiles.map((p) => [p.userId, p.slug]));
      const counts = await listingCounts();
      for (const p of posts) for (const path of relatedPostPaths(p, counts, slugOf.get(p.authorId) ?? null)) paths.add(path);
    }
    const urls = siteUrls(paths);
    result = { at: new Date().toISOString(), what: `${urls.length} address${urls.length === 1 ? "" : "es"}`, outcome: await purgeCloudflare(cfg, { kind: "files", items: urls }) };
  }
  g.__cdnPurgeLast = result;
  if (!result.outcome.ok) log.warn("purge on publish refused by Cloudflare", { event: "cloudflare_auto_purge_refused", error: result.outcome.error, status: result.outcome.status });
  else log.info("purged Cloudflare after a change", { event: "cloudflare_auto_purge", what: result.what, requests: result.outcome.requests });
  return result;
}
