import type { FileEntry } from "@zip.js/zip.js";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { PRODUCTION_HOST } from "@/config/site";
import { RESTORE_LOCK_ID, backupPasswords, readBackupConfig } from "../backups";
import { lineSink, isFile, multipartSink, openArchive, readEntry, entryText } from "./archive";
import { parentsFirst, policyOf, readCatalog, selfReferences, userColumns, type TableInfo } from "./catalog";
import { BackupCancelled, BackupError } from "./create";
import { BACKUP_ROOT, PLACEHOLDER_MARK, archiveRoot, classifyEntry, fillPlaceholders, siteIdFrom, type Manifest } from "./format";
import { backupStore, mediaStore } from "./store";
import { verifyArchive, type VerifyReport } from "./verify";

/**
 * Restoring a site backup (D-108), in a background job (lib/backup/service.ts) that an admin confirmed:
 *
 *  1. verify the whole archive (lib/backup/verify.ts): nothing is restored from an archive that fails; one that is not
 *     signed by this site (another SETTINGS_ENCRYPTION_KEY) only with the admin's explicit choice, and then nobody
 *     gets a staff role from it;
 *  2. check it fits this site: same site, a schema this version knows (its last migration applied here);
 *  3. back up the current database first (a "before a restore" backup): the restore can itself be undone;
 *  4. files: every file of the archive the bucket does not have (or has with another size) is put back at its key.
 *     Nothing in the bucket is deleted or replaced: keys are unique per upload, so a file the bucket has is that file;
 *  5. the database, in ONE transaction (all or nothing): the tables the backup holds, parents first, by policy
 *     (lib/backup/catalog.ts). replace: every row deleted, the backup's inserted; accounts merged (missing ones added,
 *     none changed); the audit log only gains entries. Sealed credentials come back as the site holds them now
 *     ({"$secret": "redacted"} in the archive). Account ids are remapped by email when an account exists under
 *     another id. Sequences are moved past the restored ids. Every replaced table must end with exactly the backup's
 *     row count, or nothing is committed.
 *
 * Readers keep seeing the old content until the transaction commits (PostgreSQL MVCC: a DELETE does not block a
 * SELECT); writes to the same rows wait; background jobs pause while a restore runs. Not zero-downtime for writers.
 * Nothing from the archive is executed or written to the disk.
 */

export type RestoreComponents = { database: boolean; uploads: boolean };

export type Compatibility = { ok: boolean; problems: string[]; warnings: string[] };

/** Whether an archive's manifest can be restored here (the restore page shows this before anything runs). */
export async function compatibility(m: Manifest, wanted: RestoreComponents): Promise<Compatibility> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const here = siteIdFrom(PRODUCTION_HOST);
  if (m.site?.id !== here) problems.push(`it is a backup of ${m.site?.host ?? "another site"}, not of ${PRODUCTION_HOST}`);
  if (wanted.database && !m.components.includes("database")) problems.push("it holds no database");
  if (wanted.uploads && !m.components.includes("uploads")) problems.push("it holds no files (a database-only backup)");
  const db = await getDb();
  const applied = new Set(rowsOf<{ name: string }>(await db.execute(sql`select name from schema_migrations`)).map((r) => r.name));
  const v = m.application?.schemaVersion;
  if (wanted.database && v && !applied.has(v)) problems.push(`it was made by a newer version of the site (its last migration, ${v}, is not applied here): deploy that version first`);
  if (wanted.database && m.database) {
    const [{ version } = { version: "" }] = rowsOf<{ version: string }>(await db.execute(sql`select current_setting('server_version') as version`));
    const major = (s: string) => Number.parseInt(s, 10) || 0;
    if (major(m.database.serverVersion) > major(version)) warnings.push(`it comes from PostgreSQL ${m.database.serverVersion}; this database runs ${version}`);
  }
  if (m.warnings?.length) warnings.push(...m.warnings.map((w) => `when it was made: ${w}`));
  return { ok: problems.length === 0, problems, warnings };
}

export type DatabaseRestore = {
  tables: Record<string, number>;
  usersAdded: number;
  accountsAdded: number;
  rolesRestored: number;
  rolesNotRestored: number;
  remappedAccounts: number;
  secretsKept: number;
  secretsCleared: number;
  notInBackup: string[];
  notRestored: { table: string; reason: string }[];
};
export type UploadsRestore = { restored: number; alreadyThere: number; bytes: number };
export type RestoreResult = { safetyBackup: string; signed: boolean; verification: VerifyReport; compatibility: Compatibility; database: DatabaseRestore | null; uploads: UploadsRestore | null };

export type RestoreOptions = {
  name: string;
  components: RestoreComponents;
  /** Restore an archive whose signature does not verify (made with another SETTINGS_ENCRYPTION_KEY). */
  allowUnsigned: boolean;
  /** The archive's SHA-256 recorded when it was made (its sidecar): checked like Verify does. */
  expectedSha256?: string | null;
  /** Makes the "before a restore" backup and returns its name. */
  safety: () => Promise<string>;
  progress?: (p: { phase: string; message: string; done?: number; total?: number; bytes?: number }) => void;
  cancelled?: () => boolean;
};

const SIGNATURE_PROBLEM = /^the manifest(?: is not signed|'s signature does not match)/;
const CHUNK_ROWS = 1000;
const CHUNK_BYTES = 4 * 1024 * 1024;

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const progress = opts.progress ?? (() => undefined);
  const c = await readBackupConfig();
  if (!c.r2) throw new BackupError("Backups are not configured.");
  const store = await backupStore(c.r2.bucket);

  // 1. Verify everything.
  progress({ phase: "verifying", message: "Checking the archive: structure, signature and every checksum" });
  const verification = await verifyArchive(store, opts.name, {
    passwords: backupPasswords(c),
    expectedSha256: opts.expectedSha256 ?? null,
    cancelled: opts.cancelled,
    onProgress: (done, total) => progress({ phase: "verifying", message: `Checking file ${done} of ${total}`, done, total }),
  });
  const onlySignature = verification.problems.length > 0 && verification.problems.every((p) => SIGNATURE_PROBLEM.test(p));
  if (!verification.ok && !(onlySignature && opts.allowUnsigned)) {
    throw new BackupError(`Not restored: the archive failed verification (${verification.problems.slice(0, 3).join("; ")}).`);
  }
  const signed = verification.signature === "valid";
  const manifest = verification.manifest!;

  // 2. Does it fit this site?
  const compat = await compatibility(manifest, opts.components);
  if (!compat.ok) throw new BackupError(`Not restored: ${compat.problems.join("; ")}.`);
  if (opts.cancelled?.()) throw new BackupCancelled("Cancelled by an admin before anything changed.");

  // 3. The safety net. If it cannot be made, nothing is restored.
  progress({ phase: "safety", message: "Backing up the current database first" });
  const safetyBackup = await opts.safety();
  if (opts.cancelled?.()) throw new BackupCancelled("Cancelled by an admin before anything changed (the safety backup was kept).");

  const key = `${BACKUP_ROOT}/${opts.name}`;
  const archive = await openArchive(store, key);
  try {
    const root = `${archiveRoot(opts.name)}/`;
    const byRel = new Map<string, FileEntry>();
    for (const e of archive.entries) if (isFile(e) && e.filename.startsWith(root)) byRel.set(e.filename.slice(root.length), e);
    const password = verification.password;

    // 4. Files.
    let uploads: UploadsRestore | null = null;
    if (opts.components.uploads) uploads = await restoreUploads(byRel, password, progress);

    // 5. The database.
    let database: DatabaseRestore | null = null;
    if (opts.components.database) database = await restoreDatabase(byRel, password, manifest, signed, progress);

    return { safetyBackup, signed, verification, compatibility: compat, database, uploads };
  } finally {
    await archive.close().catch(() => undefined);
  }
}

type IndexLine = { key: string; size: number; contentType: string | null; cacheControl: string | null };

async function restoreUploads(byRel: Map<string, FileEntry>, password: string | undefined, progress: NonNullable<RestoreOptions["progress"]>): Promise<UploadsRestore> {
  const media = await mediaStore();
  const meta = new Map<string, IndexLine>();
  const idx = byRel.get("uploads-index.jsonl");
  if (idx) {
    const sink = lineSink((line) => {
      const l = JSON.parse(line) as IndexLine;
      if (typeof l.key === "string") meta.set(l.key, l);
    });
    await readEntry(idx, password, (c) => sink.write(c));
    await sink.end();
  }
  const files = [...byRel].map(([rel, entry]) => ({ rel, entry, kind: classifyEntry(rel) })).filter((f) => !("reject" in f.kind) && f.kind.kind === "upload");
  const out: UploadsRestore = { restored: 0, alreadyThere: 0, bytes: 0 };
  for (const [i, f] of files.entries()) {
    const objectKey = (f.kind as { key: string }).key;
    if (i % 20 === 0) progress({ phase: "uploads", message: `Putting files back: ${i} of ${files.length} checked`, done: i, total: files.length });
    const there = await media.head(objectKey);
    if (there && there.size === f.entry.uncompressedSize) {
      out.alreadyThere++;
      continue;
    }
    const m = meta.get(objectKey);
    const contentType = m?.contentType || "application/octet-stream";
    const cacheControl = m?.cacheControl || "public, max-age=31536000, immutable";
    if (f.entry.uncompressedSize <= 8 * 1024 * 1024) {
      const parts: Uint8Array[] = [];
      await readEntry(f.entry, password, (c) => void parts.push(c.slice()));
      await media.put(objectKey, Buffer.concat(parts), contentType, cacheControl);
    } else {
      const sink = multipartSink(await media.multipart(objectKey, contentType, cacheControl));
      const w = sink.writable.getWriter();
      try {
        await readEntry(f.entry, password, (c) => w.write(c));
        await w.close();
      } catch (e) {
        await sink.abort();
        throw e;
      }
    }
    out.restored++;
    out.bytes += f.entry.uncompressedSize;
  }
  progress({ phase: "uploads", message: `Files: ${out.restored} put back, ${out.alreadyThere} already there`, done: files.length, total: files.length });
  return out;
}

type SchemaDoc = { tables: { name: string; columns: { name: string }[] }[] };

async function restoreDatabase(byRel: Map<string, FileEntry>, password: string | undefined, manifest: Manifest, signed: boolean, progress: NonNullable<RestoreOptions["progress"]>): Promise<DatabaseRestore> {
  if (!manifest.database) throw new BackupError("The archive holds no database.");
  const schemaEntry = byRel.get("database/schema.json");
  if (!schemaEntry) throw new BackupError("The archive has no database/schema.json.");
  const schemaDoc = JSON.parse(await entryText(schemaEntry, password, 64 * 1024 * 1024)) as SchemaDoc;
  const backupColumns = new Map(schemaDoc.tables.map((t) => [t.name, new Set(t.columns.map((col) => col.name))]));
  const backupRows = new Map(manifest.database.perTable.map((t) => [t.name, t]));

  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    await tx.execute(sql`set local lock_timeout = '60s'`);
    await tx.execute(sql`set local idle_in_transaction_session_timeout = '15min'`);
    const [{ locked } = { locked: false }] = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${RESTORE_LOCK_ID}) as locked`));
    if (!locked) throw new BackupError("Another restore is running.");

    const catalog = await readCatalog(tx);
    const byName = new Map(catalog.map((t) => [t.name, t]));
    const notRestored: DatabaseRestore["notRestored"] = [];
    const restorable: TableInfo[] = [];
    for (const t of manifest.database!.perTable) {
      const info = byName.get(t.name);
      if (!info) notRestored.push({ table: t.name, reason: "this version of the site has no such table" });
      else if (policyOf(t.name).mode === "exclude") notRestored.push({ table: t.name, reason: "never restored (credentials or deployment state)" });
      else if (!byRel.has(`database/tables/${t.name}.jsonl`)) throw new BackupError(`The archive has no rows file for ${t.name}.`);
      else restorable.push(info);
    }
    const inBackup = new Set(restorable.map((t) => t.name));
    const notInBackup = catalog.filter((t) => !inBackup.has(t.name) && policyOf(t.name).mode !== "exclude" && !backupRows.has(t.name)).map((t) => t.name);
    const order = parentsFirst(restorable);
    const replace = order.filter((n) => policyOf(n).mode === "replace");
    const replaced = new Set(replace);

    // The sealed credentials the site holds now, for the rows whose backup has placeholders (settings rows: small).
    const current = new Map<string, Map<string, unknown>>();
    for (const name of order) {
      if (!(backupRows.get(name)?.secretsRedacted ?? 0)) continue;
      const t = byName.get(name)!;
      if (!t.primaryKey.length) continue;
      const m = new Map<string, unknown>();
      for (const r of rowsOf<{ j: string }>(await tx.execute(sql`select to_jsonb(t)::text as j from ${sql.identifier(name)} t`))) {
        const row = JSON.parse(r.j) as Record<string, unknown>;
        m.set(JSON.stringify(t.primaryKey.map((k) => row[k])), row);
      }
      current.set(name, m);
    }

    // Rows that would block deleting a replaced table (a foreign key without ON DELETE CASCADE from a table the backup
    // does not restore) belong to state that is not backed up: they go first.
    for (const t of catalog) {
      if (replaced.has(t.name) || inBackup.has(t.name)) continue;
      for (const f of t.foreignKeys) {
        if (!replaced.has(f.refTable) || f.onDelete === "c") continue;
        if (f.onDelete === "n" || f.onDelete === "d") continue; // SET NULL / SET DEFAULT: PostgreSQL handles it
        await tx.execute(sql`delete from ${sql.identifier(t.name)} where ${sql.join(f.columns.map((col) => sql`${sql.identifier(col)} is not null`), sql` and `)}`);
      }
    }

    progress({ phase: "database", message: `Clearing ${replace.length} tables` });
    for (const name of [...replace].reverse()) await tx.execute(sql`delete from ${sql.identifier(name)}`);

    // Accounts first (everything else points at them).
    const result: DatabaseRestore = { tables: {}, usersAdded: 0, accountsAdded: 0, rolesRestored: 0, rolesNotRestored: 0, remappedAccounts: 0, secretsKept: 0, secretsCleared: 0, notInBackup, notRestored };
    const before = new Set(rowsOf<{ id: string }>(await tx.execute(sql`select id from "user"`)).map((u) => u.id));
    const backupUsers: { id: string; email: string; role: string }[] = [];
    let idMapJson = "{}";
    const recreated = new Set<string>();

    const insertTable = async (t: TableInfo, i: number) => {
      const policy = policyOf(t.name);
      const entry = byRel.get(`database/tables/${t.name}.jsonl`)!;
      const had = backupColumns.get(t.name);
      const omit = new Set(policy.mode === "merge" ? (policy.omit ?? []) : []);
      const cols = t.columns.filter((col) => !col.generated && (!had || had.has(col.name)) && !omit.has(col.name));
      if (!cols.length) return;
      const userCols = new Set(t.name === "user" ? [] : userColumns(t));
      const deferred = new Set(selfReferences(t).flatMap((f) => f.columns.filter((col) => t.columns.find((x) => x.name === col)?.nullable)));
      for (const f of selfReferences(t)) {
        if (!f.columns.some((col) => deferred.has(col))) throw new BackupError(`${t.name} references itself through columns that cannot be empty; it cannot be restored row by row.`);
      }
      const remap = idMapJson !== "{}";
      const select = sql.join(
        cols.map((col) => {
          const id = sql.identifier(col.name);
          if (deferred.has(col.name)) return sql`null`;
          if (remap && userCols.has(col.name)) return sql`coalesce(${idMapJson}::jsonb ->> r.${id}::text, r.${id})`;
          if (t.name === "user" && col.name === "role") return signed ? sql`r.${id}` : sql`'user'`;
          return sql`r.${id}`;
        }),
        sql`, `,
      );
      const list = sql.join(cols.map((col) => sql.identifier(col.name)), sql`, `);
      const overriding = cols.some((col) => col.identity === "a") ? sql` overriding system value` : sql``;
      const conflict = policy.mode === "replace" ? sql`` : sql` on conflict do nothing`;
      // Accounts are only added for the people this restore recreated: an existing account's sign-in methods stay.
      const filter = t.name === "account" ? sql` where r.user_id in (select jsonb_array_elements_text(${JSON.stringify([...recreated])}::jsonb))` : sql``;
      let inserted = 0;
      const flush = async (lines: string[]) => {
        if (!lines.length) return;
        const chunk = `[${lines.join(",")}]`;
        const q: SQL = sql`with ins as (insert into ${sql.identifier(t.name)} (${list})${overriding} select ${select} from jsonb_populate_recordset(null::${sql.identifier(t.name)}, ${chunk}::jsonb) r${filter}${conflict} returning 1) select count(*)::int as n from ins`;
        const [{ n } = { n: 0 }] = rowsOf<{ n: number }>(await tx.execute(q));
        inserted += Number(n);
      };
      const pk = t.primaryKey;
      const mine = current.get(t.name);
      let batch: string[] = [];
      let size = 0;
      let rows = 0;
      const sink = lineSink(async (line) => {
        let text = line;
        if (t.name === "user") {
          const u = JSON.parse(line) as { id: string; email: string; role: string };
          backupUsers.push({ id: String(u.id), email: String(u.email), role: String(u.role ?? "user") });
        }
        if (mine && line.includes(PLACEHOLDER_MARK)) {
          const row = JSON.parse(line) as Record<string, unknown>;
          const filled = fillPlaceholders(row, mine.get(JSON.stringify(pk.map((k) => row[k]))));
          result.secretsKept += filled.kept;
          result.secretsCleared += filled.dropped;
          text = JSON.stringify(filled.value);
        } else if (line.includes(PLACEHOLDER_MARK)) {
          const filled = fillPlaceholders(JSON.parse(line), undefined);
          result.secretsCleared += filled.dropped;
          text = JSON.stringify(filled.value);
        }
        batch.push(text);
        size += text.length;
        rows++;
        if (batch.length >= CHUNK_ROWS || size >= CHUNK_BYTES) {
          const b = batch;
          batch = [];
          size = 0;
          await flush(b);
        }
      });
      progress({ phase: "database", message: `Restoring ${t.name}`, done: i, total: order.length });
      await readEntry(entry, password, (chunk) => sink.write(chunk));
      await sink.end();
      await flush(batch);

      // Self-references (comment replies): every row is in, now each one gets its parent back.
      if (deferred.size) {
        if (!pk.length) throw new BackupError(`${t.name} has no primary key; its self-references cannot be restored.`);
        const sets = sql.join([...deferred].map((col) => sql`${sql.identifier(col)} = r.${sql.identifier(col)}`), sql`, `);
        const match = sql.join(pk.map((k) => sql`x.${sql.identifier(k)} = r.${sql.identifier(k)}`), sql` and `);
        const any = sql.join([...deferred].map((col) => sql`r.${sql.identifier(col)} is not null`), sql` or `);
        let lines: string[] = [];
        const update = async () => {
          if (!lines.length) return;
          const chunk = `[${lines.join(",")}]`;
          lines = [];
          await tx.execute(sql`update ${sql.identifier(t.name)} x set ${sets} from jsonb_populate_recordset(null::${sql.identifier(t.name)}, ${chunk}::jsonb) r where ${match} and (${any})`);
        };
        const again = lineSink(async (line) => {
          lines.push(line);
          if (lines.length >= CHUNK_ROWS) await update();
        });
        await readEntry(entry, password, (chunk) => again.write(chunk));
        await again.end();
        await update();
      }

      // Sequences past the restored ids (serial and identity columns).
      for (const col of t.columns.filter((x) => x.sequence)) {
        await tx.execute(
          sql`select setval(pg_get_serial_sequence(${`"${t.name}"`}, ${col.name}), greatest(coalesce((select max(${sql.identifier(col.name)}) from ${sql.identifier(t.name)}), 0), 1), (select count(*) > 0 from ${sql.identifier(t.name)}))`,
        );
      }
      result.tables[t.name] = inserted;
      if (policy.mode === "replace" && inserted !== rows) throw new BackupError(`${t.name}: ${inserted} of the backup's ${rows} rows went in; nothing was restored.`);
      const expected = backupRows.get(t.name)?.rows;
      if (expected !== undefined && rows !== expected) throw new BackupError(`${t.name}: the archive holds ${rows} rows, its manifest says ${expected}; nothing was restored.`);
    };

    let i = 0;
    for (const name of order) {
      const t = byName.get(name)!;
      await insertTable(t, i++);
      if (name === "user") {
        const now = rowsOf<{ id: string; email: string }>(await tx.execute(sql`select id, email from "user"`));
        for (const u of now) if (!before.has(u.id)) recreated.add(u.id);
        const byEmail = new Map(now.map((u) => [u.email.toLowerCase(), u.id]));
        const map: Record<string, string> = {};
        for (const u of backupUsers) {
          const to = byEmail.get(u.email.toLowerCase());
          if (to && to !== u.id) map[u.id] = to;
        }
        result.remappedAccounts = Object.keys(map).length;
        idMapJson = JSON.stringify(map);
        result.usersAdded = recreated.size;
        const staff = backupUsers.filter((u) => recreated.has(u.id) && u.role !== "user");
        if (signed) result.rolesRestored = staff.length;
        else result.rolesNotRestored = staff.length;
      }
      if (name === "account") result.accountsAdded = result.tables.account ?? 0;
    }
    return result;
  });
}
