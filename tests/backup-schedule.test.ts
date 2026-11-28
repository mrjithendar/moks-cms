import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
import { fakeBuckets } from "./fake-backup-store";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }) }));

const fake = fakeBuckets();
vi.mock("@/lib/backup/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/backup/store")>()),
  backupStore: async (b: string) => fake.store(b || "media"),
  mediaStore: async () => fake.store("media"),
}));
vi.mock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("@/lib/storage")>()), storageReady: async () => true }));

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
let db: Db;

beforeEach(async () => {
  fake.buckets.clear();
  db = await freshDb();
  await db.insert(schema.user).values({ id: admin.id, name: "Admin", email: admin.label, role: "admin" });
  const { saveDestination, saveGeneral } = await import("@/lib/backups");
  await saveGeneral(admin, { schedule: "daily", hourUtc: "21", scheduleType: "database", retention: "7", encrypt: "on" });
  await saveDestination(admin, { enabled: true, bucket: "" });
});
afterEach(() => setDbForTests(undefined));

const scheduled = async () => rowsOf<{ id: string; status: string; backup_type: string }>(await db.execute(sql`select id, status, backup_type from backup_run where trigger = 'scheduled' order by started_at`));

describe("the built-in backup schedule", () => {
  it("queues one backup per interval at or after the hour, whichever replica ticks", async () => {
    const { backupScheduleTick } = await import("@/lib/backup/service");
    expect(await backupScheduleTick(new Date("2026-11-14T20:59:00Z"))).toBeNull(); // before the hour
    const first = await backupScheduleTick(new Date("2026-11-14T21:00:00Z"));
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // Another replica ticks a moment later, and again at the next tick: the run is taken (and still queued).
    expect(await backupScheduleTick(new Date("2026-11-14T21:00:01Z"))).toBeNull();
    expect(await backupScheduleTick(new Date("2026-11-14T21:15:00Z"))).toBeNull();
    expect(await scheduled()).toEqual([{ id: first, status: "pending", backup_type: "database" }]);
    const jobs = rowsOf<{ kind: string; dedupe_key: string; max_attempts: number }>(await db.execute(sql`select kind, dedupe_key, max_attempts from job`));
    expect(jobs).toEqual([{ kind: "backup", dedupe_key: "backup-operation", max_attempts: 3 }]);
  });

  it("runs the queued backup into the row it claimed; the next day queues the next", async () => {
    const { backupScheduleTick, backupWorkerTick } = await import("@/lib/backup/service");
    const runId = await backupScheduleTick(new Date("2026-11-14T21:00:00Z"));
    expect(runId).toBeTruthy();
    await backupWorkerTick(new Date("2026-11-14T21:00:30Z"));
    const [run] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, runId!));
    expect(run).toMatchObject({ status: "completed", trigger: "scheduled", triggeredBy: "schedule", backupType: "database" });
    expect([...fake.bucket("media").keys()].filter((k) => k.endsWith("-database.zip"))).toHaveLength(1);
    // The interval counts from when the backup actually ran (the handler records its start).
    const nextDay = new Date(Date.now() + 2 * 86_400_000);
    nextDay.setUTCHours(10, 0, 0, 0);
    expect(await backupScheduleTick(nextDay)).toBeNull(); // before the hour
    nextDay.setUTCHours(21, 0, 0, 0);
    expect(await backupScheduleTick(nextDay)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stands down while a CrewAI schedule runs backup_flow: one scheduler for backups, never two", async () => {
    const { backupScheduleTick } = await import("@/lib/backup/service");
    await db.execute(sql`insert into seo_flow_schedules (name, flow_name, description, cron, timezone, enabled) values ('website-full-backup', 'backup_flow', 'Daily full backup', '0 2 * * *', 'Asia/Kolkata', true)`);
    expect(await backupScheduleTick(new Date("2026-11-14T22:00:00Z"))).toBeNull();
    await db.execute(sql`update seo_flow_schedules set enabled = false where name = 'website-full-backup'`);
    expect(await backupScheduleTick(new Date("2026-11-14T22:00:00Z"))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("waits while another backup operation is queued or running", async () => {
    const { backupScheduleTick, requestBackup } = await import("@/lib/backup/service");
    await requestBackup("full", "manual", { actor: admin, label: admin.label });
    expect(await backupScheduleTick(new Date("2026-11-14T22:00:00Z"))).toBeNull();
  });

  it("does nothing when it is off", async () => {
    const { saveGeneral } = await import("@/lib/backups");
    const { backupScheduleTick } = await import("@/lib/backup/service");
    await saveGeneral(admin, { schedule: "off", hourUtc: "21", retention: "7", encrypt: "on" });
    expect(await backupScheduleTick(new Date("2026-11-14T22:00:00Z"))).toBeNull();
  });
});
