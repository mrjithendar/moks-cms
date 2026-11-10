import { afterAll, describe, expect, it } from "vitest";
import { createCacheBus, type CacheBus } from "@/lib/cache-bus";

/**
 * Against a real Redis/Valkey with the real ioredis client. Skipped unless both URLs are given, e.g. a local
 * redis-server or valkey-server with the ACL line from docs/redis-site-cachebus.md:
 *
 *   CACHE_BUS_IT_URL=redis://site-cachebus:<pw>@127.0.0.1:6399 \
 *   CACHE_BUS_IT_ADMIN_URL=redis://default:<admin pw>@127.0.0.1:6399 npx vitest run tests/cache-bus-redis.test.ts
 *
 * Prints the measured convergence (publish on replica A → cache cleared on replica B).
 */
const url = process.env.CACHE_BUS_IT_URL;
const adminUrl = process.env.CACHE_BUS_IT_ADMIN_URL;
const buses: CacheBus[] = [];

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 1));
  }
}

afterAll(async () => {
  for (const b of buses) await b.close();
});

describe.skipIf(!url || !adminUrl)("cache bus against a real server", () => {
  const replica = (origin: string) => {
    const bus = createCacheBus({ url: () => ({ url: url!, source: "CACHE_BUS_REDIS_URL" }), origin, heartbeatMs: 0 });
    buses.push(bus);
    bus.listen();
    return bus;
  };

  it("converges between two replicas, and again after the server drops the connections", async () => {
    const a = replica("it-a");
    const b = replica("it-b");
    let cleared = 0;
    b.onInvalidate("content", () => (cleared += 1));
    await until(() => a.status().state === "connected" && b.status().state === "connected");

    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const before = cleared;
      const t = performance.now();
      a.broadcast("content");
      await until(() => cleared > before);
      samples.push(performance.now() - t);
    }
    samples.sort((x, y) => x - y);
    const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!.toFixed(2);
    console.log(`cache bus convergence over ${samples.length} invalidations: p50 ${p(0.5)} ms, p99 ${p(0.99)} ms, max ${p(1)} ms`);
    expect(Number(p(0.99))).toBeLessThan(1000);

    // Kill the bus's connections from the server side (as an HAProxy cut or a Valkey failover would).
    const { Redis } = await import("ioredis");
    const admin = new Redis(adminUrl!);
    const listed = await admin.client("LIST");
    expect(String(listed)).toMatch(/name=jithendar-com:cachebus:subscriber:\S+ .*user=site-cachebus/);
    await admin.client("KILL", "USER", "site-cachebus");
    await until(() => b.status().subscriber === false || a.status().publisher === false, 2000).catch(() => {});
    const t = performance.now();
    await until(() => a.status().state === "connected" && b.status().state === "connected", 10_000);
    const before = cleared;
    await until(() => {
      a.broadcast("content");
      return cleared > before;
    }, 10_000);
    console.log(`cache bus back after CLIENT KILL in ${(performance.now() - t).toFixed(0)} ms`);
    await admin.quit();
  });
});
