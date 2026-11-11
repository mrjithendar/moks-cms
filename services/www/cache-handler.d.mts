/** Types for cache-handler.mjs (the ISR page cache; Next loads the .mjs itself). */
export type CachedValue = { kind?: string; html?: string } & Record<string, unknown>;
export type PageCacheEntry = { value: CachedValue; lastModified: number; generation: number; cacheControl: unknown; bytes: number };
export type PageCacheState = { generation: number; entries: Map<string, PageCacheEntry>; pending: Map<string, number>; bytes: number; hits: number; misses: number };
export function pageCacheState(): PageCacheState;
export default class PageCacheHandler {
  constructor(ctx?: unknown);
  get(key: string): Promise<{ lastModified: number; value: CachedValue; cacheControl: unknown } | null>;
  set(key: string, data: CachedValue | null, ctx?: { cacheControl?: unknown }): Promise<void>;
  revalidateTag(tags?: string | string[]): Promise<void>;
  resetRequestCache(): void;
}
