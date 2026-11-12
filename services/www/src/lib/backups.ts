import { configure, TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { desc, eq, sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "./audit";
import { log } from "./log";
import { withSpan } from "./trace";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { decryptWithPassphrase, seal, unseal, type Sealed } from "./secrets";
import { bucketOps, storageReady } from "./storage";

/**
 * Site backups to Cloudflare R2 (the media storage account; optionally a separate private bucket).
 * Contents: content, configuration and accounts WITHOUT password hashes, sessions, API-key hashes or stored
 * credentials. Each file is a standard zip: backup.json (the data) and README.txt (what it is, how to open it).
 * Encryption is the admin's choice (Admin → Backups): on, backup.json is AES-256 encrypted inside the zip
 * (WinZip AES; opens in 7-Zip, Keka, WinRAR or `7z x`, not macOS Archive Utility) with a passphrase only the owner
 * knows; off, it is a plain zip anything opens.
 *
 * Objects: {bucket}/jithendar/backups/jithendar-backup-{yyyymmdd-hhmmss}.zip. Backups made before the zip format
 * (….json.gz.enc: gzip + AES-256-GCM, lib/secrets) are still listed, downloaded and restored.
 */
// zip.js would otherwise start Web Workers, which the Node server does not have.
configure({ useWebWorkers: false });

const KEY = "backups";
const PREFIX = "jithendar-backup-";
export const BACKUP_ROOT = "jithendar/backups";
const LOCK_ID = 7_250_032;

type R2Dest = { enabled: boolean; bucket: string };
export type BackupConfig = {
  /** Encrypt new backups with the passphrase (AES-256 zip). Existing backups keep the format they were made in. */
  encrypt: boolean;
  passphrase: Sealed | null;
  schedule: "off" | "daily" | "weekly";
  hourUtc: number;
  retention: number;
  r2: R2Dest | null;
};

const empty: BackupConfig = { encrypt: true, passphrase: null, schedule: "off", hourUtc: 21, retention: 14, r2: null };

export async function readBackupConfig(): Promise<BackupConfig> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
  const v = (row?.value as Partial<BackupConfig> | undefined) ?? {};
  // Older rows may still hold s3/sftp/gdrive destinations (removed): only the known fields are kept.
  // Rows from before the switch were always encrypted: encrypt stays on unless an admin turns it off.
  return { encrypt: v.encrypt ?? empty.encrypt, passphrase: v.passphrase ?? empty.passphrase, schedule: v.schedule ?? empty.schedule, hourUtc: v.hourUtc ?? empty.hourUtc, retention: v.retention ?? empty.retention, r2: v.r2 ?? null };
}

async function writeConfig(c: BackupConfig, userId: string) {
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: c, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: c, updatedBy: userId, updatedAt: new Date() } });
}

/** What the admin form may show: never secrets, only whether they are set. */
export async function backupSummary() {
  const c = await readBackupConfig();
  return {
    encrypt: c.encrypt,
    hasPassphrase: Boolean(c.passphrase),
    schedule: c.schedule,
    hourUtc: c.hourUtc,
    retention: c.retention,
    storageReady: await storageReady(),
    r2: c.r2 && { enabled: c.r2.enabled, bucket: c.r2.bucket },
  };
}

function admin(actor: Actor) {
  if (actor.role !== "admin") throw new PostError("Only admins can manage backups.", 403);
}

const generalInput = z.object({
  schedule: z.enum(["off", "daily", "weekly"]),
  hourUtc: z.coerce.number().int().min(0).max(23),
  retention: z.coerce.number().int().min(1).max(365),
  passphrase: z.string().max(200).default(""),
  // A checkbox: present ("on") when ticked, absent otherwise.
  encrypt: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()).default(false),
});

export async function saveGeneral(actor: Actor, raw: unknown) {
  admin(actor);
  const parsed = generalInput.safeParse(raw);
  if (!parsed.success) throw new PostError("Backup settings are not valid.", 400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const c = await readBackupConfig();
  if (parsed.data.passphrase && parsed.data.passphrase.length < 12) throw new PostError("Use a backup passphrase of at least 12 characters.");
  if (parsed.data.encrypt && !parsed.data.passphrase && !c.passphrase) throw new PostError("Set a backup passphrase to encrypt backups. You will need it to restore.");
  // Turning encryption off keeps the stored passphrase: older encrypted backups still need it to restore.
  await writeConfig(
    {
      ...c,
      encrypt: parsed.data.encrypt,
      schedule: parsed.data.schedule,
      hourUtc: parsed.data.hourUtc,
      retention: parsed.data.retention,
      passphrase: parsed.data.passphrase ? seal(parsed.data.passphrase) : c.passphrase,
    },
    actor.id,
  );
  await audit(actor, "backup.configure", "general", { schedule: parsed.data.schedule, retention: parsed.data.retention, encrypt: parsed.data.encrypt });
}

const BUCKET = /^$|^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Turn the R2 destination on or off and choose its bucket ("" = the media bucket). */
export async function saveDestination(actor: Actor, f: { enabled: boolean; bucket: string }) {
  admin(actor);
  const bucket = f.bucket.trim().toLowerCase();
  if (!BUCKET.test(bucket)) throw new PostError("Bucket names are 3–63 lowercase letters, digits and hyphens.");
  if (f.enabled && !(await storageReady())) throw new PostError("Configure Cloudflare R2 in Storage & email first.");
  const c = await readBackupConfig();
  await writeConfig({ ...c, r2: { enabled: f.enabled, bucket } }, actor.id);
  await audit(actor, "backup.destination", "r2", { enabled: f.enabled, bucket: bucket || "(media bucket)" });
}

// --- Destination ---------------------------------------------------------------------------

type Target = { name: string; put: (file: string, data: Buffer) => Promise<void>; prune: (retention: number) => Promise<number> };

async function r2Target(d: R2Dest): Promise<Target> {
  const ops = await bucketOps(d.bucket);
  const key = (f: string) => `${BACKUP_ROOT}/${f}`;
  return {
    name: "r2",
    put: (file, data) => ops.put(key(file), data),
    prune: async (retention) => {
      const old = (await ops.list(key(PREFIX))).map((o) => o.key).sort().reverse().slice(retention);
      for (const k of old) await ops.remove(k);
      return old.length;
    },
  };
}

async function targets(c: BackupConfig, onlyEnabled = true): Promise<Target[]> {
  if (!c.r2 || (onlyEnabled && !c.r2.enabled)) return [];
  return [await r2Target(c.r2)];
}

/** Write and remove a small probe object to prove the bucket is writable. */
export async function testDestination(actor: Actor) {
  admin(actor);
  const c = await readBackupConfig();
  if (!c.r2) throw new PostError("Save the destination first.");
  try {
    const ops = await bucketOps(c.r2.bucket);
    const probe = `${BACKUP_ROOT}/connection-test-${Date.now()}.txt`;
    await ops.put(probe, Buffer.from("ok"), "text/plain");
    await ops.remove(probe);
  } catch (e) {
    throw new PostError(`Connection test failed: ${(e as Error).message}`);
  }
}

/** Backups stored in R2, newest first (for the admin list). */
export async function listStoredBackups(): Promise<{ key: string; name: string; size: number; lastModified: string | null }[]> {
  const c = await readBackupConfig();
  if (!c.r2 || !(await storageReady())) return [];
  const ops = await bucketOps(c.r2.bucket);
  return (await ops.list(`${BACKUP_ROOT}/${PREFIX}`))
    .map((o) => ({ ...o, name: o.key.slice(BACKUP_ROOT.length + 1) }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Names this site writes: the zip format, and the gzip + AES-GCM files from before it. */
const BACKUP_NAME = /^jithendar-backup-\d{8}-\d{6}\.(zip|json\.gz\.enc)$/;
export const isLegacyBackup = (name: string) => name.endsWith(".json.gz.enc");

/** Bytes of one stored backup (admin download). Only names this site writes are accepted. */
export async function readStoredBackup(name: string): Promise<Buffer> {
  if (!BACKUP_NAME.test(name)) throw new PostError("Unknown backup.", 404);
  const c = await readBackupConfig();
  if (!c.r2) throw new PostError("Backups are not configured.", 404);
  return (await bucketOps(c.r2.bucket)).get(`${BACKUP_ROOT}/${name}`);
}

// --- Building and running -----------------------------------------------------------

/** Tables in the backup, and columns that must never leave the server. */
const TABLES: { name: string; omit?: string[] }[] = [
  { name: "post" },
  { name: "page" },
  { name: "category" },
  { name: "author_profile" },
  { name: "comment" },
  { name: "comment_like" },
  { name: "comment_report" },
  { name: "contact_message" },
  { name: "media" },
  { name: "redirect" },
  // Appearance & settings (published and draft); holds no credentials.
  { name: "site_config" },
  { name: "user", omit: [] },
];

const README = (encrypted: boolean, createdAt: string) =>
  [
    "Jithendar.com site backup",
    `Created: ${createdAt}`,
    "",
    "backup.json holds posts, pages, categories, author profiles, comments, contact messages, media records, redirects,",
    "Appearance & settings and accounts. It does NOT hold password hashes, sessions, API-key hashes or stored",
    "credentials. Media files stay in Cloudflare R2; only their records are here.",
    "",
    encrypted
      ? "backup.json is encrypted (AES-256). Open it with 7-Zip, Keka, WinRAR or `7z x <file>` and the backup passphrase\nset in Admin → Backups. macOS Archive Utility cannot open AES-encrypted zips."
      : "backup.json is not encrypted: anyone with this file can read it. Keep it private.",
    "",
    "Restore: Admin → Backups → Restore (the file must be in the backup bucket under jithendar/backups/).",
    "",
  ].join("\n");

/** A zip of backup.json (AES-256 with `password` when given) and an unencrypted README.txt. */
export async function zipBackup(json: string, createdAt: string, password?: string): Promise<Buffer> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { level: 6 });
  await zip.add("README.txt", new TextReader(README(Boolean(password), createdAt)));
  await zip.add("backup.json", new TextReader(json), password ? { password, encryptionStrength: 3 } : {});
  return Buffer.from(await zip.close());
}

/** backup.json from a zip backup. Throws PostError when it is encrypted and the passphrase is missing or wrong. */
export async function unzipBackup(data: Buffer, password?: string): Promise<string> {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(data)));
  try {
    const entry = (await reader.getEntries()).find((e) => e.filename === "backup.json");
    if (!entry || entry.directory) throw new PostError("This zip is not a Jithendar.com backup (no backup.json).");
    if (entry.encrypted && !password) throw new PostError("This backup is encrypted: set the backup passphrase first.");
    try {
      return await entry.getData!(new TextWriter(), entry.encrypted ? { password } : {});
    } catch {
      throw new PostError("That backup could not be decrypted with the current passphrase (was it changed since?).");
    }
  } finally {
    await reader.close();
  }
}

export async function buildBackup(): Promise<{ filename: string; data: Buffer; encrypted: boolean }> {
  const c = await readBackupConfig();
  if (c.encrypt && !c.passphrase) throw new PostError("Set a backup passphrase first, or turn encryption off.");
  const db = await getDb();
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t.name] = rowsOf(await db.execute(sql.raw(`select * from "${t.name}"`)));
  // Only the public site settings: storage/email/backup credentials are excluded on purpose.
  const [site] = await db.select().from(schema.setting).where(eq(schema.setting.key, "site"));
  const createdAt = new Date().toISOString();
  const payload = {
    format: "jithendar-backup",
    version: 1,
    createdAt,
    appVersion: process.env.GIT_SHA ?? "dev",
    note: "Excludes password hashes, sessions, API-key hashes and stored credentials. Media bytes live in R2; this holds their metadata.",
    settings: site?.value ?? null,
    tables,
  };
  const password = c.encrypt && c.passphrase ? unseal(c.passphrase) : undefined;
  const data = await zipBackup(JSON.stringify(payload), createdAt, password);
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return { filename: `${PREFIX}${stamp}.zip`, data, encrypted: Boolean(password) };
}

export function runBackup(trigger: "manual" | "scheduled", actor?: Actor) {
  return withSpan("backup.run", { "backup.trigger": trigger }, () => runBackupNow(trigger, actor));
}

async function runBackupNow(trigger: "manual" | "scheduled", actor?: Actor) {
  const db = await getDb();
  const [run] = await db.insert(schema.backupRun).values({ trigger, status: "running", triggeredBy: actor?.label ?? "scheduler" }).returning();
  const results: { destination: string; ok: boolean; detail: string }[] = [];
  try {
    const c = await readBackupConfig();
    const dests = await targets(c);
    if (dests.length === 0) throw new PostError("Turn on the Cloudflare R2 destination first.");
    const { filename, data } = await buildBackup();
    for (const d of dests) {
      try {
        await d.put(filename, data);
        const pruned = await d.prune(c.retention).catch(() => 0);
        results.push({ destination: d.name, ok: true, detail: pruned ? `uploaded; removed ${pruned} old backup(s)` : "uploaded" });
      } catch (e) {
        results.push({ destination: d.name, ok: false, detail: (e as Error).message.slice(0, 300) });
      }
    }
    const status = results.every((r) => r.ok) ? "success" : results.some((r) => r.ok) ? "partial" : "failed";
    await db.update(schema.backupRun).set({ status, filename, sizeBytes: data.length, results, finishedAt: new Date() }).where(eq(schema.backupRun.id, run!.id));
    log.info("backup finished", { trigger, status, sizeBytes: data.length, results });
    if (actor) await audit(actor, "backup.run", filename, { status });
    return { status, results };
  } catch (error) {
    const detail = error instanceof PostError ? error.message : "Unexpected error (see logs).";
    if (!(error instanceof PostError)) log.error("backup failed", { err: error, trigger });
    await db.update(schema.backupRun).set({ status: "failed", results: [{ destination: "-", ok: false, detail }], finishedAt: new Date() }).where(eq(schema.backupRun.id, run!.id));
    return { status: "failed", results: [{ destination: "-", ok: false, detail }] };
  }
}

export async function recentRuns(limit = 20) {
  const db = await getDb();
  return db.select().from(schema.backupRun).orderBy(desc(schema.backupRun.startedAt)).limit(limit);
}

/** In-app scheduler: one replica (Postgres advisory lock) runs due backups. Checked every 15 minutes. */
export function startBackupScheduler() {
  const g = globalThis as unknown as { __backupTimer?: NodeJS.Timeout };
  if (g.__backupTimer) return;
  const tick = async () => {
    try {
      const c = await readBackupConfig();
      if (c.schedule === "off" || (c.encrypt && !c.passphrase)) return;
      const now = new Date();
      if (now.getUTCHours() < c.hourUtc) return;
      const [last] = await recentRuns(1);
      const interval = c.schedule === "daily" ? 20 * 3600_000 : 6.5 * 86_400_000;
      if (last && now.getTime() - last.startedAt.getTime() < interval) return;
      const db = await getDb();
      const [{ locked } = { locked: false }] = rowsOf<{ locked: boolean }>(await db.execute(sql`select pg_try_advisory_lock(${LOCK_ID}) as locked`));
      if (!locked) return;
      try {
        await runBackup("scheduled");
      } finally {
        await db.execute(sql`select pg_advisory_unlock(${LOCK_ID})`);
      }
    } catch (error) {
      log.warn("backup scheduler tick failed", { err: error });
    }
  };
  g.__backupTimer = setInterval(() => void tick(), 15 * 60_000);
  g.__backupTimer.unref?.();
}

// --- Restore -------------------------------------------------------------------------------------

/** Restore order (parents first); deletion runs in reverse. `user` is merged, never replaced. */
const RESTORE_ORDER = ["category", "author_profile", "post", "page", "media", "comment", "comment_like", "comment_report", "contact_message", "redirect", "site_config"] as const;
/** Columns that point at a user, per table (remapped when an account was recreated with a new id). */
const USER_REFS: Record<string, string[]> = { author_profile: ["user_id"], post: ["author_id"], comment: ["user_id"], comment_like: ["user_id"], comment_report: ["user_id"], media: ["uploaded_by"] };
const RESTORE_LOCK_ID = 7_250_033;

type Row = Record<string, unknown>;
type BackupPayload = { format: string; version: number; createdAt: string; tables: Record<string, Row[]> };

/** The backup's JSON (from a zip's backup.json, or a legacy file's gunzipped bytes). */
export function parseBackup(json: string): BackupPayload {
  const payload = JSON.parse(json) as Partial<BackupPayload>;
  if (payload.format !== "jithendar-backup" || payload.version !== 1 || !payload.tables || typeof payload.tables !== "object") throw new PostError("This is not a Jithendar.com backup this version can restore.");
  return payload as BackupPayload;
}

export type RestoreResult = { safetyBackup: string; restored: Record<string, number>; usersAdded: number };

/**
 * Replace content and settings with a stored backup, in one transaction (all or nothing). Before anything
 * changes, the current state is saved to R2 as a new backup, so a restore can itself be undone.
 * Replaced: posts, pages, categories, author profiles, comments (likes, reports), messages, media records,
 * redirects, Appearance & settings. Accounts are merged: missing ones are recreated (without a password: they
 * use "Forgot password" or social sign-in), existing ones and all sign-in methods, sessions, API keys and
 * stored credentials are left alone. Media files themselves stay in R2 and are not touched.
 */
export async function restoreStoredBackup(actor: Actor, name: string): Promise<RestoreResult> {
  admin(actor);
  const c = await readBackupConfig();
  if (!c.r2) throw new PostError("Backups are not configured.");
  const passphrase = c.passphrase ? unseal(c.passphrase) : undefined;
  const bytes = await readStoredBackup(name);
  let payload: BackupPayload;
  try {
    if (isLegacyBackup(name)) {
      // Before the zip format: always gzip + AES-256-GCM.
      if (!passphrase) throw new PostError("Set the backup passphrase first: it is needed to decrypt this backup.");
      payload = parseBackup(gunzipSync(await decryptWithPassphrase(bytes, passphrase)).toString("utf8"));
    } else {
      payload = parseBackup(await unzipBackup(bytes, passphrase));
    }
  } catch (e) {
    if (e instanceof PostError) throw e;
    throw new PostError("That backup could not be decrypted with the current passphrase (was it changed since?).");
  }

  // Safety net first: if this fails, nothing is restored.
  const safety = await buildBackup();
  await (await r2Target(c.r2)).put(safety.filename, safety.data);

  const db = await getDb();
  const restored: Record<string, number> = {};
  let usersAdded = 0;
  await db.transaction(async (tx) => {
    const [{ locked } = { locked: false }] = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${RESTORE_LOCK_ID}) as locked`));
    if (!locked) throw new PostError("Another restore is running. Try again in a minute.", 409);

    const columns = async (table: string) =>
      new Set(rowsOf<{ c: string }>(await tx.execute(sql`select column_name as c from information_schema.columns where table_schema = current_schema() and table_name = ${table}`)).map((r) => r.c));
    const insert = async (table: string, rows: Row[], conflict = "") => {
      if (rows.length === 0) return 0;
      const known = await columns(table);
      const keys = Object.keys(rows[0]!).filter((k) => known.has(k));
      const list = keys.map((k) => `"${k}"`).join(", ");
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = JSON.stringify(rows.slice(i, i + 500));
        const r = await tx.execute(
          sql`insert into ${sql.identifier(table)} (${sql.raw(list)}) select ${sql.raw(list)} from jsonb_populate_recordset(null::${sql.identifier(table)}, ${chunk}::jsonb) ${sql.raw(conflict)} returning 1`,
        );
        n += rowsOf(r).length;
      }
      return n;
    };

    // Accounts: add the missing ones; map backup ids to current ids by email (an account may have been recreated).
    const users = payload.tables.user ?? [];
    usersAdded = await insert("user", users, "on conflict do nothing");
    const current = rowsOf<{ id: string; email: string }>(await tx.execute(sql`select id, email from "user"`));
    const byEmail = new Map(current.map((u) => [u.email.toLowerCase(), u.id]));
    const idMap = new Map(users.map((u) => [String(u.id), byEmail.get(String(u.email).toLowerCase()) ?? null]));

    for (const table of [...RESTORE_ORDER].reverse()) await tx.execute(sql`delete from ${sql.identifier(table)}`);
    for (const table of RESTORE_ORDER) {
      const rows = (payload.tables[table] ?? []).map((row) => {
        const out = { ...row };
        for (const col of USER_REFS[table] ?? []) if (out[col] != null) out[col] = idMap.get(String(out[col])) ?? out[col];
        return out;
      });
      restored[table] = await insert(table, rows);
    }
  });

  const { invalidateContent } = await import("./content");
  const { broadcastInvalidate } = await import("./cache-bus");
  invalidateContent();
  broadcastInvalidate("categories");
  broadcastInvalidate("settings");
  await audit(actor, "backup.restore", name, { safetyBackup: safety.filename, restored, usersAdded }, { severity: "critical" });
  log.warn("backup restored", { name, safetyBackup: safety.filename, restored, usersAdded });
  return { safetyBackup: safety.filename, restored, usersAdded };
}
