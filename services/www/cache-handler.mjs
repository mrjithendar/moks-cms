// @ts-check
/**
 * ISR page cache (next.config.ts `cacheHandler`): rendered pages and route handlers, in memory, per pod.
 *
 * Why a custom handler instead of Next's default: the default in-memory cache can only be cleared from inside a
 * request (revalidatePath/revalidateTag throw elsewhere), but a publish on one replica reaches the others as a
 * cache-bus message (src/lib/cache-bus.ts), outside any request. So every entry carries the cache "generation" it was
 * rendered in, and clearing the cache is one counter bump on globalThis (src/lib/page-cache.ts), which the bus
 * listener can do on any replica. Time-based revalidation (each route's `revalidate`) still applies on top.
 *
 * Next creates one handler instance per request, so the store lives on globalThis, shared by every instance and by
 * the app bundle that bumps the generation. Nothing is written to disk (read-only root filesystem); a restarted pod
 * starts empty and the warm-up (src/lib/warm.ts) renders the site again.
 *
 * Optimized images do not come here (that needs `images.customCacheHandler: true`, not set): they keep next/image's
 * own disk cache. `'use cache'` is not used by the site and would need `cacheHandlers` (plural).
 */

const KEY = Symbol.for("jithendar.pageCache");
const MAX_BYTES = Math.max(1, Number(process.env.PAGE_CACHE_MAX_MB || 64)) * 1024 * 1024;

/**
 * @typedef {{ value: any, lastModified: number, generation: number, cacheControl: any, bytes: number }} Entry
 * @typedef {{ generation: number, entries: Map<string, Entry>, pending: Map<string, number>, bytes: number, hits: number, misses: number }} State
 */

/** @returns {State} */
export function pageCacheState() {
  const g = /** @type {Record<symbol, State | undefined>} */ (/** @type {unknown} */ (globalThis));
  return (g[KEY] ??= { generation: 0, entries: new Map(), pending: new Map(), bytes: 0, hits: 0, misses: 0 });
}

/** Rough size of a cached value: HTML, RSC payload and segment data dominate. */
function sizeOf(value) {
  if (!value || typeof value !== "object") return 64;
  let n = 256;
  for (const part of [value.html, value.rscData, value.body, value.postponed]) {
    if (typeof part === "string") n += part.length * 2;
    else if (part && typeof part.byteLength === "number") n += part.byteLength;
  }
  if (value.segmentData instanceof Map) for (const v of value.segmentData.values()) n += v?.byteLength ?? 0;
  return n;
}

/** @param {State} s @param {string} key */
function drop(s, key) {
  const e = s.entries.get(key);
  if (!e) return;
  s.bytes -= e.bytes;
  s.entries.delete(key);
}

export default class PageCacheHandler {
  // Next passes a context (fs, flushToDisk, …); this store needs none of it.
  constructor() {}

  /** @param {string} key */
  async get(key) {
    const s = pageCacheState();
    const e = s.entries.get(key);
    if (!e || e.generation !== s.generation) {
      if (e) drop(s, key);
      // The render that follows this miss started in this generation: if the cache is cleared while it runs, its
      // result (rendered from older data) must not be stored as current.
      s.pending.set(key, s.generation);
      s.misses++;
      return null;
    }
    // LRU: most recently used last.
    s.entries.delete(key);
    s.entries.set(key, e);
    s.hits++;
    return { lastModified: e.lastModified, value: e.value, cacheControl: e.cacheControl };
  }

  /** @param {string} key @param {any} data @param {{ cacheControl?: unknown }} [ctx] */
  async set(key, data, ctx) {
    const s = pageCacheState();
    const started = s.pending.get(key) ?? s.generation;
    s.pending.delete(key);
    drop(s, key);
    if (data === null || started !== s.generation) return;
    const bytes = sizeOf(data);
    if (bytes > MAX_BYTES / 4) return; // one huge response must not flush everything else
    s.entries.set(key, { value: data, lastModified: Date.now(), generation: s.generation, cacheControl: ctx?.cacheControl, bytes });
    s.bytes += bytes;
    for (const old of s.entries.keys()) {
      if (s.bytes <= MAX_BYTES) break;
      drop(s, old);
    }
  }

  /** revalidatePath/revalidateTag (this process): the site is small, so any tag clears every page. */
  async revalidateTag() {
    pageCacheState().generation++;
  }

  resetRequestCache() {}
}
