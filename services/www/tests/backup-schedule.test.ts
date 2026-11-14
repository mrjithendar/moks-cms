import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }) }));

// Backups write to an in-memory "bucket" instead of R2.
const bucket = new Map<string, Buffer>();
vi.mock("@/lib/storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage")>()),
  storageReady: async () => true,
  bucketOps: async (name = "") => ({
    bucket: name || "media",
    sameAsMedia: !name,
    mediaIsPublic: false,
    put: async (key: string, body: Buffer) => void bucket.set(`${name || "media"}/${key}`, body),
    list: async (prefix: string) =>
      [...bucket.keys()].filter((k) => k.startsWith(`${name || "media"}/${prefix}`)).map((k) => ({ key: k.slice((name || "media").length + 1), size: bucket.get(k)!.length, lastModified: null })),
    remove: async (key: string) => void bucket.delete(`${name || "media"}/${key}`),
    get: async (key: string) => bucket.get(`${name || "media"}/${key}`)!,
  }),
}));

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const HOUR = 3_600_000;
const DAILY = 20 * HOUR;
let db: Db;

beforeEach(async () => {
  bucket.clear();
  db = await freshDb();
  await db.insert(schema.user).values({ id: admin.id, name: "Admin", email: admin.label, role: "admin" });
});
afterEach(() => setDbForTests(undefined));

describe("scheduled backups", () => {
  it("are claimed once per interval, whichever replica asks", async () => {
    const { claimScheduledRun, recentRuns } = await import("@/lib/backups");
    const now = new Date("2026-11-14T21:00:00Z");
    const first = await claimScheduledRun(DAILY, now);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // The other replica ticks moments later, and again at the next 15-minute check: the run is taken.
    expect(await claimScheduledRun(DAILY, new Date(now.getTime() + 500))).toBeNull();
    expect(await claimScheduledRun(DAILY, new Date(now.getTime() + 15 * 60_000))).toBeNull();
    // The next day's run can be claimed again.
    const next = await claimScheduledRun(DAILY, new Date(now.getTime() + 24 * HOUR));
    expect(next).toMatch(/^[0-9a-f-]{36}$/);
    expect(next).not.toBe(first);
    const runs = await recentRuns();
    expect(runs.map((r) => r.id)).toEqual([next, first]);
    expect(runs.every((r) => r.trigger === "scheduled" && r.status === "running" && r.triggeredBy === "scheduler")).toBe(true);
  });

  it("run into the row that was claimed, without adding another", async () => {
    const { claimScheduledRun, recentRuns, runBackup, saveDestination, saveGeneral } = await import("@/lib/backups");
    await saveGeneral(admin, { schedule: "daily", hourUtc: "21", retention: "7", passphrase: "correct horse battery staple", encrypt: "on" });
    await saveDestination(admin, { enabled: true, bucket: "" });
    const runId = await claimScheduledRun(DAILY);
    expect(await runBackup("scheduled", undefined, runId!)).toMatchObject({ status: "success" });
    const runs = await recentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, trigger: "scheduled", status: "success", triggeredBy: "scheduler" });
    expect(runs[0]!.finishedAt).toBeInstanceOf(Date);
    expect([...bucket.keys()].filter((k) => k.includes("jithendar-backup-"))).toHaveLength(1);
  });
});
