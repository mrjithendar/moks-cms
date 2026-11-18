import type { Redis } from "ioredis";
import { log } from "./log";

/**
 * Optional Redis (REDIS_URL). When set, Better Auth sessions, rate limits and API-key lookups use it (auth.ts,
 * rate-limit.ts, api-keys.ts). Production does not set it (since 2026-11-09): those stay in Postgres.
 *
 * Cross-replica cache invalidation does NOT use this module: it has its own pub/sub-only connections and variable
 * (CACHE_BUS_REDIS_URL, src/lib/cache-bus.ts), so enabling it never moves sessions or rate limits into Redis.
 */
const g = globalThis as unknown as { __redis?: Promise<Redis | null> };

async function connect(): Promise<Redis | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const { Redis } = await import("ioredis");
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false, connectTimeout: 3000 });
  client.on("error", (err) => log.warn("redis error", { err }));
  try {
    await client.connect();
    return client;
  } catch (error) {
    log.warn("redis unavailable, continuing without it", { err: error });
    return null;
  }
}

export function getRedis(): Promise<Redis | null> {
  g.__redis ??= connect();
  return g.__redis;
}
