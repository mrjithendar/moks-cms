import "server-only";
import { purgeablePath, type CacheAction } from "./admin-bar";
import { audit } from "./audit";
import { broadcastInvalidate, cacheBusStatus, KINDS } from "./cache-bus";
import { pageCacheStats, purgePages } from "./page-cache";
import { PostError, type Actor } from "./posts";

/**
 * The admin's cache controls (admin bar → Cache, Admin → Cache): what each one clears, on every replica through the
 * cache bus (lib/cache-bus.ts). Nothing here is needed for correctness: every change made in the admin already clears
 * what it affects. These are for "I changed something outside the admin" and "show me a fresh copy now".
 *
 * Every action is admin-only (the read-only demo is refused before it gets here) and written to the audit log.
 */
export async function runCacheAction(actor: Actor, action: CacheAction, rawPath?: unknown): Promise<string> {
  if (actor.role !== "admin") throw new PostError("Only admins can clear caches.", 403);
  switch (action) {
    case "purge-page": {
      const path = purgeablePath(rawPath);
      if (!path || /^\/(admin|api)(\/|$)/.test(path)) throw new PostError("Choose a public page of this site (an address starting with /).", 400);
      purgePages(path);
      await audit(actor, "cache.purge.page", path);
      return `${path} was removed from the page cache on every server. The next visit renders it again.`;
    }
    case "clear-pages":
      purgePages(null);
      await audit(actor, "cache.clear.pages");
      return "The page cache was cleared on every server. Pages are rendered again within seconds.";
    case "clear-data":
      for (const kind of KINDS) broadcastInvalidate(kind);
      await audit(actor, "cache.clear.data");
      return "Content, settings, menus and integrations were reloaded on every server, and the page cache was cleared.";
    case "purge-all":
      for (const kind of KINDS) broadcastInvalidate(kind);
      purgePages(null);
      await audit(actor, "cache.purge.all");
      return "Every cache on every server was cleared. Pages are rendered again within seconds.";
  }
}

/** What Admin → Cache shows about the server that answered (each server has its own page cache). */
export function cacheStatus() {
  const stats = pageCacheStats();
  const lookups = stats.hits + stats.misses;
  return {
    pod: (process.env.HOSTNAME ?? "local").slice(0, 63),
    pages: stats.entries,
    bytes: stats.bytes,
    maxBytes: Math.max(1, Number(process.env.PAGE_CACHE_MAX_MB || 64)) * 1024 * 1024,
    hitRate: lookups ? stats.hits / lookups : null,
    lookups,
    clears: stats.generation,
    bus: cacheBusStatus(),
  };
}
