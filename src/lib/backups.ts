import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { eq, sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import "./backup/archive"; // configures zip.js (no Web Workers on the server)
import { BACKUP_ROOT, LEGACY_NAME } from "./backup/format";
import { audit } from "./audit";
import { log } from "./log";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { decryptWithPassphrase, derivedSecret, unseal, type Sealed } from "./secrets";
import { bucketOps, storageReady } from "./storage";

/**
 * Site backup settings (Settings → System → Backups), and the backups of format 1.
 *
 * Since D-108 (2026-11-28) a backup is the whole site: lib/backup/ (format 2: every table, every file in the bucket,
 * configuration, manifest, checksums; made, verified and restored by background jobs). This file keeps:
 * - the settings: schedule, what a scheduled backup holds, retention, a size limit, encryption and the bucket;
 * - format 1 (2026-11-14 → 2026-11-28): a zip of backup.json (12 content tables, no files) and README.txt. Those
 *   archives are still listed, downloaded (as plain copies) and restored, with the rules they were made for.
 *
 * Encryption is the admin's choice, on by default: AES-256 inside the zip (WinZip AES) with a key derived from
 * SETTINGS_ENCRYPTION_KEY (owner request 2026-11-18: no backup passphrase). The key lives in the Kubernetes Secret,
 * outside the database, so a backup can be restored after the database is lost. A passphrase stored before 2026-11-18
 * is kept (sealed) only to restore the backups made with it.
 */

const KEY = "backups";
export { BACKUP_ROOT };

type R2Dest = { enabled: boolean; bucket: string };
export type BackupConfig = {
  /** Encrypt new backups (AES-256 zip, server key). Existing backups keep the format they were made in. */
  encrypt: boolean;
  /** Before 2026-11-18 only: the passphrase older backups were encrypted with (no longer set or shown). */
  passphrase: Sealed | null;
  schedule: "off" | "daily" | "weekly";
  hourUtc: number;
  /** What a scheduled backup holds: the whole site, or the database (with configuration) only. */
  scheduleType: "full" | "database";
  /** Backups kept per type (full, database only, before a restore): the newest N. */
  retention: number;
  /** Also delete backups older than this many days (never the newest of a type). null: no age limit. */
  maxAgeDays: number | null;
  /** Refuse to start a backup expected to be larger than this (MB). null: no limit. */
  maxSizeMb: number | null;
  r2: R2Dest | null;
};

const empty: BackupConfig = { encrypt: true, passphrase: null, schedule: "off", hourUtc: 21, scheduleType: "full", retention: 14, maxAgeDays: null, maxSizeMb: null, r2: null };

export async function readBackupConfig(): Promise<BackupConfig> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
  const v = (row?.value as Partial<BackupConfig> | undefined) ?? {};
  // Older rows may still hold s3/sftp/gdrive destinations (removed): only the known fields are kept.
  // Rows from before the switch were always encrypted: encrypt stays on unless an admin turns it off.
  return {
    encrypt: v.encrypt ?? empty.encrypt,
    passphrase: v.passphrase ?? empty.passphrase,
    schedule: v.schedule ?? empty.schedule,
    hourUtc: v.hourUtc ?? empty.hourUtc,
    scheduleType: v.scheduleType === "database" ? "database" : "full",
    retention: v.retention ?? empty.retention,
    maxAgeDays: typeof v.maxAgeDays === "number" && v.maxAgeDays > 0 ? v.maxAgeDays : null,
    maxSizeMb: typeof v.maxSizeMb === "number" && v.maxSizeMb > 0 ? v.maxSizeMb : null,
    r2: v.r2 ?? null,
  };
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
    /** A passphrase from before 2026-11-18 is kept to restore the backups made with it. */
    legacyPassphrase: Boolean(c.passphrase),
    schedule: c.schedule,
    hourUtc: c.hourUtc,
    scheduleType: c.scheduleType,
    retention: c.retention,
    maxAgeDays: c.maxAgeDays,
    maxSizeMb: c.maxSizeMb,
    storageReady: await storageReady(),
    r2: c.r2 && { enabled: c.r2.enabled, bucket: c.r2.bucket },
  };
}

function admin(actor: Actor) {
  if (actor.role !== "admin") throw new PostError("Only admins can manage backups.", 403);
}

/** "" or absent: no limit (null); otherwise a whole number in range. */
const optionalLimit = (max: number) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? null : v), z.coerce.number().int().min(1).max(max).nullable());

const generalInput = z.object({
  schedule: z.enum(["off", "daily", "weekly"]),
  hourUtc: z.coerce.number().int().min(0).max(23),
  scheduleType: z.enum(["full", "database"]).default("full"),
  retention: z.coerce.number().int().min(1).max(365),
  maxAgeDays: optionalLimit(3650).default(null),
  maxSizeMb: optionalLimit(10_000_000).default(null),
  // A checkbox: present ("on") when ticked, absent otherwise.
  encrypt: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()).default(false),
});

export async function saveGeneral(actor: Actor, raw: unknown) {
  admin(actor);
  const parsed = generalInput.safeParse(raw);
  if (!parsed.success) throw new PostError("Backup settings are not valid.", 400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const c = await readBackupConfig();
  const d = parsed.data;
  // An old stored passphrase is kept whatever is chosen: backups made with it still need it to restore.
  await writeConfig({ ...c, encrypt: d.encrypt, schedule: d.schedule, hourUtc: d.hourUtc, scheduleType: d.scheduleType, retention: d.retention, maxAgeDays: d.maxAgeDays, maxSizeMb: d.maxSizeMb }, actor.id);
  await audit(actor, "backup.configure", "general", { schedule: d.schedule, scheduleType: d.scheduleType, retention: d.retention, maxAgeDays: d.maxAgeDays, maxSizeMb: d.maxSizeMb, encrypt: d.encrypt });
}

const BUCKET = /^$|^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Turn the backup destination on or off and choose its bucket ("" = the media bucket). */
export async function saveDestination(actor: Actor, f: { enabled: boolean; bucket: string }) {
  admin(actor);
  const bucket = f.bucket.trim().toLowerCase();
  if (!BUCKET.test(bucket)) throw new PostError("Bucket names are 3–63 lowercase letters, digits and hyphens.");
  if (f.enabled && !(await storageReady())) throw new PostError("Configure media storage (Cloudflare R2 or Amazon S3) in Settings → Storage first.");
  const c = await readBackupConfig();
  await writeConfig({ ...c, r2: { enabled: f.enabled, bucket } }, actor.id);
  await audit(actor, "backup.destination", "r2", { enabled: f.enabled, bucket: bucket || "(media bucket)" });
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

// --- Keys ------------------------------------------------------------------------------------------------

/** The AES password of backups made since 2026-11-18: derived from SETTINGS_ENCRYPTION_KEY, never stored or shown. */
export const serverBackupPassword = () => derivedSecret("backup-zip-v1");

/** Every password a stored backup may use: the server key, then a passphrase kept from before 2026-11-18. */
export function backupPasswords(c: BackupConfig): string[] {
  const out = [serverBackupPassword()];
  if (c.passphrase) {
    try {
      out.push(unseal(c.passphrase));
    } catch {
      /* SETTINGS_ENCRYPTION_KEY changed since: the old passphrase is unreadable */
    }
  }
  return out;
}

// --- Format 1 (content only, 2026-11-14 → 2026-11-28) ------------------------------------------------------

export const isLegacyBackup = (name: string) => LEGACY_NAME.test(name);
const isLegacyGzip = (name: string) => name.endsWith(".json.gz.enc");

/** Bytes of one stored format-1 backup (download, restore). Only names format 1 wrote are accepted. */
export async function readStoredBackup(name: string): Promise<Buffer> {
  if (!isLegacyBackup(name)) throw new PostError("Unknown backup.", 404);
  const c = await readBackupConfig();
  if (!c.r2) throw new PostError("Backups are not configured.", 404);
  return (await bucketOps(c.r2.bucket)).get(`${BACKUP_ROOT}/${name}`);
}

const README = (encrypted: boolean, createdAt: string) =>
  [
    "Jithendar.com site backup",
    `Created: ${createdAt}`,
    "",
    "backup.json holds posts, pages, categories, author profiles, comments, contact messages, media records, redirects,",
    "Appearance & settings and accounts. It does NOT hold password hashes, sessions, API-key hashes or stored",
    "credentials. Media files stay in the storage bucket; only their records are here.",
    "",
    encrypted
      ? "backup.json is encrypted (AES-256) with a key derived from the site's SETTINGS_ENCRYPTION_KEY. To read it, download\nit from Admin → Backups: the download is an unencrypted copy. To restore it, use Restore there."
      : "backup.json is not encrypted: anyone with this file can read it. Keep it private.",
    "",
    "Restore: Admin → Backups → Restore (the file must be in the backup bucket under jithendar/backups/).",
    "",
  ].join("\n");

/** A format-1 zip: backup.json (AES-256 with `password` when given) and an unencrypted README.txt. */
export async function zipBackup(json: string, createdAt: string, password?: string): Promise<Buffer> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { level: 6 });
  await zip.add("README.txt", new TextReader(README(Boolean(password), createdAt)));
  await zip.add("backup.json", new TextReader(json), password ? { password, encryptionStrength: 3 } : {});
  return Buffer.from(await zip.close());
}

/** backup.json from a format-1 zip, trying each password for an encrypted one. Throws PostError when none fits. */
export async function unzipBackup(data: Buffer, password?: string | string[]): Promise<string> {
  const passwords = (Array.isArray(password) ? password : password ? [password] : []).filter(Boolean);
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(data)));
  try {
    const entry = (await reader.getEntries()).find((e) => e.filename === "backup.json");
    if (!entry || entry.directory) throw new PostError("This zip is not a Jithendar.com backup (no backup.json).");
    if (!entry.encrypted) return await entry.getData!(new TextWriter(), {});
    if (!passwords.length) throw new PostError("This backup is encrypted.");
    for (const pw of passwords) {
      try {
        return await entry.getData!(new TextWriter(), { password: pw });
      } catch {
        /* try the next one */
      }
    }
    throw new PostError("That backup could not be decrypted: it was encrypted with another SETTINGS_ENCRYPTION_KEY or an old passphrase this site no longer has.");
  } finally {
    await reader.close();
  }
}

/** An unencrypted copy of a stored format-1 backup, for the owner to download and open with any zip tool. */
export async function plainCopyOfStoredBackup(name: string): Promise<Buffer> {
  const c = await readBackupConfig();
  const bytes = await readStoredBackup(name);
  if (isLegacyGzip(name)) {
    const passphrase = backupPasswords(c)[1];
    if (!passphrase) throw new PostError("This backup is from before the zip format and needs its old passphrase, which this site no longer has.");
    return zipBackup(gunzipSync(await decryptWithPassphrase(bytes, passphrase)).toString("utf8"), name);
  }
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)));
  const created = await reader
    .getEntries()
    .then((es) => es.find((e) => e.filename === "README.txt"))
    .then(async (e) => ((e && !e.directory ? await e.getData(new TextWriter()) : "").match(/^Created: (.+)$/m)?.[1] ?? name))
    .finally(() => reader.close());
  return zipBackup(await unzipBackup(bytes, backupPasswords(c)), created);
}

/** Restore order (parents first); deletion runs in reverse. `user` is merged, never replaced. */
const RESTORE_ORDER = ["category", "author_profile", "post", "page", "media", "comment", "comment_like", "comment_report", "contact_message", "redirect", "site_config"] as const;
/**
 * Tables whose rows are updated in place (matched on this key column) instead of deleted and inserted again. Tables
 * that are not in a format-1 backup hang off them:
 * - `post`: with ON DELETE CASCADE seo_drafts, seo_content_audits, seo_article_optimizations,
 *   seo_internal_link_suggestions, seo_ml_related_articles and seo_promo_opportunities; with ON DELETE SET NULL
 *   seo_recommendations, seo_editorial_calendar, seo_url_map and seo_search_submissions;
 * - `category`: news_topics.category_slug (ON DELETE SET NULL).
 * Deleting every row first, as the other tables are, deleted or unlinked all of that for good, although the same posts
 * and categories came straight back. Only rows the backup does not have are deleted.
 */
const KEEP_ROWS: Record<string, string> = { post: "id", category: "slug" };
/** Columns that point at a user, per table (remapped when an account was recreated with a new id). */
const USER_REFS: Record<string, string[]> = { author_profile: ["user_id"], post: ["author_id"], comment: ["user_id"], comment_like: ["user_id"], comment_report: ["user_id"], media: ["uploaded_by"] };
export const RESTORE_LOCK_ID = 7_250_033;

type Row = Record<string, unknown>;
type BackupPayload = { format: string; version: number; createdAt: string; tables: Record<string, Row[]> };

/** A format-1 backup's JSON (from a zip's backup.json, or a legacy file's gunzipped bytes). */
export function parseBackup(json: string): BackupPayload {
  const payload = JSON.parse(json) as Partial<BackupPayload>;
  if (payload.format !== "jithendar-backup" || payload.version !== 1 || !payload.tables || typeof payload.tables !== "object") throw new PostError("This is not a Jithendar.com backup this version can restore.");
  return payload as BackupPayload;
}

/** `rolesNotRestored`: recreated accounts that were staff (admin, author, demo) in the backup and are readers now. */
export type LegacyRestoreResult = { safetyBackup: string; restored: Record<string, number>; usersAdded: number; rolesNotRestored: number };

/**
 * Replace content and settings with a stored format-1 backup, in one transaction (all or nothing). Before anything
 * changes, `safety` saves the current state as a new backup (a full database backup since D-108), so a restore can
 * itself be undone. Replaced: posts, pages, categories, author profiles, comments (likes, reports), messages, media
 * records, redirects, Appearance & settings. A post that is in the backup and still exists is updated in place
 * (KEEP_ROWS), so what hangs off it outside the backup (SEO drafts, audits, optimisations, link suggestions…) stays;
 * posts the backup does not have are deleted. Accounts are merged: missing ones are recreated (without a password: they
 * use "Forgot password" or social sign-in) as readers, whatever role the backup gives them; existing ones and all
 * sign-in methods, sessions, API keys and stored credentials are left alone. Media files are not touched.
 */
export async function restoreLegacyBackup(actor: Actor, name: string, safety: () => Promise<string>): Promise<LegacyRestoreResult> {
  admin(actor);
  const c = await readBackupConfig();
  if (!c.r2) throw new PostError("Backups are not configured.");
  const passwords = backupPasswords(c);
  const bytes = await readStoredBackup(name);
  let payload: BackupPayload;
  try {
    if (isLegacyGzip(name)) {
      // Before the zip format: always gzip + AES-256-GCM with the old passphrase.
      const passphrase = passwords[1];
      if (!passphrase) throw new PostError("This backup is from before the zip format and needs its old passphrase, which this site no longer has.");
      payload = parseBackup(gunzipSync(await decryptWithPassphrase(bytes, passphrase)).toString("utf8"));
    } else {
      payload = parseBackup(await unzipBackup(bytes, passwords));
    }
  } catch (e) {
    if (e instanceof PostError) throw e;
    throw new PostError("That backup could not be decrypted: it was encrypted with another SETTINGS_ENCRYPTION_KEY or an old passphrase this site no longer has.");
  }

  // Safety net first: if this fails, nothing is restored.
  const safetyBackup = await safety();

  const db = await getDb();
  const restored: Record<string, number> = {};
  let usersAdded = 0;
  let rolesNotRestored: { email: string; role: string }[] = [];
  await db.transaction(async (tx) => {
    const [{ locked } = { locked: false }] = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${RESTORE_LOCK_ID}) as locked`));
    if (!locked) throw new PostError("Another restore is running. Try again in a minute.", 409);

    const columns = async (table: string) =>
      new Set(rowsOf<{ c: string }>(await tx.execute(sql`select column_name as c from information_schema.columns where table_schema = current_schema() and table_name = ${table}`)).map((r) => r.c));
    // onConflict "nothing": a row that is already there stays as it is. { key }: a row with the same key takes the
    // backup's values (KEEP_ROWS).
    const insert = async (table: string, rows: Row[], onConflict: "" | "nothing" | { key: string } = "") => {
      if (rows.length === 0) return 0;
      const known = await columns(table);
      const keys = Object.keys(rows[0]!).filter((k) => known.has(k));
      const list = keys.map((k) => `"${k}"`).join(", ");
      let conflict = onConflict === "nothing" ? "on conflict do nothing" : "";
      if (typeof onConflict === "object" && known.has(onConflict.key)) {
        const key = onConflict.key;
        const assignments = keys.filter((k) => k !== key).map((k) => `"${k}" = excluded."${k}"`).join(", ");
        if (assignments) conflict = `on conflict ("${key}") do update set ${assignments}`;
      }
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
    // A recreated account is always a reader, whatever role the file gives it. The file comes from a bucket, and a
    // role taken from it would let whoever can write there make themselves an admin: the account has no password,
    // but "Forgot password" sets one. An admin gives staff their roles back in Admin → Users.
    const users = payload.tables.user ?? [];
    const before = new Set(rowsOf<{ id: string }>(await tx.execute(sql`select id from "user"`)).map((u) => u.id));
    usersAdded = await insert("user", users.map((u) => ({ ...u, role: "user" })), "nothing");
    const current = rowsOf<{ id: string; email: string }>(await tx.execute(sql`select id, email from "user"`));
    const recreated = new Set(current.filter((u) => !before.has(u.id)).map((u) => u.id));
    rolesNotRestored = users.filter((u) => recreated.has(String(u.id)) && typeof u.role === "string" && u.role !== "user").map((u) => ({ email: String(u.email), role: String(u.role) }));
    const byEmail = new Map(current.map((u) => [u.email.toLowerCase(), u.id]));
    const idMap = new Map(users.map((u) => [String(u.id), byEmail.get(String(u.email).toLowerCase()) ?? null]));

    // The backup's key values of a KEEP_ROWS table, as a JSON array for jsonb_array_elements_text.
    const keysOf = (table: string, key: string) => JSON.stringify((payload.tables[table] ?? []).map((row) => String(row[key])));
    for (const table of [...RESTORE_ORDER].reverse()) {
      const key = KEEP_ROWS[table];
      // KEEP_ROWS: only the rows the backup does not have go; the others are updated below.
      if (key) await tx.execute(sql`delete from ${sql.identifier(table)} where ${sql.identifier(key)}::text not in (select jsonb_array_elements_text(${keysOf(table, key)}::jsonb))`);
      else await tx.execute(sql`delete from ${sql.identifier(table)}`);
    }
    for (const table of RESTORE_ORDER) {
      const rows = (payload.tables[table] ?? []).map((row) => {
        const out = { ...row };
        for (const col of USER_REFS[table] ?? []) if (out[col] != null) out[col] = idMap.get(String(out[col])) ?? out[col];
        return out;
      });
      // Two kept posts may have traded slugs since the backup. Rows are updated one at a time, so the first would
      // collide with the slug the second still has (unique collection + slug). Every kept post gets a placeholder
      // first; the update then gives each one its slug from the backup.
      if (table === "post" && rows.length > 0 && "slug" in rows[0]!) {
        await tx.execute(sql`update "post" set slug = '~restore~' || id::text where id::text in (select jsonb_array_elements_text(${keysOf(table, "id")}::jsonb))`);
      }
      const key = KEEP_ROWS[table];
      restored[table] = await insert(table, rows, key ? { key } : "");
    }
  });

  const { invalidateContent } = await import("./content");
  const { broadcastInvalidate } = await import("./cache-bus");
  invalidateContent();
  broadcastInvalidate("categories");
  broadcastInvalidate("settings");
  // Who lost a staff role, so an admin can give it back on purpose (at most 50 named; the count is exact).
  const detail = { safetyBackup, restored, usersAdded, ...(rolesNotRestored.length ? { rolesNotRestored: rolesNotRestored.slice(0, 50), rolesNotRestoredCount: rolesNotRestored.length } : {}) };
  await audit(actor, "backup.restore", name, detail, { severity: "critical" });
  log.warn("backup restored", { name, safetyBackup, restored, usersAdded, rolesNotRestored: rolesNotRestored.length });
  return { safetyBackup, restored, usersAdded, rolesNotRestored: rolesNotRestored.length };
}
