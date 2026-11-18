import { onInvalidate, type Kind } from "./cache-bus";

/**
 * The ISR page cache's control side (the store itself is cache-handler.mjs, next.config.ts `cacheHandler`).
 *
 * Public pages are rendered once and served from memory; `revalidate` on each route re-renders them in the
 * background after a while. A change made in the admin (content, categories, appearance, integrations) clears the
 * page cache at once, on this replica and, through the cache bus, on the others. The next visitor of each page gets
 * a fresh render, and the warm-up (warm.ts) re-renders the site shortly afterwards.
 */

/** Seconds before a cached page is re-rendered in the background, if nothing cleared it first. Also the delay
 * before a scheduled post (publishedAt in the future) appears on cached listings. */
export const PAGE_REVALIDATE_SECONDS = 300;

/** Bus kinds whose data is rendered into public pages ("practice" pages are per user and not cached). */
export const PAGE_KINDS: readonly Kind[] = ["content", "categories", "settings", "integrations"];

// Shared with cache-handler.mjs through globalThis (same shape as its pageCacheState()).
type State = { generation: number; entries: Map<string, unknown>; pending: Map<string, number>; bytes: number; hits: number; misses: number };
const KEY = Symbol.for("jithendar.pageCache");

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { generation: 0, entries: new Map(), pending: new Map(), bytes: 0, hits: 0, misses: 0 });
}

// On globalThis too: instrumentation.ts and the app routes are separate bundles with their own module copies.
const gl = globalThis as unknown as { __pageCacheListeners?: Set<() => void>; __pageCacheWired?: boolean };
const listeners = (gl.__pageCacheListeners ??= new Set());

/** Every cached page becomes stale now (this process only; the bus carries it to the other replicas). */
export function clearPageCache() {
  state().generation++;
  for (const l of listeners) l();
}

/** Called after every clear, e.g. to schedule the warm-up. */
export function onPageCacheCleared(listener: () => void) {
  listeners.add(listener);
}

export function pageCacheStats() {
  const s = state();
  return { generation: s.generation, entries: s.entries.size, bytes: s.bytes, hits: s.hits, misses: s.misses };
}

// Registered once per process (instrumentation.ts imports this module before the bus starts listening).
if (!gl.__pageCacheWired) {
  gl.__pageCacheWired = true;
  for (const kind of PAGE_KINDS) onInvalidate(kind, clearPageCache);
}
