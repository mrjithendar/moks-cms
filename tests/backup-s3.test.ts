import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
// @ts-expect-error a plain ES module without types (tests/s3-emulator.mjs)
import { startS3Emulator } from "./s3-emulator.mjs";

/**
 * Site backups through the real S3 client (lib/backup/store.ts, lib/storage.ts) against an S3 API emulator
 * (tests/s3-emulator.mjs), the way R2 is reached: path-style requests to a custom endpoint. A file of 40 MB makes the
 * archive a multipart upload of several 16 MiB parts; the archive is read back by byte range to verify it; a restore
 * puts the file back with a multipart upload of its own.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }) }));

type Emulator = { port: number; buckets: Map<string, Map<string, { body: Buffer; contentType: string }>>; uploads: Map<string, unknown>; close: () => Promise<void> };
let s3: Emulator;
let db: Db;
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const saved: Record<string, string | undefined> = {};
const ENV = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_BUCKET: "media", R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret" };
const big = Buffer.alloc(40 * 1024 * 1024);
for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i);
const bigKey = "jithendar/www/media/videos/2026/11/0f6f2f2e-1c1d-4e8a-9a4b-1f2e3d4c5b6a.mp4";

beforeAll(async () => {
  s3 = (await startS3Emulator(0)) as Emulator;
  for (const [k, v] of Object.entries({ ...ENV, R2_ENDPOINT: `http://127.0.0.1:${s3.port}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await s3.close();
});
beforeEach(async () => {
  s3.buckets.clear();
  db = await freshDb();
  await db.insert(schema.user).values({ id: admin.id, name: "Admin", email: admin.label, role: "admin" });
  const { putObject } = await import("@/lib/storage");
  await putObject(bigKey, big, { contentType: "video/mp4" });
  await putObject("jithendar/www/media/images/2026/11/a.png", Buffer.from("small"), { contentType: "image/png" });
});
afterEach(() => setDbForTests(undefined));

async function work() {
  const { runDueJobs } = await import("@/lib/jobs");
  const { backupJobHandler, BACKUP_JOB } = await import("@/lib/backup/service");
  await runDueJobs({ [BACKUP_JOB]: backupJobHandler }, new Date(), 1, { kinds: [BACKUP_JOB] });
}

describe("site backups on an S3 API (R2 path-style)", () => {
  it("stream a multipart archive, verify it by range reads, and restore a large file with a multipart upload", async () => {
    const { saveDestination, saveGeneral } = await import("@/lib/backups");
    await saveGeneral(admin, { schedule: "off", hourUtc: "21", retention: "5", encrypt: "on" });
    await saveDestination(admin, { enabled: true, bucket: "jithendar-backups" });
    const { requestBackup, requestRestore, requestVerify, listBackups } = await import("@/lib/backup/service");
    const id = (await requestBackup("full", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const [run] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, id));
    expect(run!.error).toBeNull();
    expect(run!.status).toBe("completed");
    const stored = s3.buckets.get("jithendar-backups")!.get(`jithendar/backups/${run!.filename}`)!;
    expect(stored.body.length).toBeGreaterThan(40 * 1024 * 1024); // the file, uncompressed (and encrypted)
    expect(createHash("sha256").update(stored.body).digest("hex")).toBe(run!.sha256);
    expect(s3.uploads.size).toBe(0);
    const { items } = await listBackups();
    expect(items.map((i) => i.name)).toEqual([run!.filename]);

    const v = await requestVerify(admin, run!.filename!);
    await work();
    const [verified] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, v.id));
    expect(verified!.status).toBe("completed");

    s3.buckets.get("media")!.delete(bigKey);
    const r = await requestRestore(admin, run!.filename!, { components: { database: true, uploads: true }, allowUnsigned: false, confirmation: "RESTORE" });
    await work();
    const [restored] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, r.id));
    expect(restored!.error).toBeNull();
    expect(restored!.status).toBe("completed");
    const back = s3.buckets.get("media")!.get(bigKey)!;
    expect(back.body.equals(big)).toBe(true);
    expect(back.contentType).toBe("video/mp4");
  }, 120_000);

  it("abort an unfinished upload an interrupted backup left behind", async () => {
    const { backupStore } = await import("@/lib/backup/store");
    const store = await backupStore("jithendar-backups");
    const mp = await store.multipart("jithendar/backups/jithendar-com-backup-2026-11-28-010000-full.zip", "application/zip");
    await mp.uploadPart(1, new Uint8Array(1024));
    expect(s3.uploads.size).toBe(1);
    expect(await store.abortIncomplete("jithendar/backups/")).toBe(1);
    expect(s3.uploads.size).toBe(0);
    expect(await store.head("jithendar/backups/jithendar-com-backup-2026-11-28-010000-full.zip")).toBeNull();
  });
});
