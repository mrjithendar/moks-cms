import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type FileEntry } from "@zip.js/zip.js";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { Actor } from "@/lib/posts";
import { seal } from "@/lib/secrets";
import { freshDb } from "./db-helpers";
import { fakeBuckets } from "./fake-backup-store";

/**
 * The backup flow's side in the web app (lib/backup/callbacks.ts, D-108): the SEO agent's backup_flow queues a backup
 * through POST /internal/seo-agent/backups/start, follows it, and asks for the report email. Plus Admin → Backups →
 * Download: an encrypted archive comes out as a plain zip, streamed.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }) }));
const fake = fakeBuckets();
vi.mock("@/lib/backup/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/backup/store")>()),
  backupStore: async (b: string) => fake.store(b || "media"),
  mediaStore: async () => fake.store("media"),
}));
vi.mock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("@/lib/storage")>()), storageReady: async () => true }));
const session = { user: null as null | { id: string; role: string; email: string; demo?: boolean } };
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), getSessionUser: async () => session.user }));

const TOKEN = "t".repeat(40);
const env = { SEO_AGENT_CALLBACK_TOKEN: TOKEN };
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const FLOW_RUN = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
let db: Db;

async function call(method: string, path: string, body?: unknown) {
  const { handleCallback } = await import("@/lib/seo-agent/internal-server");
  return handleCallback(method, `/internal/seo-agent${path}`, `Bearer ${TOKEN}`, body, env);
}

async function work() {
  const { runDueJobs } = await import("@/lib/jobs");
  const { backupJobHandler, BACKUP_JOB } = await import("@/lib/backup/service");
  await runDueJobs({ [BACKUP_JOB]: backupJobHandler }, new Date(), 1, { kinds: [BACKUP_JOB] });
}

beforeEach(async () => {
  fake.buckets.clear();
  db = await freshDb();
  await db.insert(schema.user).values({ id: admin.id, name: "Admin", email: admin.label, role: "admin" });
  await db.insert(schema.page).values({ slug: "about", title: "About", description: "About", body: "Hello" });
  await db.insert(schema.setting).values({ key: "integrations", value: { gemini: { apiKey: seal("gemini-secret") } } });
  await fake.store("media").put("jithendar/www/media/images/2026/11/a.png", Buffer.from("png-bytes"), "image/png");
  session.user = null;
});
afterEach(() => setDbForTests(undefined));

async function configure() {
  const { saveDestination, saveGeneral } = await import("@/lib/backups");
  await saveGeneral(admin, { schedule: "off", hourUtc: "21", retention: "5", encrypt: "on" });
  await saveDestination(admin, { enabled: true, bucket: "" });
}

describe("the backup flow's callbacks", () => {
  it("refuse a request without the callback token", async () => {
    const { handleCallback } = await import("@/lib/seo-agent/internal-server");
    expect((await handleCallback("POST", "/internal/seo-agent/backups/start", "Bearer wrong", {}, env)).status).toBe(401);
  });

  it("say backup_not_configured while no destination is on", async () => {
    const r = await call("POST", "/backups/start", { type: "full", flowRunId: FLOW_RUN });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "backup_not_configured" });
  });

  it("queue the same backup an admin's Back up now makes, follow it, and refuse a second one at once", async () => {
    await configure();
    const start = await call("POST", "/backups/start", { type: "full", flowRunId: FLOW_RUN });
    expect(start.status).toBe(200);
    const backup = (start.body as { started: true; backup: { id: string; status: string; ref: string } }).backup;
    expect(start.body).toMatchObject({ started: true, backup: { status: "pending", ref: FLOW_RUN, type: "full" } });
    expect((await call("POST", "/backups/start", { type: "database" })).body).toMatchObject({ started: false, reason: "busy", active: { id: backup.id } });
    await work();
    const done = await call("GET", `/backups/runs/${backup.id}`);
    expect(done.status).toBe(200);
    const v = done.body as { filename: string; location: string; sizeBytes: number; storage: unknown };
    expect(v).toMatchObject({ status: "completed", type: "full", verification: { ok: true, signature: "valid" }, database: { ok: true }, uploads: { ok: true, files: 1 } });
    expect(v.filename).toMatch(/^jithendar-com-backup-.*-full\.zip$/);
    expect(v.location).toBe(`media/jithendar/backups/${v.filename}`);
    expect(v.sizeBytes).toBeGreaterThan(0);
    expect(v.storage).toMatchObject({ backups: 1 });
    const [row] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, backup.id));
    expect(row).toMatchObject({ trigger: "flow", triggeredBy: "CrewAI flow backup_flow", requestedByRef: FLOW_RUN });
    expect((await call("GET", "/backups/runs/not-a-uuid")).status).toBe(404);
  });

  it("email a concise report (no contents, no credentials) with the schedule's name", async () => {
    await configure();
    await db.execute(sql`insert into seo_flow_schedules (name, flow_name, description, cron, timezone, enabled, last_run_id) values ('website-full-backup', 'backup_flow', 'Daily', '0 2 * * *', 'Asia/Kolkata', true, ${FLOW_RUN}::uuid)`);
    const id = ((await call("POST", "/backups/start", { flowRunId: FLOW_RUN })).body as { backup: { id: string } }).backup.id;
    await work();
    const sent: { subject: string; text: string }[] = [];
    const { backupNotifyCallback } = await import("@/lib/backup/callbacks");
    const r = await backupNotifyCallback({ backupId: id, flowRunId: FLOW_RUN }, async (subject, text) => {
      sent.push({ subject, text });
      return true;
    });
    expect(r.sent).toBe(true);
    expect(sent[0]!.subject).toMatch(/^Backup completed: website-full-backup \(jithendar-com-backup-.*-full\.zip\)$/);
    for (const line of ["Job: website-full-backup", "Status: completed", "Database: backed up", "Files: backed up (1 files", "Validation: passed", "Stored at: media/jithendar/backups/"]) expect(sent[0]!.text).toContain(line);
    for (const secret of ["gemini-secret", "Hello", "admin@example.com"]) expect(sent[0]!.text).not.toContain(secret);
    // Without email set up, the report is not sent and the flow is told why.
    const off = await backupNotifyCallback({ backupId: id }, async () => false);
    expect(off).toMatchObject({ sent: false });
  });

  it("the flow is in the catalogue the console lists, and schedulable", async () => {
    const { SCHEDULABLE_FLOWS, flowInfo } = await import("@/lib/crewai/flows");
    expect(SCHEDULABLE_FLOWS).toContain("backup_flow");
    expect(flowInfo("backup_flow")).toMatchObject({ label: "Website backup" });
  });
});

describe("Admin → Backups → Download", () => {
  it("streams an encrypted archive as a plain zip any tool opens; admins only, never a demo account", async () => {
    await configure();
    const { requestBackup } = await import("@/lib/backup/service");
    const run = await requestBackup("full", "manual", { actor: admin, label: admin.label });
    await work();
    const [row] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, run.id));
    const name = row!.filename!;
    const { GET } = await import("@/app/api/admin/backup/route");
    const url = `https://jithendar.com/api/admin/backup?file=${encodeURIComponent(name)}`;
    expect((await GET(new Request(url))).status).toBe(403);
    session.user = { id: "demo", role: "admin", email: "demo@example.com", demo: true };
    expect((await GET(new Request(url))).status).toBe(403);
    session.user = { id: admin.id, role: "admin", email: admin.label };
    expect((await GET(new Request("https://jithendar.com/api/admin/backup?file=../../etc/passwd"))).status).toBe(400);
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(name);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const zip = new ZipReader(new Uint8ArrayReader(bytes));
    const entries = (await zip.getEntries()) as FileEntry[];
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.some((e) => e.encrypted)).toBe(false);
    const page = entries.find((e) => e.filename.endsWith("/database/tables/page.jsonl"))!;
    expect(Buffer.from(await page.getData(new Uint8ArrayWriter())).toString()).toContain('"body": "Hello"');
    const png = entries.find((e) => e.filename.endsWith("/uploads/jithendar/www/media/images/2026/11/a.png"))!;
    expect(Buffer.from(await png.getData(new Uint8ArrayWriter())).toString()).toBe("png-bytes");
    await zip.close();
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "backup.download"));
    expect(audit).toMatchObject({ target: name });
  });
});
