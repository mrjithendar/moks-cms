import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ZipWriter } from "@zip.js/zip.js";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { PRODUCTION_HOST, siteUrl } from "@/config/site";
import { siteConfigDir } from "@/config/site-files";
import { readBackupConfig, serverBackupPassword } from "../backups";
import { derivedSecret } from "../secrets";
import { hashed, multipartSink } from "./archive";
import { policyOf, readCatalog, type TableInfo } from "./catalog";
import {
  BACKUP_ROOT,
  EXCLUDED_OBJECT_PREFIXES,
  FORMAT,
  FORMAT_VERSION,
  SITE_OBJECT_ROOT,
  TYPE_COMPONENTS,
  archiveName,
  archiveRoot,
  formatBytes,
  formatSums,
  readme,
  redactSealed,
  safeObjectKey,
  sidecarName,
  signManifest,
  siteIdFrom,
  type BackupType,
  type ExcludedTable,
  type Manifest,
  type TableSummary,
} from "./format";
import { backupStore, mediaStore, type ObjectStore, type StoreObject } from "./store";
import { verifyArchive, type VerifyReport } from "./verify";

/**
 * Making a site backup (D-108). Runs in a background job (lib/backup/service.ts), never in a request:
 *
 *  1. what the uploads part will hold is listed first, so the size check covers the whole archive;
 *  2. the database: every table of the schema (lib/backup/catalog.ts) read in ONE read-only REPEATABLE READ
 *     transaction, so every table is as it was at one moment (rows that point at each other always match), through a
 *     cursor, 1,000 rows at a time, as JSON Lines. Sealed credentials become {"$secret": "redacted"} and the
 *     columns a policy omits (sign-in secrets) never leave the database;
 *  3. every file under jithendar/ in the media bucket (not the backups, not the expiring AI images), at its key;
 *  4. configuration and deployment metadata (no secret values), SHA256SUMS and the signed manifest;
 *  5. the archive is streamed to the backup bucket as a multipart upload and only exists there once complete;
 *  6. it is read back and verified in full (structure, signature, every checksum) before the backup counts as made;
 *     a backup that fails verification is deleted. Only then is the sidecar (<name>.json) written.
 *
 * Nothing is written to the pod's disk. A failure aborts the upload (or deletes the object) and leaves no archive.
 */

export class BackupError extends Error {}
export class BackupCancelled extends Error {}

export type Progress = { phase: string; message: string; done?: number; total?: number; bytes?: number; percent?: number };

export type CreateOptions = {
  type: BackupType;
  trigger: "manual" | "scheduled" | "flow" | "pre-restore";
  backupId: string;
  createdBy: string;
  progress?: (p: Progress) => void;
  /** Checked between tables and files (never waits on the database inside the export's transaction). */
  cancelled?: () => boolean;
  now?: () => Date;
};

export type CreateResult = { name: string; key: string; bucket: string; size: number; sha256: string; manifest: Manifest; verification: VerifyReport; warnings: string[] };

const ROWS_PER_FETCH = 1000;
/** R2/S3: at most 10,000 parts of 16 MiB. */
const MAX_ARCHIVE_BYTES = 150 * 1024 ** 3;

/** Values that may be copied into deployment/environment.json; every other variable is listed by name only. */
const SAFE_ENV_VALUES = [
  "SITE_URL",
  "APP_ENV",
  "NODE_ENV",
  "TRUSTED_EDGE",
  "LOG_LEVEL",
  "OTEL_SERVICE_NAME",
  "ASK_BLOG_ENABLED",
  "SEO_ORCHESTRATOR",
  "SEO_AGENT_CALLBACK_PORT",
  "CREWAI_CONFIG_REPO",
  "CREWAI_CONFIG_BRANCH",
  "CREWAI_CONFIG_PATH",
  "RAG_COLLECTION",
  "RAG_SERVICE_NAME",
  "PRACTICE_CATALOG_PATH",
  "GEMINI_IMAGE_SIZE",
  "R2_BUCKET",
  "S3_REGION",
  "S3_BUCKET",
  "GIT_SHA",
];
/**
 * A name that may hold a credential: never its value, even if it were added to the allowlist by mistake. (Only
 * allowlisted names get a value at all, so connection strings such as DATABASE_URL never do.)
 */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|DSN|URI)/;

/** The deployment's secrets a recovery needs, and why (deployment/restore-requirements.json, docs/BACKUPS.md). */
export const REQUIRED_SECRETS: { name: string; where: string; why: string }[] = [
  { name: "SETTINGS_ENCRYPTION_KEY", where: "Secret jithendar-com-env", why: "opens encrypted archives, checks their signature and unseals the credentials the database stores; without the same key a restore needs every credential entered again" },
  { name: "BETTER_AUTH_SECRET", where: "Secret jithendar-com-env", why: "signs sign-in sessions" },
  { name: "DATABASE_URL", where: "Secret postgres-db-credentials (Terraform, miniKube repo)", why: "the database to restore into" },
  { name: "R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (or S3_*)", where: "Secret jithendar-com-env, or Settings → Media & storage", why: "the bucket the media and the backups live in" },
  { name: "SEO_AGENT_CALLBACK_TOKEN, SEO_AGENT_TOKEN", where: "Secrets jithendar-com-env and seo-agent-env", why: "the web app and the SEO agent talk to each other" },
  { name: "ADMIN_BOOTSTRAP_TOKEN", where: "Secret jithendar-com-env", why: "the first admin of a new deployment (to sign in and restore)" },
  { name: "Provider and integration keys (Anthropic, Gemini, Google service account, Razorpay, Turnstile, email, Hybrid RAG, CrewAI repository token)", where: "Secrets, or the admin (Settings)", why: "redacted in the archive; a restore keeps those the site has now" },
];

function environmentReport() {
  const values: Record<string, string> = {};
  const set: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || v === undefined) continue;
    if (SAFE_ENV_VALUES.includes(k) && !SECRET_NAME.test(k)) values[k] = v;
    else set.push(k);
  }
  return { note: "Values only for variables that never hold a credential; every other variable is named, never shown.", values, alsoSet: set.sort() };
}

function siteFiles(): { rel: string; text: string }[] {
  const dir = siteConfigDir();
  const out: { rel: string; text: string }[] = [];
  const read = (file: string, rel: string) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= 1024 * 1024) out.push({ rel, text: fs.readFileSync(file, "utf8") });
    } catch {
      /* not there: nothing to keep */
    }
  };
  read(path.join(dir, "site.json"), "site-files/site.json");
  try {
    for (const f of fs.readdirSync(path.join(dir, "config")).sort()) if (/^[a-z0-9][a-z0-9._-]{0,80}\.json$/.test(f)) read(path.join(dir, "config", f), `site-files/config/${f}`);
  } catch {
    /* no config/ */
  }
  return out;
}

const encoder = new TextEncoder();

/** The objects a full backup holds: everything under jithendar/ except the backups and the expiring AI images. */
export async function siteObjects(media: ObjectStore): Promise<{ objects: StoreObject[]; skipped: string[] }> {
  const skipped: string[] = [];
  const objects = (await media.list(SITE_OBJECT_ROOT)).filter((o) => {
    if (EXCLUDED_OBJECT_PREFIXES.some((p) => o.key.startsWith(p))) return false;
    if (!safeObjectKey(o.key)) {
      skipped.push(o.key);
      return false;
    }
    return true;
  });
  objects.sort((a, b) => a.key.localeCompare(b.key));
  return { objects, skipped };
}

export async function createBackup(opts: CreateOptions): Promise<CreateResult> {
  const now = opts.now ?? (() => new Date());
  const progress = opts.progress ?? (() => undefined);
  const stop = () => {
    if (opts.cancelled?.()) throw new BackupCancelled("Cancelled by an admin.");
  };
  const c = await readBackupConfig();
  if (!c.r2 || !c.r2.enabled) throw new BackupError("Turn on the backup destination first (Settings → System → Backups).");
  const store = await backupStore(c.r2.bucket);
  const components = TYPE_COMPONENTS[opts.type];
  const withUploads = components.includes("uploads");
  const media = withUploads ? await mediaStore() : null;
  const warnings: string[] = [];

  const startedAt = now();
  const host = PRODUCTION_HOST;
  const siteId = siteIdFrom(host);
  const name = archiveName(siteId, opts.type, startedAt);
  const key = `${BACKUP_ROOT}/${name}`;
  const root = archiveRoot(name);
  const password = c.encrypt ? serverBackupPassword() : undefined;

  // 1. What the archive will hold, and whether it may be made.
  progress({ phase: "preparing", message: "Listing the site's files and measuring the database" });
  const listed = media ? await siteObjects(media) : { objects: [], skipped: [] };
  if (listed.skipped.length) warnings.push(`${listed.skipped.length} file(s) with a name the site never writes were left out (e.g. ${JSON.stringify(listed.skipped[0]!.slice(0, 120))})`);
  const uploadBytes = listed.objects.reduce((n, o) => n + o.size, 0);
  const db = await getDb();
  const [{ bytes: dbBytes } = { bytes: 0 }] = rowsOf<{ bytes: number }>(await db.execute(sql`select pg_database_size(current_database())::float8 as bytes`)).map((r) => ({ bytes: Number(r.bytes) }));
  const estimate = uploadBytes + dbBytes;
  const limit = c.maxSizeMb ? c.maxSizeMb * 1024 * 1024 : null;
  if (limit && estimate > limit) {
    throw new BackupError(`Not started: the backup would be about ${mb(estimate)} (database ${mb(dbBytes)}, files ${mb(uploadBytes)}), more than the ${mb(limit)} allowed in Settings → System → Backups.`);
  }
  if (estimate > MAX_ARCHIVE_BYTES) throw new BackupError(`Not started: about ${mb(estimate)} is more than one archive can hold (${mb(MAX_ARCHIVE_BYTES)}).`);

  // 2. The archive, streamed to the bucket. Only one backup operation runs at a time, so an unfinished upload under
  // the backups prefix belongs to an attempt whose pod stopped: it is aborted first (it would never complete).
  const abandoned = await store.abortIncomplete(`${BACKUP_ROOT}/`).catch(() => 0);
  if (abandoned) warnings.push(`${abandoned} unfinished upload(s) of an interrupted backup were removed`);
  const sink = multipartSink(await store.multipart(key, "application/zip"));
  const out = sink.writable.getWriter();
  let written = 0;
  const counted = new WritableStream<Uint8Array>({
    async write(chunk) {
      written += chunk.length;
      if (limit && written > limit * 1.05) throw new BackupError(`Stopped: the archive passed the ${mb(limit)} allowed in Settings → System → Backups.`);
      await out.write(chunk);
    },
    close: () => out.close(),
    abort: (reason) => out.abort(reason).catch(() => undefined),
  });
  const zip = new ZipWriter(counted, { level: 6, keepOrder: true });
  const sums = new Map<string, string>();
  let entries = 0;
  let uncompressed = 0;
  const add = async (rel: string, data: ReadableStream<Uint8Array> | string, o: { level?: number; plain?: boolean; modified?: Date } = {}) => {
    const h = hashed(typeof data === "string" ? new Blob([encoder.encode(data)]).stream() : data);
    await zip.add(`${root}/${rel}`, h.stream, { level: o.level ?? 6, lastModDate: o.modified ?? startedAt, ...(password && !o.plain ? { password, encryptionStrength: 3 as const } : {}) });
    const d = h.done();
    sums.set(rel, d.sha256);
    entries++;
    uncompressed += d.bytes;
    return d;
  };

  try {
    await add("README.txt", readme({ name, host, type: opts.type, createdAt: startedAt.toISOString(), encrypted: Boolean(password), components }), { plain: true });

    // 3. The database, from one snapshot.
    const snap = await db.transaction(
      async (tx) => {
        await tx.execute(sql`set local statement_timeout = 0`);
        await tx.execute(sql`set local idle_in_transaction_session_timeout = '15min'`);
        const [meta] = rowsOf<{ at: string; version: string }>(await tx.execute(sql`select now()::text as at, current_setting('server_version') as version`));
        const ledger = rowsOf<{ name: string }>(await tx.execute(sql`select name from schema_migrations order by name`));
        const schemaVersion = ledger.at(-1)?.name ?? null;
        const migrations = ledger.length;
        const references = new Set<string>();
        const catalog = await readCatalog(tx);
        const excluded: ExcludedTable[] = [];
        const perTable: TableSummary[] = [];
        const kept = catalog.filter((t) => {
          const p = policyOf(t.name);
          if (p.mode === "exclude") excluded.push({ name: t.name, reason: p.reason });
          return p.mode !== "exclude";
        });
        const schemaDoc: { tables: (TableInfo & { policy: string; rows?: number })[] } = { tables: [] };
        let i = 0;
        for (const t of kept) {
          stop();
          i++;
          progress({ phase: "database", message: `Exporting table ${t.name}`, done: i - 1, total: kept.length });
          const p = policyOf(t.name);
          const omit = p.mode === "merge" ? (p.omit ?? []).filter((col) => t.columns.some((x) => x.name === col)) : [];
          const cursor = `backup_c${i}`;
          const select = omit.length
            ? sql`select (to_jsonb(t) - ${`{${omit.join(",")}}`}::text[])::text as j from ${sql.identifier(t.name)} t`
            : sql`select to_jsonb(t)::text as j from ${sql.identifier(t.name)} t`;
          await tx.execute(sql`declare ${sql.identifier(cursor)} no scroll cursor for ${select}`);
          let rows = 0;
          let redacted = 0;
          let done = false;
          const stream = new ReadableStream<Uint8Array>({
            async pull(ctl) {
              if (done) return ctl.close();
              const batch = rowsOf<{ j: string }>(await tx.execute(sql`fetch ${sql.raw(String(ROWS_PER_FETCH))} from ${sql.identifier(cursor)}`));
              if (batch.length < ROWS_PER_FETCH) done = true;
              if (batch.length === 0) return ctl.close();
              let text = "";
              for (const r of batch) {
                const { text: line, count } = redactSealed(r.j);
                redacted += count;
                text += line + "\n";
              }
              rows += batch.length;
              ctl.enqueue(encoder.encode(text));
            },
          });
          const d = await add(`database/tables/${t.name}.jsonl`, stream);
          await tx.execute(sql`close ${sql.identifier(cursor)}`);
          perTable.push({ name: t.name, rows, policy: p.mode, bytes: d.bytes, secretsRedacted: redacted, omittedColumns: omit });
          schemaDoc.tables.push({ ...t, policy: p.mode, rows });
        }
        for (const t of excluded) {
          const info = catalog.find((x) => x.name === t.name)!;
          schemaDoc.tables.push({ ...info, policy: "exclude" });
        }
        schemaDoc.tables.sort((a, b) => a.name.localeCompare(b.name));
        await add("database/schema.json", JSON.stringify({ dialect: "postgresql", serverVersion: meta?.version ?? "", schemaVersion, migrations, snapshotAt: meta?.at, ...schemaDoc }, null, 1));

        // Settings for people (the same rows are in database/tables/setting.jsonl): secrets redacted the same way.
        const [s] = rowsOf<{ j: string }>(await tx.execute(sql`select json_build_object('settings', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from setting), 'appearance', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from site_config c))::text as j`));
        const settingsJson = redactSealed(s?.j ?? "{}").text;

        // Files the database points at, to check that each one is in the archive.
        if (withUploads) {
          const cols = catalog.flatMap((t) => t.columns.filter((col) => col.type === "text" && /^(storage_key|pdf_key|object_key|file_key)$/.test(col.name)).map((col) => [t.name, col.name] as const));
          for (const [table, col] of cols) {
            const ks = rowsOf<{ k: string }>(await tx.execute(sql`select distinct ${sql.identifier(col)} as k from ${sql.identifier(table)} where ${sql.identifier(col)} like ${`${SITE_OBJECT_ROOT}%`}`));
            for (const r of ks) references.add(r.k);
          }
        }
        const database: NonNullable<Manifest["database"]> = {
          type: "postgresql",
          serverVersion: meta?.version ?? "",
          export: "to_jsonb JSON Lines from one REPEATABLE READ, READ ONLY transaction (a consistent snapshot)",
          snapshotAt: meta?.at ?? startedAt.toISOString(),
          tables: perTable.length,
          rows: perTable.reduce((n, t) => n + t.rows, 0),
          bytes: perTable.reduce((n, t) => n + t.bytes, 0),
          secretsRedacted: perTable.reduce((n, t) => n + t.secretsRedacted, 0),
          excludedTables: excluded,
          perTable,
        };
        return { database, settingsJson, schemaVersion, migrations, references };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const { database, settingsJson, schemaVersion, migrations, references } = snap;

    // 4. The site's files.
    let uploads: Manifest["uploads"] = null;
    if (media) {
      const index: string[] = [];
      let bytes = 0;
      const total = listed.objects.length;
      const present = new Set<string>();
      for (const [n, o] of listed.objects.entries()) {
        stop();
        progress({ phase: "uploads", message: `Adding file ${(n + 1).toLocaleString("en")} of ${total.toLocaleString("en")}`, done: n, total, bytes });
        const r = await retry(() => media.read(o.key));
        if (!r) {
          warnings.push(`${o.key} was deleted while the backup ran`);
          continue;
        }
        const d = await add(`uploads/${o.key}`, r.body, { level: 0, modified: o.lastModified ? new Date(o.lastModified) : startedAt });
        bytes += d.bytes;
        present.add(o.key);
        index.push(JSON.stringify({ key: o.key, size: d.bytes, sha256: d.sha256, contentType: r.contentType, cacheControl: r.cacheControl, lastModified: o.lastModified }));
      }
      await add("uploads-index.jsonl", index.length ? index.join("\n") + "\n" : "");
      const missing = [...references].filter((k) => !present.has(k) && !EXCLUDED_OBJECT_PREFIXES.some((p) => k.startsWith(p)));
      if (missing.length) warnings.push(`${missing.length} file(s) the database points at are not in the bucket (e.g. ${missing[0]}): they could not be backed up`);
      uploads = { files: present.size, bytes, root: SITE_OBJECT_ROOT, excludedPrefixes: [...EXCLUDED_OBJECT_PREFIXES], referencedMissing: missing.length };
    }

    // 5. Configuration and deployment metadata.
    progress({ phase: "application", message: "Adding configuration and deployment metadata" });
    await add("application/settings.json", settingsJson);
    for (const f of siteFiles()) await add(`application/${f.rel}`, f.text);
    const application = { name: "moks-cms", version: process.env.npm_package_version ?? "0.1.0", gitSha: process.env.GIT_SHA ?? "dev", schemaVersion, migrations };
    await add("application/metadata.json", JSON.stringify({ application, node: process.version, site: { host, url: siteUrl() }, createdAt: startedAt.toISOString() }, null, 1));
    await add("deployment/environment.json", JSON.stringify(environmentReport(), null, 1));
    await add(
      "deployment/kubernetes.json",
      JSON.stringify(
        {
          note: "What the backup could see of its deployment. The web app keeps no data on its pods: everything is in PostgreSQL and the bucket, so no persistent volume needs restoring.",
          namespace: process.env.POD_NAMESPACE ?? null,
          pod: process.env.HOSTNAME ?? null,
          persistentVolumes: [],
          stateful: ["PostgreSQL database (CloudNativePG cluster, database of DATABASE_URL)", "object storage bucket (R2_BUCKET or S3_BUCKET, and the backup bucket)"],
          manifests: "Deployment, Services, ConfigMaps and NetworkPolicies are in the site's own repository (kubernetes/); they are not copied here.",
        },
        null,
        1,
      ),
    );
    await add(
      "deployment/restore-requirements.json",
      JSON.stringify({ formatVersion: FORMAT_VERSION, schemaVersion, databaseServerVersion: database.serverVersion, secrets: REQUIRED_SECRETS }, null, 1),
    );

    // 6. Checksums and the manifest.
    progress({ phase: "finalizing", message: "Writing checksums and the manifest" });
    const sumsText = formatSums(sums);
    const sumsSha = createHash("sha256").update(sumsText).digest("hex");
    const sumCount = sums.size;
    await add("checksums/SHA256SUMS", sumsText);
    const completedAt = now();
    const manifest = signManifest(
      {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        backupId: opts.backupId,
        name,
        type: opts.type,
        trigger: opts.trigger,
        status: "completed",
        site: { id: siteId, host, url: siteUrl() },
        createdAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        createdBy: opts.createdBy,
        application,
        database,
        uploads,
        components,
        files: { entries: entries + 1, uncompressedBytes: uncompressed },
        encryption: password ? { encrypted: true, method: "WinZip AES-256 (AE-2), every file except README.txt", key: "derived from SETTINGS_ENCRYPTION_KEY" } : { encrypted: false, method: null, key: null },
        checksums: { algorithm: "sha256", file: "checksums/SHA256SUMS", sha256: sumsSha, entries: sumCount },
        restore: {
          formatVersions: [FORMAT_VERSION],
          requires: [
            `a site whose database has migration ${schemaVersion ?? "(none)"} or later applied`,
            "the same SETTINGS_ENCRYPTION_KEY, for an encrypted archive and for the signature",
            `PostgreSQL ${database.serverVersion.split(" ")[0]} or later`,
          ],
          secretsNotIncluded: REQUIRED_SECRETS.map((s) => s.name),
        },
        warnings,
      },
      derivedSecret("backup-manifest-v2"),
    );
    await add("manifest.json", JSON.stringify(manifest, null, 1));
    await zip.close();
  } catch (error) {
    await sink.abort();
    throw error;
  }

  // 7. Read it back and check everything before it counts.
  const { size, sha256 } = sink.result();
  progress({ phase: "verifying", message: "Reading the archive back and checking every file", bytes: size });
  let verification: VerifyReport;
  try {
    verification = await verifyArchive(store, name, {
      passwords: password ? [password] : [],
      expectedSha256: sha256,
      cancelled: opts.cancelled,
      onProgress: (done, total) => progress({ phase: "verifying", message: `Checking file ${done} of ${total}`, done, total, bytes: size }),
    });
  } catch (error) {
    await store.remove(key).catch(() => undefined);
    throw error;
  }
  if (!verification.ok) {
    await store.remove(key).catch(() => undefined);
    throw new BackupError(`The archive failed verification and was deleted: ${verification.problems.slice(0, 3).join("; ")}`);
  }
  const manifest = verification.manifest!;
  await store.put(`${BACKUP_ROOT}/${sidecarName(name)}`, encoder.encode(JSON.stringify({ manifest, archive: { name, bucket: store.bucket, key, size, sha256 }, verifiedAt: verification.checkedAt }, null, 1)), "application/json");
  return { name, key, bucket: store.bucket, size, sha256, manifest, verification, warnings };
}

const mb = formatBytes;

/** Transient storage errors (5xx, throttling, resets) get two more tries with a short pause. */
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
      const transient = status >= 500 || status === 429 || /ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN/i.test(String((error as Error).message));
      if (!transient || attempt >= tries) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}
