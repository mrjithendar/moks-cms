import { ZipWriter } from "@zip.js/zip.js";
import { actorOf } from "@/lib/admin";
import { audit } from "@/lib/audit";
import { entryText, isFile, openArchive } from "@/lib/backup/archive";
import { BACKUP_ROOT, isBackupName } from "@/lib/backup/format";
import { backupStore, type ObjectStore } from "@/lib/backup/store";
import { backupPasswords, isLegacyBackup, plainCopyOfStoredBackup, readBackupConfig } from "@/lib/backups";
import { handleErrors } from "@/lib/http-errors";
import { log } from "@/lib/log";
import { PostError } from "@/lib/posts";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Download a stored backup (`?file=<name>`, admins only), always as a zip the owner can open with any tool. A full site
 * backup that is stored encrypted (AES-256 with a key derived from SETTINGS_ENCRYPTION_KEY, which nobody holds outside
 * the server) is decrypted on the way: each entry is read from the bucket by byte range and written to the response as
 * it comes, so a backup of any size streams without filling memory or disk. An unencrypted one is passed through as it
 * is. Backups of format 1 (content only) are small and are converted in memory as before.
 */
export const GET = handleErrors("backup download", async (request?: Request) => {
  const user = await getSessionUser();
  // A backup is the whole site: never for a demo account, even though it otherwise sees what an admin sees.
  if (!user || user.role !== "admin" || user.demo) return new Response("Forbidden", { status: 403 });
  const name = request ? new URL(request.url).searchParams.get("file") : null;
  if (!name || !isBackupName(name)) return new Response("Choose a stored backup (Admin → Backups).", { status: 400 });
  try {
    const headers = { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name.replace(/\.json\.gz\.enc$/, ".zip")}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (isLegacyBackup(name)) {
      const data = await plainCopyOfStoredBackup(name);
      await audit(actorOf(user), "backup.download", name, { format: 1, unencrypted: true });
      return new Response(new Uint8Array(data), { headers });
    }
    const c = await readBackupConfig();
    if (!c.r2) throw new PostError("Backups are not configured.", 404);
    const store = await backupStore(c.r2.bucket);
    const key = `${BACKUP_ROOT}/${name}`;
    const head = await store.head(key);
    if (!head) throw new PostError("That backup is not in the bucket.", 404);
    const archive = await openArchive(store, key, head.size);
    const encrypted = archive.entries.some((e) => e.encrypted);
    await archive.close();
    await audit(actorOf(user), "backup.download", name, { format: 2, storedEncrypted: encrypted, sizeBytes: head.size });
    if (!encrypted) {
      const r = await store.read(key);
      if (!r) throw new PostError("That backup is not in the bucket.", 404);
      return new Response(r.body, { headers: { ...headers, "Content-Length": String(head.size) } });
    }
    return new Response(decrypted(store, key, head.size, backupPasswords(c)), { headers });
  } catch (error) {
    if (error instanceof PostError) return new Response(error.message, { status: error.status ?? 400 });
    throw error;
  }
});

/** A plain zip of an encrypted archive, entry by entry, as a stream (same names, dates and compression). */
function decrypted(store: ObjectStore, key: string, size: number, passwords: string[]): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    const archive = await openArchive(store, key, size);
    try {
      // The server key first; a passphrase from before 2026-11-18 for archives made with it.
      const manifest = archive.entries.find((e) => e.filename.endsWith("/manifest.json"));
      let password = passwords[0];
      if (manifest && isFile(manifest) && manifest.encrypted) {
        for (const pw of passwords) {
          const ok = await entryText(manifest, pw, 16 * 1024 * 1024).then(() => true, () => false);
          if (ok) {
            password = pw;
            break;
          }
        }
      }
      const out = new ZipWriter(writable, { keepOrder: true });
      for (const e of archive.entries) {
        if (!isFile(e)) continue;
        const pipe = new TransformStream<Uint8Array, Uint8Array>();
        const reading = e.getData(pipe.writable, { password: e.encrypted ? password : undefined, checkSignature: true });
        await Promise.all([out.add(e.filename, pipe.readable, { level: e.compressionMethod === 0 ? 0 : 6, lastModDate: e.lastModDate }), reading]);
      }
      await out.close();
    } catch (error) {
      log.warn("backup download stopped", { operation: "backup_download", err: error });
      await writable.abort(error).catch(() => undefined);
    } finally {
      await archive.close().catch(() => undefined);
    }
  })();
  return readable;
}
