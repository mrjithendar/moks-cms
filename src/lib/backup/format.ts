import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The site backup archive, format 2 (D-108): one zip with everything needed to recover the site.
 *
 *   {name}/README.txt                     what this is and how to restore it (never encrypted)
 *   {name}/database/schema.json           tables, columns, keys, row counts and policies at backup time
 *   {name}/database/tables/{table}.jsonl  every row of every table, one JSON object per line (to_jsonb)
 *   {name}/uploads/{object key}           every file the site stores in its bucket (media, site images, invoices, reports)
 *   {name}/uploads-index.jsonl            per file: key, size, content type, cache control, SHA-256
 *   {name}/application/…                  settings (secrets redacted), site.json + config/, application metadata
 *   {name}/deployment/…                   environment (names only for secrets), Kubernetes and restore requirements
 *   {name}/checksums/SHA256SUMS           SHA-256 of every file above (of its content, not of its zip bytes)
 *   {name}/manifest.json                  what is in the archive, the checksum of SHA256SUMS, an HMAC signature
 *
 * Pure: no database, storage or network here (unit-tested on its own).
 */

export const FORMAT = "moks-cms-site-backup";
export const FORMAT_VERSION = 2;
/** Object prefix of the backups in the backup bucket (the media bucket unless a separate one is chosen). */
export const BACKUP_ROOT = "jithendar/backups";
/** The site's own objects in the media bucket; everything under it is a website-managed file, except below. */
export const SITE_OBJECT_ROOT = "jithendar/";
/** Never in a backup: the backups themselves, and unaccepted AI images (they expire after a day). */
export const EXCLUDED_OBJECT_PREFIXES = [`${BACKUP_ROOT}/`, "jithendar/www/tmp/"] as const;

export const BACKUP_TYPES = ["full", "database", "prerestore"] as const;
export type BackupType = (typeof BACKUP_TYPES)[number];
export const COMPONENTS = ["database", "uploads", "application", "deployment"] as const;
export type Component = (typeof COMPONENTS)[number];

/** What each type holds. A pre-restore safety backup needs no uploads: a restore only ever adds files. */
export const TYPE_COMPONENTS: Record<BackupType, Component[]> = {
  full: ["database", "uploads", "application", "deployment"],
  database: ["database", "application", "deployment"],
  prerestore: ["database", "application", "deployment"],
};

export const TYPE_LABEL: Record<BackupType | "legacy", string> = {
  full: "Full site",
  database: "Database only",
  prerestore: "Before a restore",
  legacy: "Content only (old format)",
};

// --- Names ----------------------------------------------------------------------------------------------

/** "jithendar.com" → "jithendar-com": the site part of an archive name. */
export function siteIdFrom(host: string): string {
  const id = host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id.slice(0, 60) || "site";
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** jithendar-com-backup-2026-11-28-154900-full.zip (UTC). */
export function archiveName(siteId: string, type: BackupType, at: Date): string {
  const stamp = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${siteId}-backup-${stamp}-${type}.zip`;
}

const NAME = /^([a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-(full|database|prerestore)\.zip$/;
/** Backups made before format 2 (content only): zip, or gzip + AES-GCM before that. */
export const LEGACY_NAME = /^jithendar-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.(zip|json\.gz\.enc)$/;

export type ParsedName = { name: string; siteId: string | null; type: BackupType | "legacy"; createdAt: Date; legacy: boolean };

/** The parts of a backup file name, or null for any other name (never trusted beyond that). */
export function parseArchiveName(name: string): ParsedName | null {
  const m = NAME.exec(name);
  if (m) {
    const [, siteId, y, mo, d, h, mi, s, type] = m;
    const createdAt = utc(y!, mo!, d!, h!, mi!, s!);
    return createdAt ? { name, siteId: siteId!, type: type as BackupType, createdAt, legacy: false } : null;
  }
  const l = LEGACY_NAME.exec(name);
  if (l) {
    const [, y, mo, d, h, mi, s] = l;
    const createdAt = utc(y!, mo!, d!, h!, mi!, s!);
    return createdAt ? { name, siteId: null, type: "legacy", createdAt, legacy: true } : null;
  }
  return null;
}

/** A real UTC moment from its parts, or null (month 13 or 31 February would otherwise roll over). */
function utc(y: string, mo: string, d: string, h: string, mi: string, s: string): Date | null {
  const at = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  const same = at.getUTCFullYear() === +y && at.getUTCMonth() === +mo - 1 && at.getUTCDate() === +d && at.getUTCHours() === +h && at.getUTCMinutes() === +mi && at.getUTCSeconds() === +s;
  return same ? at : null;
}

export const isBackupName = (name: string) => parseArchiveName(name) !== null;
/** The folder every entry of an archive sits in: its name without ".zip". */
export const archiveRoot = (name: string) => name.replace(/\.zip$/, "");
/** The sidecar next to an archive: its manifest plus the archive's own size and SHA-256. */
export const sidecarName = (name: string) => `${name}.json`;

// --- Entry paths ----------------------------------------------------------------------------------------

export const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** A bucket key this site may write: under jithendar/, plain segments, no traversal, no control characters. */
export function safeObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) return false;
  if (!key.startsWith(SITE_OBJECT_ROOT)) return false;
  if (EXCLUDED_OBJECT_PREFIXES.some((p) => key.startsWith(p))) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return false;
  return key.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export type EntryKind =
  | { kind: "readme" }
  | { kind: "manifest" }
  | { kind: "sums" }
  | { kind: "schema" }
  | { kind: "table"; table: string }
  | { kind: "upload"; key: string }
  | { kind: "uploads-index" }
  | { kind: "application"; file: string }
  | { kind: "deployment"; file: string };

const APPLICATION_FILE = /^(settings\.json|metadata\.json|site-files\/site\.json|site-files\/config\/[a-z0-9][a-z0-9._-]{0,80}\.json)$/;
const DEPLOYMENT_FILE = /^(environment\.json|kubernetes\.json|restore-requirements\.json)$/;

/**
 * What an archive entry is, from its path inside the root folder, or a reason to reject the whole archive. The only
 * entries a format-2 archive may hold: anything else (another folder, "..", an absolute or Windows path, a name this
 * site would never write) makes the archive invalid. Nothing from an archive is ever written to the local disk: rows go
 * to the database as parameters and files to the bucket under keys checked by safeObjectKey.
 */
export function classifyEntry(path: string): EntryKind | { reject: string } {
  if (path.length > 1100) return { reject: "a path longer than 1,100 characters" };
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return { reject: "a path with a control character or a backslash" };
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return { reject: "an absolute path" };
  if (path.split("/").some((s) => s === ".." || s === ".")) return { reject: "a path with . or .." };
  if (path === "README.txt") return { kind: "readme" };
  if (path === "manifest.json") return { kind: "manifest" };
  if (path === "checksums/SHA256SUMS") return { kind: "sums" };
  if (path === "database/schema.json") return { kind: "schema" };
  if (path === "uploads-index.jsonl") return { kind: "uploads-index" };
  const t = /^database\/tables\/([^/]+)\.jsonl$/.exec(path);
  if (t) return TABLE_NAME.test(t[1]!) ? { kind: "table", table: t[1]! } : { reject: `an unexpected table name ${JSON.stringify(t[1])}` };
  if (path.startsWith("uploads/")) {
    const key = path.slice("uploads/".length);
    return safeObjectKey(key) ? { kind: "upload", key } : { reject: `an upload outside the site's files: ${JSON.stringify(key.slice(0, 120))}` };
  }
  if (path.startsWith("application/")) {
    const file = path.slice("application/".length);
    return APPLICATION_FILE.test(file) ? { kind: "application", file } : { reject: `an unexpected application file ${JSON.stringify(file.slice(0, 120))}` };
  }
  if (path.startsWith("deployment/")) {
    const file = path.slice("deployment/".length);
    return DEPLOYMENT_FILE.test(file) ? { kind: "deployment", file } : { reject: `an unexpected deployment file ${JSON.stringify(file.slice(0, 120))}` };
  }
  return { reject: `an unexpected file ${JSON.stringify(path.slice(0, 120))}` };
}

/** Unix file type bits in a zip entry's external attributes (made on Unix): a symbolic link is rejected. */
export function isSymlinkAttributes(externalFileAttributes: number): boolean {
  return ((externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

// --- Secrets ---------------------------------------------------------------------------------------------

/**
 * A value sealed with SETTINGS_ENCRYPTION_KEY (lib/secrets.ts seal, seo-agent app/admin_settings/secrets.py): always a
 * JSON object {"v": 1, "iv", "tag", "data"} in that order, inside a jsonb column. jsonb prints it exactly so; a json
 * column keeps the writer's spacing, which \s* allows.
 */
const SEALED = /\{\s*"v"\s*:\s*1\s*,\s*"iv"\s*:\s*"[A-Za-z0-9+/=]*"\s*,\s*"tag"\s*:\s*"[A-Za-z0-9+/=]*"\s*,\s*"data"\s*:\s*"[A-Za-z0-9+/=]*"\s*\}/g;
/** What a sealed value becomes in a backup. A restore keeps the value the site has now at the same place. */
export const SECRET_PLACEHOLDER = { $secret: "redacted" } as const;
const PLACEHOLDER_TEXT = '{"$secret": "redacted"}';
export const PLACEHOLDER_MARK = '"$secret"';

/** One exported row (JSON text) with every sealed value replaced by the placeholder, and how many there were. */
export function redactSealed(line: string): { text: string; count: number } {
  let count = 0;
  const text = line.replace(SEALED, () => {
    count++;
    return PLACEHOLDER_TEXT;
  });
  return { text, count };
}

const isPlaceholder = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && (v as Record<string, unknown>).$secret === "redacted" && Object.keys(v).length === 1;
const isSealedValue = (v: unknown) => {
  const o = v as Record<string, unknown> | null;
  return typeof o === "object" && o !== null && o.v === 1 && typeof o.iv === "string" && typeof o.tag === "string" && typeof o.data === "string";
};

/**
 * A backed-up value with its placeholders filled from the value the site holds now: a sealed value at the same place
 * is kept (the credentials the site has today stay); anywhere else the secret becomes null (it was not set here, so it
 * has to be entered again in the admin).
 */
export function fillPlaceholders(backup: unknown, current: unknown): { value: unknown; kept: number; dropped: number } {
  let kept = 0;
  let dropped = 0;
  const walk = (b: unknown, c: unknown): unknown => {
    if (isPlaceholder(b)) {
      if (isSealedValue(c)) {
        kept++;
        return c;
      }
      dropped++;
      return null;
    }
    if (Array.isArray(b)) return b.map((x, i) => walk(x, Array.isArray(c) ? c[i] : undefined));
    if (typeof b === "object" && b !== null) {
      const co = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
      return Object.fromEntries(Object.entries(b as Record<string, unknown>).map(([k, v]) => [k, walk(v, co[k])]));
    }
    return b;
  };
  return { value: walk(backup, current), kept, dropped };
}

// --- Manifest ----------------------------------------------------------------------------------------------

export type TableSummary = { name: string; rows: number; policy: string; bytes: number; secretsRedacted: number; omittedColumns: string[] };
export type ExcludedTable = { name: string; reason: string };

export type Manifest = {
  format: typeof FORMAT;
  formatVersion: number;
  backupId: string;
  name: string;
  type: BackupType;
  trigger: string;
  status: "completed";
  site: { id: string; host: string; url: string };
  createdAt: string;
  completedAt: string;
  createdBy: string;
  application: { name: string; version: string; gitSha: string; schemaVersion: string | null; migrations: number };
  database: {
    type: "postgresql";
    serverVersion: string;
    export: string;
    snapshotAt: string;
    tables: number;
    rows: number;
    bytes: number;
    secretsRedacted: number;
    excludedTables: ExcludedTable[];
    perTable: TableSummary[];
  } | null;
  uploads: { files: number; bytes: number; root: string; excludedPrefixes: string[]; referencedMissing: number } | null;
  components: Component[];
  files: { entries: number; uncompressedBytes: number };
  encryption: { encrypted: boolean; method: string | null; key: string | null };
  checksums: { algorithm: "sha256"; file: "checksums/SHA256SUMS"; sha256: string; entries: number };
  restore: { formatVersions: number[]; requires: string[]; secretsNotIncluded: string[] };
  warnings: string[];
  signature?: { algorithm: "HMAC-SHA256"; keyId: string; value: string };
};

/** JSON with object keys sorted at every level: what the signature covers. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const SIGNATURE_KEY_ID = "backup-manifest-v2";

/** The manifest signed with `key` (derived from SETTINGS_ENCRYPTION_KEY, so only this site, or one with its key, can sign). */
export function signManifest(m: Omit<Manifest, "signature">, key: string): Manifest {
  const value = createHmac("sha256", key).update(canonicalJson(m)).digest("hex");
  return { ...m, signature: { algorithm: "HMAC-SHA256", keyId: SIGNATURE_KEY_ID, value } };
}

export function manifestSignatureValid(m: Manifest, key: string): boolean {
  const sig = m.signature;
  if (!sig || sig.algorithm !== "HMAC-SHA256" || typeof sig.value !== "string" || !/^[0-9a-f]{64}$/.test(sig.value)) return false;
  const rest: Partial<Manifest> = { ...m };
  delete rest.signature;
  const expected = createHmac("sha256", key).update(canonicalJson(rest)).digest();
  return timingSafeEqual(expected, Buffer.from(sig.value, "hex"));
}

/** SHA256SUMS lines ("<hex>  <path>"), the format `sha256sum -c` reads. */
export function formatSums(sums: Map<string, string>): string {
  return [...sums].map(([path, hex]) => `${hex}  ${path}\n`).join("");
}

export function parseSums(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m || out.has(m[2]!)) return null;
    out.set(m[2]!, m[1]!);
  }
  return out;
}

// --- Retention --------------------------------------------------------------------------------------------

export type RetainedBackup = { name: string; type: BackupType | "legacy"; createdAt: Date };

/**
 * Which backups retention removes: per type (full, database, before-a-restore), everything after the newest `keep`,
 * and, when `maxAgeDays` is set, anything older than that, but never the newest backup of a type, never one in
 * `protect` (being restored or verified), and never an old-format backup (an admin deletes those by hand).
 */
export function selectForRetention(backups: RetainedBackup[], opts: { keep: number; maxAgeDays: number | null; now: Date; protect: Set<string> }): string[] {
  const out: string[] = [];
  for (const type of BACKUP_TYPES) {
    const mine = backups.filter((b) => b.type === type).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    mine.forEach((b, i) => {
      if (i === 0 || opts.protect.has(b.name)) return;
      const tooMany = i >= Math.max(1, opts.keep);
      const tooOld = opts.maxAgeDays != null && opts.now.getTime() - b.createdAt.getTime() > opts.maxAgeDays * 86_400_000;
      if (tooMany || tooOld) out.push(b.name);
    });
  }
  return out;
}

// --- README -------------------------------------------------------------------------------------------------

export function readme(o: { name: string; host: string; type: BackupType; createdAt: string; encrypted: boolean; components: Component[] }): string {
  return [
    `${o.host} site backup (${TYPE_LABEL[o.type]})`,
    `Archive: ${o.name}`,
    `Created: ${o.createdAt}`,
    `Format: ${FORMAT} version ${FORMAT_VERSION}`,
    "",
    "What is inside",
    ...(o.components.includes("database")
      ? ["  database/         every table of the site's PostgreSQL database at one moment (one consistent snapshot), one",
         "                    JSON object per row (database/tables/<table>.jsonl); database/schema.json lists the tables,",
         "                    their columns, keys and row counts"]
      : []),
    ...(o.components.includes("uploads")
      ? ["  uploads/          every file the site stores in its bucket under jithendar/ (media library, featured and cover",
         "                    images, avatars, documents, site images, invoices, report PDFs), at its bucket key"]
      : []),
    "  application/      settings (secrets redacted), site.json and config/, application version and metadata",
    "  deployment/       environment (secret values are never included), Kubernetes notes and restore requirements",
    "  checksums/        SHA256SUMS: the SHA-256 of every file (check with: sha256sum -c checksums/SHA256SUMS)",
    "  manifest.json     what the archive holds, the checksum of SHA256SUMS and the site's signature",
    "",
    "Not inside, on purpose: password hashes, sign-in sessions, OAuth tokens, API keys, email and reset tokens, and every",
    'credential the site stores encrypted (they appear as {"$secret": "redacted"}). A restore keeps the ones the site has',
    "now; anything else is entered again in the admin. The deployment's secrets (Kubernetes Secret jithendar-com-env and",
    "the others in deployment/restore-requirements.json) are restored from where they are kept, never from a backup.",
    "",
    o.encrypted
      ? "The stored copy is encrypted (AES-256) with a key derived from the site's SETTINGS_ENCRYPTION_KEY. A copy downloaded\nfrom Admin → Backups is decrypted: keep it private, it holds personal data (accounts, comments, messages)."
      : "This archive is not encrypted: anyone with the file can read it. Keep it private: it holds personal data.",
    "",
    "Restore: put the archive in the backup bucket under jithendar/backups/ (where the site stores its backups), then",
    "Admin → Backups → the backup → Restore. The site verifies every checksum and the signature first, and makes a",
    "database backup of its current state before it changes anything. Nothing in this archive is ever executed.",
    "",
  ].join("\n");
}

/** 1536 → "1.5 KB", 3.2e9 → "3.0 GB" (binary units). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
