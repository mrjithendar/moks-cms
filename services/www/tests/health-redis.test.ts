import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { redisCheck } = await import("@/lib/health");

/** System status › Redis: running without Redis (no REDIS_URL, since 2026-11-09) is the supported setup, not an error. */
describe("Redis health check", () => {
  it("reports OK, with an explanation, when REDIS_URL is not set", async () => {
    const connect = vi.fn();
    const r = await redisCheck({}, connect as never);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/Not used \(by design\).*Postgres/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("is degraded when REDIS_URL is set but Redis cannot be reached", async () => {
    expect(await redisCheck({ REDIS_URL: "redis://valkey:6379" }, (async () => null) as never)).toMatchObject({ status: "degraded" });
  });

  it("pings a configured Redis", async () => {
    const redis = { ping: vi.fn(async () => "PONG"), info: vi.fn(async () => "used_memory_human:1.5M\r\n") };
    expect(await redisCheck({ REDIS_URL: "redis://valkey:6379" }, (async () => redis) as never)).toEqual({ status: "ok", detail: "PONG · 1.5M used" });
  });
});

/** System status › Cache bus: shown, never "down" (the site works without it; readiness never looks at it). */
describe("Cache bus health check", () => {
  it("reports each state without failing", async () => {
    const { cacheBusCheck } = await import("@/lib/health");
    expect(cacheBusCheck({ state: "not configured", publisher: false, subscriber: false, source: null })).toMatchObject({ status: "not configured", detail: expect.stringMatching(/^cache bus: not configured/) });
    expect(cacheBusCheck({ state: "connected", publisher: true, subscriber: true, source: "CACHE_BUS_REDIS_URL" })).toMatchObject({ status: "ok", detail: expect.stringMatching(/^cache bus: connected ·/) });
    const down = cacheBusCheck({ state: "disconnected", publisher: true, subscriber: false, source: "CACHE_BUS_REDIS_URL" });
    expect(down.status).toBe("degraded");
    expect(down.detail).toMatch(/^cache bus: disconnected .*subscriber down/);
  });
});
