import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { enqueue, runDueJobs } from "@/lib/jobs";
import { auditRetentionDays, pruneOperationalTables } from "@/lib/retention";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(() => setDbForTests(undefined));

const NONE = { done: 0, retried: 0, failed: 0 };

describe("job queue claims", () => {
  it("claims one job at a time, oldest first: the jobs behind a slow one stay queued", async () => {
    const t0 = Date.now();
    for (const n of [1, 2, 3]) await enqueue("slow", { n }, { runAt: new Date(t0 - (4 - n) * 1000) });
    const seen: { n: unknown; running: number; queued: number }[] = [];
    const result = await runDueJobs(
      {
        slow: async (payload) => {
          const rows = await db.select().from(schema.job);
          seen.push({ n: payload.n, running: rows.filter((j) => j.status === "running").length, queued: rows.filter((j) => j.status === "queued").length });
        },
      },
      new Date(t0),
    );
    expect(result).toEqual({ done: 3, retried: 0, failed: 0 });
    // While a handler runs, only its own job is claimed: no other job's lock is ticking.
    expect(seen).toEqual([
      { n: 1, running: 1, queued: 2 },
      { n: 2, running: 1, queued: 1 },
      { n: 3, running: 1, queued: 0 },
    ]);
  });

  it("stops at the limit and leaves the rest for the next tick", async () => {
    for (const n of [1, 2, 3]) await enqueue("quick", { n });
    const later = new Date(Date.now() + 1000);
    expect(await runDueJobs({ quick: async () => undefined }, later, 2)).toEqual({ done: 2, retried: 0, failed: 0 });
    expect(await runDueJobs({ quick: async () => undefined }, later, 2)).toEqual({ done: 1, retried: 0, failed: 0 });
  });

  it("a worker whose claim was taken over cannot change the job any more", async () => {
    await enqueue("work", { x: 1 });
    let second = NONE;
    const first = await runDueJobs(
      {
        work: async () => {
          // The lock ran out while this handler was still busy; another replica hands the job back and finishes it.
          await db.execute(sql`update job set locked_until = now() - interval '1 minute'`);
          second = await runDueJobs({ work: async () => undefined }, new Date(Date.now() + 1000));
          throw new Error("the first worker failed afterwards");
        },
      },
      new Date(Date.now() + 1000),
    );
    expect(second).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(first).toEqual(NONE); // its failure was not recorded: the job is not its job any more
    const [job] = await db.select().from(schema.job);
    expect(job).toMatchObject({ status: "done", attempts: 2, lastError: null });
  });

  it("renews the lock while the handler runs", async () => {
    await enqueue("long", {});
    const t0 = new Date();
    const seen: { lockedUntil?: Date | null } = {};
    await runDueJobs(
      {
        long: async () => {
          await new Promise((r) => setTimeout(r, 150));
          seen.lockedUntil = (await db.select().from(schema.job))[0]!.lockedUntil;
        },
      },
      t0,
      10,
      { lockMs: 60_000, renewMs: 20 },
    );
    // Claimed until t0 + 60 s; the renewals during the 150 ms the handler took moved that forward.
    expect(seen.lockedUntil).toBeInstanceOf(Date);
    expect(seen.lockedUntil!.getTime()).toBeGreaterThan(t0.getTime() + 60_000);
    const [job] = await db.select().from(schema.job);
    expect(job!.status).toBe("done");
  });

  it("records whatever a handler throws, also when it is not an Error", async () => {
    await enqueue("odd", {});
    const result = await runDueJobs(
      {
        odd: async () => {
          await Promise.reject("plain string");
        },
      },
      new Date(Date.now() + 1000),
    );
    expect(result).toEqual({ done: 0, retried: 1, failed: 0 });
    expect((await db.select().from(schema.job))[0]).toMatchObject({ status: "queued", attempts: 1, lastError: "plain string" });
  });
});

describe("daily clean-up", () => {
  const now = new Date("2026-11-14T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("removes finished jobs after 30 days and expired rate-limit counters, and keeps everything still in use", async () => {
    await db.insert(schema.job).values([
      { kind: "indexnow", payload: {}, status: "done", finishedAt: daysAgo(40) },
      { kind: "indexnow", payload: {}, status: "failed", finishedAt: daysAgo(31) },
      { kind: "indexnow", payload: {}, status: "done", finishedAt: daysAgo(5) },
      { kind: "indexnow", payload: {}, status: "queued", runAt: daysAgo(90), createdAt: daysAgo(90) },
      { kind: "indexnow", payload: {}, status: "running", runAt: daysAgo(90), createdAt: daysAgo(90) },
    ]);
    await db.insert(schema.rateLimit).values([
      { id: "old", key: "old", count: 3, lastRequest: now.getTime() - 3 * 86_400_000 },
      { id: "day", key: "app:ask:ip:203.0.113.9:d", count: 3, lastRequest: now.getTime() - 86_400_000 + 1000 },
      { id: "new", key: "new", count: 1, lastRequest: now.getTime() },
    ]);
    await db.insert(schema.auditLog).values([
      { actor: "a@example.com", action: "auth.login", createdAt: daysAgo(400) },
      { actor: "a@example.com", action: "auth.login", createdAt: daysAgo(10) },
    ]);

    expect(await pruneOperationalTables(now, {})).toEqual({ jobs: 2, rateLimits: 1, auditLog: 0 });
    expect((await db.select().from(schema.job)).map((j) => j.status).sort()).toEqual(["done", "queued", "running"]);
    expect((await db.select().from(schema.rateLimit)).map((r) => r.id).sort()).toEqual(["day", "new"]);
    expect(await db.select().from(schema.auditLog)).toHaveLength(2); // the audit log is kept unless a retention is set
    expect(await pruneOperationalTables(now, {})).toEqual({ jobs: 0, rateLimits: 0, auditLog: 0 });
  });

  it("removes audit entries only when AUDIT_LOG_RETENTION_DAYS says so, and never with less than 30 days", async () => {
    await db.insert(schema.auditLog).values([
      { actor: "a@example.com", action: "auth.login", createdAt: daysAgo(400) },
      { actor: "a@example.com", action: "auth.login", createdAt: daysAgo(10) },
    ]);
    expect(auditRetentionDays({})).toBeNull();
    expect(auditRetentionDays({ AUDIT_LOG_RETENTION_DAYS: "7" })).toBeNull();
    expect(auditRetentionDays({ AUDIT_LOG_RETENTION_DAYS: "abc" })).toBeNull();
    expect(auditRetentionDays({ AUDIT_LOG_RETENTION_DAYS: "365" })).toBe(365);
    expect((await pruneOperationalTables(now, { AUDIT_LOG_RETENTION_DAYS: "7" })).auditLog).toBe(0);
    expect((await pruneOperationalTables(now, { AUDIT_LOG_RETENTION_DAYS: "365" })).auditLog).toBe(1);
    expect(await db.select().from(schema.auditLog)).toHaveLength(1);
  });
});
