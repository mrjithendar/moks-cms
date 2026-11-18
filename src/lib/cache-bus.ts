import { log } from "./log";
import { recordCacheBusError, recordCacheBusPublished, recordCacheBusReceived, setCacheBusConnected } from "./metrics";

/**
 * Cross-replica cache invalidation. Per-process caches register here; an invalidation clears them locally and tells
 * the other replicas over Redis/Valkey pub/sub (channel `jithendar:invalidate`).
 *
 * Connection: CACHE_BUS_REDIS_URL (the shared Valkey, ACL user `site-cachebus`: PUBLISH/SUBSCRIBE on `jithendar:*`
 * only, no keys; docs/redis-site-cachebus.md). Only this module may read that variable (tests/cache-bus-env.test.ts):
 * REDIS_URL (src/lib/redis.ts) would also move sessions, rate limits and API keys to Redis, which the site does not do.
 * Without CACHE_BUS_REDIS_URL the bus falls back to REDIS_URL if that is set, else it is local only.
 *
 * Rules: messages are `{kind, origin}` and nothing else (no content, user data or secrets: channels are shared by
 * every Valkey tenant). Redis is never awaited by a request: publishing is fire-and-forget with short timeouts and no
 * offline queue; when Valkey is down or unset, caches converge within their TTL as before.
 */
export const KINDS = ["content", "categories", "settings", "integrations", "practice"] as const;
export type Kind = (typeof KINDS)[number];
export type Role = "publisher" | "subscriber";
export const CHANNEL = "jithendar:invalidate";

/** What the bus uses of an ioredis client; tests pass an in-memory fake. */
export interface BusConnection {
  readonly status: string;
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  ping(): Promise<string>;
  disconnect(reconnect?: boolean): void;
  on(event: "ready" | "close" | "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  once(event: "ready", listener: () => void): unknown;
  off(event: "ready", listener: () => void): unknown;
}
export type Connector = (role: Role, url: string) => Promise<BusConnection>;

export type BusState = "not configured" | "connected" | "connecting" | "disconnected";
export type BusStatus = { state: BusState; publisher: boolean; subscriber: boolean; source: "CACHE_BUS_REDIS_URL" | "REDIS_URL" | null };

type Options = {
  /** Read lazily, at the first connection. */
  url?: () => { url: string; source: "CACHE_BUS_REDIS_URL" | "REDIS_URL" } | null;
  connect?: Connector;
  origin?: string;
  /** PING both connections this often, so HAProxy's/Envoy's 1 h idle timeout never cuts a quiet subscriber. */
  heartbeatMs?: number;
  /** How long a publish waits for a connection that is (re)connecting before giving up (TTL takes over). */
  publishWaitMs?: number;
  /** At most one warning per role per this interval. */
  logEveryMs?: number;
};

function busUrl(): { url: string; source: "CACHE_BUS_REDIS_URL" | "REDIS_URL" } | null {
  const own = process.env.CACHE_BUS_REDIS_URL?.trim();
  if (own) return { url: own, source: "CACHE_BUS_REDIS_URL" };
  const shared = process.env.REDIS_URL?.trim();
  return shared ? { url: shared, source: "REDIS_URL" } : null;
}

/** Exponential backoff with jitter, 250 ms → 30 s; ioredis keeps reconnecting for as long as the process runs. */
export function backoff(times: number): number {
  const base = Math.min(30_000, 250 * 2 ** Math.min(times, 7));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

const ioredisConnector: Connector = async (role, url) => {
  const { Redis } = await import("ioredis");
  const pod = (process.env.HOSTNAME ?? "local").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) || "local";
  const client = new Redis(url, {
    connectionName: `jithendar-com:cachebus:${role}:${pod}`,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
    retryStrategy: backoff,
    // The ACL allows only pub/sub, PING and CLIENT SETNAME: no INFO ready check, no CLIENT SETINFO.
    enableReadyCheck: false,
    disableClientInfo: true,
    // Re-subscribed by the bus on every "ready" (testable, and independent of client internals).
    autoResubscribe: false,
  });
  return client as unknown as BusConnection;
};

export function createCacheBus(opts: Options = {}) {
  const resolveUrl = opts.url ?? busUrl;
  const connect = opts.connect ?? ioredisConnector;
  const origin = opts.origin ?? crypto.randomUUID();
  const heartbeatMs = opts.heartbeatMs ?? 5 * 60_000;
  const publishWaitMs = opts.publishWaitMs ?? 1500;
  const logEveryMs = opts.logEveryMs ?? 60_000;

  const handlers = new Map<Kind, Set<() => void>>();
  const conns: Partial<Record<Role, Promise<BusConnection | null>>> = {};
  const up: Record<Role, boolean> = { publisher: false, subscriber: false };
  // First connect of the publisher: one shared wait, so a burst of publishes adds one listener, not one each.
  const firstReady = new WeakMap<BusConnection, Promise<boolean>>();
  const everReady = new WeakSet<BusConnection>();
  const lastLog: Partial<Record<string, number>> = {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let config: ReturnType<typeof busUrl> | undefined;

  const target = () => (config === undefined ? (config = resolveUrl()) : config);

  function warn(key: string, msg: string, fields: Record<string, unknown> = {}) {
    const now = Date.now();
    if (now - (lastLog[key] ?? -Infinity) < logEveryMs) return;
    lastLog[key] = now;
    log.warn(msg, { event: "cache_bus_" + key.replace(/[^a-z]/g, "_"), dependency: "redis", ...fields });
  }

  function failed(role: Role, err: unknown) {
    recordCacheBusError(role);
    warn(role, `cache bus ${role} error; caches fall back to their TTL`, { operation: role, err });
  }

  function setUp(role: Role, value: boolean) {
    up[role] = value;
    setCacheBusConnected(role, value);
  }

  function clearLocal(kind: Kind) {
    for (const clear of handlers.get(kind) ?? []) {
      try {
        clear();
      } catch (err) {
        log.warn("cache invalidation handler failed", { event: "cache_bus_handler_failed", kind, err });
      }
    }
  }

  function onMessage(_channel: string, message: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // malformed: ignored
    }
    const { kind, origin: from } = (parsed ?? {}) as { kind?: unknown; origin?: unknown };
    if (typeof from !== "string" || from === origin) return; // own echo
    if (!KINDS.includes(kind as Kind)) return; // unknown kind: never becomes a metric label
    recordCacheBusReceived(kind as Kind);
    clearLocal(kind as Kind);
  }

  /** One connection per role, created on first use. Never rejects. */
  function connection(role: Role): Promise<BusConnection | null> {
    const t = target();
    if (!t) return Promise.resolve(null);
    conns[role] ??= (async () => {
      try {
        const c = await connect(role, t.url);
        setUp(role, false);
        // The subscriber counts as connected only once SUBSCRIBE succeeded (cache_bus_connected, the alert). A refused
        // SUBSCRIBE (e.g. NOPERM from a wrong ACL) is retried with backoff on the same connection, never in a loop.
        let subscribeAttempt = 0;
        const subscribe = () => {
          if (c.status !== "ready") return; // the next "ready" subscribes
          c.subscribe(CHANNEL).then(
            () => {
              subscribeAttempt = 0;
              if (c.status === "ready") setUp(role, true); // not if the connection dropped meanwhile
            },
            (err: unknown) => {
              failed(role, err);
              setTimeout(subscribe, backoff(++subscribeAttempt)).unref?.();
            },
          );
        };
        c.on("ready", () => {
          everReady.add(c);
          if (role === "subscriber") subscribe();
          else setUp(role, true);
        });
        c.on("close", () => setUp(role, false));
        c.on("end", () => setUp(role, false));
        c.on("error", (err) => failed(role, err));
        if (role === "subscriber") c.on("message", onMessage);
        // ioredis keeps retrying after a failed first connect (retryStrategy); the rejection is only logged.
        c.connect().catch((err: unknown) => failed(role, err));
        return c;
      } catch (err) {
        failed(role, err);
        return null;
      }
    })();
    return conns[role];
  }

  /**
   * Ready now: publish. Still on its first connect (a publish right after start): wait up to publishWaitMs, shared by
   * every publish in that window. Was connected and dropped: fail at once; the TTL covers this invalidation.
   */
  function whenReady(c: BusConnection): Promise<boolean> {
    if (c.status === "ready") return Promise.resolve(true);
    if (everReady.has(c)) return Promise.resolve(false);
    let wait = firstReady.get(c);
    if (!wait) {
      wait = waitReady(c, publishWaitMs);
      firstReady.set(c, wait);
      void wait.then(() => firstReady.delete(c));
    }
    return wait;
  }

  function waitReady(c: BusConnection, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        c.off("ready", onReady);
        resolve(ok);
      };
      const onReady = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      c.once("ready", onReady);
    });
  }

  async function publish(kind: Kind) {
    try {
      const c = await connection("publisher");
      if (!c) return;
      if (!(await whenReady(c))) throw new Error(`publisher not connected (${c.status})`);
      await c.publish(CHANNEL, JSON.stringify({ kind, origin }));
      recordCacheBusPublished(kind);
    } catch (err) {
      failed("publisher", err);
    }
  }

  function startHeartbeat() {
    if (heartbeat || heartbeatMs <= 0) return;
    heartbeat = setInterval(() => {
      for (const role of ["publisher", "subscriber"] as const) {
        void conns[role]?.then((c) => {
          if (c?.status !== "ready") return;
          c.ping().catch((err: unknown) => {
            failed(role, err);
            c.disconnect(true); // dead socket: reconnect now instead of waiting for TCP keepalive
          });
        });
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    origin,

    onInvalidate(kind: Kind, clear: () => void) {
      const set = handlers.get(kind) ?? new Set();
      set.add(clear);
      handlers.set(kind, set);
    },

    /** Clears this process's caches now and tells the other replicas. Synchronous for the caller; never throws. */
    broadcast(kind: Kind) {
      clearLocal(kind);
      if (target()) void publish(kind);
    },

    /** Starts both connections in the background (server start). Returns at once; never throws. */
    listen() {
      if (!target()) return;
      void connection("subscriber");
      void connection("publisher");
      startHeartbeat();
    },

    status(): BusStatus {
      const t = target();
      if (!t) return { state: "not configured", publisher: false, subscriber: false, source: null };
      const started = Boolean(conns.subscriber || conns.publisher);
      const state: BusState = !started ? "connecting" : up.subscriber && up.publisher ? "connected" : "disconnected";
      return { state, ...up, source: t.source };
    },

    /** Tests and shutdown. */
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      for (const role of ["publisher", "subscriber"] as const) {
        // A connection still being created is not waited for longer than a moment.
        const c = await Promise.race([conns[role], new Promise<null>((r) => setTimeout(() => r(null), 100))]);
        c?.disconnect(false);
        delete conns[role];
        setUp(role, false);
      }
    },
  };
}

export type CacheBus = ReturnType<typeof createCacheBus>;

// On globalThis: instrumentation.ts (which runs the listener) and the app routes are separate bundles, each with its
// own copy of this module. Per-module state would leave the listener clearing an empty map.
const g = globalThis as unknown as { __cacheBus?: CacheBus };
const bus = (g.__cacheBus ??= createCacheBus());

export function onInvalidate(kind: Kind, clear: () => void) {
  bus.onInvalidate(kind, clear);
}

export function broadcastInvalidate(kind: Kind) {
  bus.broadcast(kind);
}

/** Called once at server start (instrumentation.ts). */
export async function listenForInvalidations() {
  bus.listen();
}

export function cacheBusStatus(): BusStatus {
  return bus.status();
}
