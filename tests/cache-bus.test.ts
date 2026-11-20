import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL, createCacheBus, type BusConnection, type CacheBus, type Role } from "@/lib/cache-bus";
import { log } from "@/lib/log";
import { renderCacheBus } from "@/lib/metrics";

/**
 * In-memory pub/sub server: what the bus needs of Valkey. Each FakeConnection behaves like an ioredis client with
 * enableOfflineQueue: false (commands on a connection that is not ready reject at once) and a retryStrategy (after a
 * drop it reconnects when the server is back; SUBSCRIBE state is lost, as on a real reconnect).
 */
class FakeServer {
  up = true;
  conns = new Set<FakeConnection>();
  published: string[] = [];
  deliver(channel: string, message: string): number {
    this.published.push(message);
    let n = 0;
    for (const c of this.conns) {
      if (c.status === "ready" && c.channels.has(channel)) {
        n += 1;
        queueMicrotask(() => c.emit("message", channel, message));
      }
    }
    return n;
  }
  /** Server goes away: every connection closes and starts reconnecting. */
  stop() {
    this.up = false;
    for (const c of this.conns) c.drop();
  }
  /** Server is back: waiting connections reconnect (the retryStrategy firing). */
  start() {
    this.up = true;
    for (const c of this.conns) if (c.status === "reconnecting") c.establish();
  }
}

class FakeConnection extends EventEmitter implements BusConnection {
  status = "wait";
  channels = new Set<string>();
  subscribeCalls = 0;
  constructor(
    private server: FakeServer,
    readonly role: Role,
  ) {
    super();
    server.conns.add(this);
  }
  establish() {
    if (!this.server.up) {
      this.status = "reconnecting";
      this.emit("error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" }));
      return false;
    }
    this.status = "ready";
    this.emit("ready");
    return true;
  }
  async connect() {
    this.status = "connecting";
    if (!this.establish()) throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
  drop() {
    this.channels.clear();
    this.status = "reconnecting";
    this.emit("close");
  }
  private writable() {
    if (this.status !== "ready") throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
  }
  async publish(channel: string, message: string) {
    this.writable();
    return this.server.deliver(channel, message);
  }
  async subscribe(channel: string) {
    this.writable();
    this.subscribeCalls += 1;
    this.channels.add(channel);
    return 1;
  }
  async ping() {
    this.writable();
    return "PONG";
  }
  disconnect(reconnect = false) {
    this.drop();
    if (reconnect) queueMicrotask(() => this.establish());
    else {
      this.status = "end";
      this.server.conns.delete(this);
    }
  }
}

const URL = { url: "redis://site-cachebus:x@valkey-master.redis:6379", source: "CACHE_BUS_REDIS_URL" as const };
const buses: CacheBus[] = [];

function replica(server: FakeServer, name: string) {
  const conns: Partial<Record<Role, FakeConnection>> = {};
  const bus = createCacheBus({
    url: () => URL,
    origin: name,
    heartbeatMs: 0,
    publishWaitMs: 200,
    connect: async (role) => (conns[role] = new FakeConnection(server, role)),
  });
  buses.push(bus);
  return { bus, conns };
}

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 1));
  }
}

afterEach(async () => {
  for (const b of buses.splice(0)) await b.close();
  vi.restoreAllMocks();
});

describe("cache bus: two replicas over pub/sub", () => {
  it("an invalidation on one replica clears the other replica's cache", async () => {
    const server = new FakeServer();
    const a = replica(server, "pod-a");
    const b = replica(server, "pod-b");
    const clearA = vi.fn();
    const clearB = vi.fn();
    a.bus.onInvalidate("content", clearA);
    b.bus.onInvalidate("content", clearB);
    a.bus.listen();
    b.bus.listen();
    await until(() => a.bus.status().state === "connected" && b.bus.status().state === "connected");

    const started = performance.now();
    a.bus.broadcast("content");
    expect(clearA).toHaveBeenCalledTimes(1); // local clear is synchronous
    await until(() => clearB.mock.calls.length === 1);
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1000);

    expect(JSON.parse(server.published[0]!)).toEqual({ kind: "content", origin: "pod-a" }); // nothing but kind + origin
  });

  it("ignores its own messages (origin), unknown kinds and malformed messages", async () => {
    const server = new FakeServer();
    const a = replica(server, "pod-a");
    const clear = vi.fn();
    a.bus.onInvalidate("settings", clear);
    a.bus.listen();
    await until(() => a.bus.status().state === "connected");

    a.bus.broadcast("settings");
    await until(() => server.published.length === 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(clear).toHaveBeenCalledTimes(1); // the local clear only; the echo from Valkey is ignored

    const sub = a.conns.subscriber!;
    sub.emit("message", CHANNEL, JSON.stringify({ kind: "settings", origin: "pod-a" }));
    sub.emit("message", CHANNEL, JSON.stringify({ kind: "users", origin: "pod-b" }));
    sub.emit("message", CHANNEL, "not json");
    sub.emit("message", CHANNEL, "null");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(renderCacheBus().join("\n")).not.toContain('kind="users"');

    sub.emit("message", CHANNEL, JSON.stringify({ kind: "settings", origin: "pod-b" }));
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("re-subscribes after a reconnect and receives again", async () => {
    const server = new FakeServer();
    const a = replica(server, "pod-a");
    const b = replica(server, "pod-b");
    const clearB = vi.fn();
    b.bus.onInvalidate("categories", clearB);
    a.bus.listen();
    b.bus.listen();
    await until(() => b.bus.status().state === "connected" && a.bus.status().state === "connected");
    expect(b.conns.subscriber!.subscribeCalls).toBe(1);

    server.stop();
    expect(b.bus.status()).toMatchObject({ state: "disconnected", subscriber: false });
    server.start();
    await until(() => b.bus.status().state === "connected" && a.bus.status().state === "connected");
    await until(() => b.conns.subscriber!.channels.has(CHANNEL));
    expect(b.conns.subscriber!.subscribeCalls).toBe(2);

    a.bus.broadcast("categories");
    await until(() => clearB.mock.calls.length === 1);
  });
});

describe("cache bus: page purges (admin bar → Cache)", () => {
  it("carries one public path, or none for every page, to the other replica", async () => {
    const server = new FakeServer();
    const a = replica(server, "pod-a");
    const b = replica(server, "pod-b");
    const purgedA = vi.fn();
    const purgedB = vi.fn();
    a.bus.onPagePurge(purgedA);
    b.bus.onPagePurge(purgedB);
    a.bus.listen();
    b.bus.listen();
    await until(() => a.bus.status().state === "connected" && b.bus.status().state === "connected");

    expect(a.bus.broadcastPage("/blog/my-post/")).toBe(true);
    expect(purgedA).toHaveBeenCalledWith("/blog/my-post"); // local, synchronous, trailing slash dropped
    await until(() => purgedB.mock.calls.length === 1);
    expect(purgedB).toHaveBeenCalledWith("/blog/my-post");
    expect(JSON.parse(server.published[0]!)).toEqual({ kind: "page", origin: "pod-a", path: "/blog/my-post" });

    a.bus.broadcastPage(null);
    await until(() => purgedB.mock.calls.length === 2);
    expect(purgedB).toHaveBeenLastCalledWith(null);
    expect(JSON.parse(server.published[1]!)).toEqual({ kind: "page", origin: "pod-a" });
  });

  it("refuses paths that are not public URL paths, before sending and on arrival", async () => {
    const server = new FakeServer();
    const a = replica(server, "pod-a");
    const purged = vi.fn();
    a.bus.onPagePurge(purged);
    a.bus.listen();
    await until(() => a.bus.status().state === "connected");

    for (const bad of ["blog", "//evil.example/x", "/a/../b", "/x?y=1", "/x#y", `/${"a".repeat(600)}`, "/ü"]) expect(a.bus.broadcastPage(bad)).toBe(false);
    expect(purged).not.toHaveBeenCalled();
    expect(server.published).toHaveLength(0);

    const sub = a.conns.subscriber!;
    sub.emit("message", CHANNEL, JSON.stringify({ kind: "page", origin: "pod-b", path: "/../etc" }));
    sub.emit("message", CHANNEL, JSON.stringify({ kind: "page", origin: "pod-b", path: 42 }));
    expect(purged).not.toHaveBeenCalled();
    sub.emit("message", CHANNEL, JSON.stringify({ kind: "page", origin: "pod-b", path: "/news" }));
    expect(purged).toHaveBeenCalledWith("/news");
    expect(renderCacheBus().join("\n")).toContain('kind="page"');
  });
});

describe("cache bus: refused SUBSCRIBE", () => {
  it("is not reported connected, retries with backoff on the same connection (no reconnect loop), recovers", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const server = new FakeServer();
    const b = replica(server, "pod-b");
    let refuse = true;
    const ready = vi.fn();
    b.bus.listen();
    await until(() => b.bus.status().subscriber);
    const sub = b.conns.subscriber!;
    sub.on("ready", ready);
    const real = sub.subscribe.bind(sub);
    let attempts = 0;
    sub.subscribe = async (ch: string) => {
      attempts += 1;
      if (refuse) throw new Error("NOPERM No permissions to access a channel");
      return real(ch);
    };
    sub.drop();
    sub.establish(); // a reconnect: subscribes with the refusing server
    await new Promise((r) => setTimeout(r, 1200)); // backoff(1) = 250–500 ms, backoff(2) = 500–1000 ms
    expect(b.bus.status().subscriber).toBe(false);
    expect(attempts).toBeGreaterThanOrEqual(2); // retried…
    expect(attempts).toBeLessThan(8); // …with backoff, not in a tight loop
    expect(ready).toHaveBeenCalledTimes(1); // on the same connection: no reconnects
    expect(renderCacheBus().join("\n")).toContain('cache_bus_connected{role="subscriber"} 0');

    refuse = false;
    await until(() => b.bus.status().subscriber, 5000);
    expect(sub.channels.has(CHANNEL)).toBe(true);
  });
});

describe("cache bus: Redis down or unset never reaches a request", () => {
  it("unset: local only, no connection attempted", () => {
    const connect = vi.fn();
    const bus = createCacheBus({ url: () => null, connect });
    buses.push(bus);
    const clear = vi.fn();
    bus.onInvalidate("integrations", clear);
    bus.listen();
    bus.broadcast("integrations");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(bus.status()).toEqual({ state: "not configured", publisher: false, subscriber: false, source: null });
  });

  it("server down: broadcast returns at once, clears locally, counts errors and logs at most once a minute", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const server = new FakeServer();
    server.up = false;
    const a = replica(server, "pod-a");
    const clear = vi.fn();
    a.bus.onInvalidate("practice", clear);
    a.bus.listen();

    for (let i = 0; i < 20; i++) expect(() => a.bus.broadcast("practice")).not.toThrow();
    expect(clear).toHaveBeenCalledTimes(20);
    await new Promise((r) => setTimeout(r, 300)); // publishWaitMs elapses; publishes give up
    expect(a.bus.status().state).toBe("disconnected");
    const warnings = warn.mock.calls.filter(([msg]) => String(msg).startsWith("cache bus"));
    expect(warnings.length).toBeLessThanOrEqual(2); // one per role
    expect(renderCacheBus().join("\n")).toMatch(/cache_bus_errors_total\{role="publisher"\} \d+/);
  });

  it("a connector that throws or never answers does not throw into the caller", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const throwing = createCacheBus({ url: () => URL, heartbeatMs: 0, connect: async () => Promise.reject(new Error("boom")) });
    const hanging = createCacheBus({ url: () => URL, heartbeatMs: 0, connect: () => new Promise<never>(() => {}) });
    buses.push(throwing, hanging);
    for (const bus of [throwing, hanging]) {
      const clear = vi.fn();
      bus.onInvalidate("content", clear);
      expect(() => bus.listen()).not.toThrow();
      const t = performance.now();
      bus.broadcast("content");
      expect(performance.now() - t).toBeLessThan(50);
      expect(clear).toHaveBeenCalledTimes(1);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(throwing.status().state).toBe("disconnected");
  });

  it("a failing cache handler does not stop the others", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const bus = createCacheBus({ url: () => null });
    buses.push(bus);
    const ok = vi.fn();
    bus.onInvalidate("content", () => {
      throw new Error("bad handler");
    });
    bus.onInvalidate("content", ok);
    expect(() => bus.broadcast("content")).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("cache bus: metrics", () => {
  it("exports published/received counters by kind and a connected gauge per role", async () => {
    const server = new FakeServer();
    const a = replica(server, "pod-a");
    const b = replica(server, "pod-b");
    const clearB = vi.fn();
    b.bus.onInvalidate("integrations", clearB);
    a.bus.listen();
    b.bus.listen();
    await until(() => a.bus.status().state === "connected" && b.bus.status().state === "connected");
    a.bus.broadcast("integrations");
    await until(() => clearB.mock.calls.length === 1);
    const text = renderCacheBus().join("\n");
    expect(text).toMatch(/cache_bus_published_total\{kind="integrations"\} \d+/);
    expect(text).toMatch(/cache_bus_received_total\{kind="integrations"\} \d+/);
    expect(text).toContain('cache_bus_connected{role="subscriber"} 1');
    expect(text).toContain('cache_bus_connected{role="publisher"} 1');
  });
});

describe("cache bus module", () => {
  it("shares handlers between separate copies of the module (instrumentation vs app bundles)", async () => {
    // The app registers its caches in one module instance…
    const app = await import("@/lib/cache-bus");
    const cleared = vi.fn();
    app.onInvalidate("integrations", cleared);

    // …while instrumentation.ts (the listener) loads its own copy.
    vi.resetModules();
    const listener = await import("@/lib/cache-bus");
    expect(listener).not.toBe(app);

    listener.broadcastInvalidate("integrations");
    expect(cleared).toHaveBeenCalledTimes(1);
  });
});
