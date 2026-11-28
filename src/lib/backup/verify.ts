import { createHash } from "node:crypto";
import type { Entry, FileEntry } from "@zip.js/zip.js";
import { derivedSecret } from "../secrets";
import { entryText, isFile, openArchive, readEntry } from "./archive";
import {
  BACKUP_ROOT,
  FORMAT,
  FORMAT_VERSION,
  archiveRoot,
  classifyEntry,
  isSymlinkAttributes,
  manifestSignatureValid,
  parseArchiveName,
  parseSums,
  type EntryKind,
  type Manifest,
} from "./format";
import type { ObjectStore } from "./store";

/**
 * Checking a site backup archive (D-108) without trusting it: after every backup, on Verify, and before every restore.
 *
 * - structure: a zip whose every entry sits in the archive's root folder and is a file this format writes (no other
 *   folder, no "..", no absolute or Windows path, no symbolic link, no two entries with one name);
 * - the manifest: this format and version, and signed by this site (HMAC with a key derived from
 *   SETTINGS_ENCRYPTION_KEY): an archive somebody changed, or one another site made, is not "valid";
 * - SHA256SUMS: its checksum is the one the manifest names; it lists every file, and every file it lists is there;
 * - every file: decrypted and hashed, its SHA-256 must be the listed one (zip.js also checks each entry's CRC or AES
 *   authentication code);
 * - the archive's own SHA-256 when it is known (the sidecar), read in one pass.
 * `ok` only when every check passed and the signature is valid.
 */

export type VerifyReport = {
  ok: boolean;
  checkedAt: string;
  problems: string[];
  signature: "valid" | "invalid" | "missing" | "unknown";
  encrypted: boolean;
  files: number;
  bytes: number;
  archiveSize: number | null;
  archiveSha256: string | null;
  manifest: Manifest | null;
};

export type VerifiedEntry = { entry: FileEntry; rel: string; kind: EntryKind };

export type VerifyOptions = {
  /** Passwords to try for an encrypted archive (the server key; an old passphrase). */
  passwords: string[];
  /** The archive's SHA-256 from its sidecar, when there is one: checked with one more read of the whole object. */
  expectedSha256?: string | null;
  /** false: only the structure, manifest and sums (the restore page's quick look); the default checks every file. */
  contents?: boolean;
  cancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
};

const MAX_ENTRIES = 2_000_000;
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_SUMS = 512 * 1024 * 1024;

export async function verifyArchive(store: ObjectStore, name: string, opts: VerifyOptions): Promise<VerifyReport & { password: string | undefined }> {
  const problems: string[] = [];
  const report = (extra: Partial<VerifyReport> = {}) => ({
    ok: false,
    checkedAt: new Date().toISOString(),
    problems,
    signature: "unknown" as VerifyReport["signature"],
    encrypted: false,
    files: 0,
    bytes: 0,
    archiveSize: null,
    archiveSha256: null,
    manifest: null,
    password: undefined as string | undefined,
    ...extra,
  });
  const parsed = parseArchiveName(name);
  if (!parsed || parsed.legacy) {
    problems.push("not the name of a full site backup");
    return report();
  }
  const key = `${BACKUP_ROOT}/${name}`;
  const head = await store.head(key);
  if (!head) {
    problems.push("the archive is not in the backup bucket");
    return report();
  }

  let archive: Awaited<ReturnType<typeof openArchive>>;
  try {
    archive = await openArchive(store, key, head.size);
  } catch (e) {
    problems.push(`not a readable zip archive (${(e as Error).message})`);
    return report({ archiveSize: head.size });
  }
  try {
    const root = `${archiveRoot(name)}/`;
    const all: Entry[] = archive.entries;
    if (all.length > MAX_ENTRIES) problems.push(`more than ${MAX_ENTRIES.toLocaleString("en")} entries`);
    const files: VerifiedEntry[] = [];
    for (const e of all) {
      if (!e.filename.startsWith(root)) {
        problems.push(`an entry outside the archive's folder: ${JSON.stringify(e.filename.slice(0, 120))}`);
        continue;
      }
      if (isSymlinkAttributes(e.externalFileAttributes)) {
        problems.push(`a symbolic link: ${JSON.stringify(e.filename.slice(0, 120))}`);
        continue;
      }
      const rel = e.filename.slice(root.length);
      if (!isFile(e)) {
        // A folder entry (another zip tool may add them) holds nothing; its name must still be harmless.
        if (rel && (rel.split("/").some((s) => s === "..") || rel.startsWith("/"))) problems.push(`a folder with an unsafe name: ${JSON.stringify(rel.slice(0, 120))}`);
        continue;
      }
      const kind = classifyEntry(rel);
      if ("reject" in kind) {
        problems.push(`the archive holds ${kind.reject}`);
        continue;
      }
      files.push({ entry: e, rel, kind });
    }
    if (problems.length) return report({ archiveSize: head.size });

    const find = (k: EntryKind["kind"]) => files.find((f) => f.kind.kind === k);
    const manifestEntry = find("manifest");
    const sumsEntry = find("sums");
    if (!manifestEntry) problems.push("no manifest.json");
    if (!sumsEntry) problems.push("no checksums/SHA256SUMS");
    if (!manifestEntry || !sumsEntry) return report({ archiveSize: head.size });

    // Which password opens it: the first that decrypts the manifest (README.txt is never encrypted).
    const encrypted = files.some((f) => f.entry.encrypted);
    let password: string | undefined;
    let manifestText: string | null = null;
    if (manifestEntry.entry.encrypted) {
      for (const pw of opts.passwords) {
        try {
          manifestText = await entryText(manifestEntry.entry, pw, MAX_MANIFEST);
          password = pw;
          break;
        } catch {
          /* the next one */
        }
      }
      if (manifestText === null) {
        problems.push("the archive is encrypted with a key this site does not have (another SETTINGS_ENCRYPTION_KEY)");
        return report({ encrypted, archiveSize: head.size });
      }
    } else {
      manifestText = await entryText(manifestEntry.entry, undefined, MAX_MANIFEST);
    }

    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestText) as Manifest;
    } catch {
      problems.push("manifest.json is not valid JSON");
      return report({ encrypted, archiveSize: head.size });
    }
    if (manifest.format !== FORMAT) problems.push(`not a ${FORMAT} archive`);
    if (manifest.formatVersion !== FORMAT_VERSION) problems.push(`format version ${manifest.formatVersion}; this site reads version ${FORMAT_VERSION}`);
    if (manifest.name !== name) problems.push(`the manifest belongs to ${JSON.stringify(String(manifest.name).slice(0, 100))}, not to this file name`);
    const signature: VerifyReport["signature"] = !manifest.signature ? "missing" : manifestSignatureValid(manifest, derivedSecret("backup-manifest-v2")) ? "valid" : "invalid";
    if (signature !== "valid") problems.push(signature === "missing" ? "the manifest is not signed" : "the manifest's signature does not match: the archive was changed, or another site (another SETTINGS_ENCRYPTION_KEY) made it");

    const sumsText = await entryText(sumsEntry.entry, password, MAX_SUMS);
    if (createHash("sha256").update(sumsText).digest("hex") !== manifest.checksums?.sha256) problems.push("checksums/SHA256SUMS is not the one the manifest names");
    const sums = parseSums(sumsText);
    if (!sums) {
      problems.push("checksums/SHA256SUMS is not in the sha256sum format");
      return report({ encrypted, signature, manifest, archiveSize: head.size });
    }
    const listed = files.filter((f) => f.kind.kind !== "manifest" && f.kind.kind !== "sums");
    const present = new Set(listed.map((f) => f.rel));
    for (const f of listed) if (!sums.has(f.rel)) problems.push(`${f.rel} is not in SHA256SUMS`);
    for (const p of sums.keys()) if (!present.has(p)) problems.push(`${p} is listed in SHA256SUMS but missing from the archive`);
    const tables = listed.filter((f) => f.kind.kind === "table").length;
    const uploads = listed.filter((f) => f.kind.kind === "upload").length;
    if (manifest.database && tables !== manifest.database.tables) problems.push(`the manifest lists ${manifest.database.tables} tables, the archive holds ${tables}`);
    if (manifest.uploads && uploads !== manifest.uploads.files) problems.push(`the manifest lists ${manifest.uploads.files} files, the archive holds ${uploads}`);
    if (!manifest.database && tables) problems.push("database files in an archive whose manifest has no database");

    // Every file's content.
    let bytes = 0;
    if (opts.contents !== false && problems.length < 50) {
      let done = 0;
      for (const f of listed) {
        if (opts.cancelled?.()) {
          problems.push("verification cancelled");
          break;
        }
        const h = createHash("sha256");
        try {
          await readEntry(f.entry, password, (c) => {
            h.update(c);
            bytes += c.length;
          });
          if (h.digest("hex") !== sums.get(f.rel)) problems.push(`${f.rel}: its checksum does not match`);
        } catch (e) {
          problems.push(`${f.rel} could not be read (${(e as Error).message})`);
        }
        if (problems.length >= 50) break;
        done++;
        if (done % 25 === 0 || done === listed.length) opts.onProgress?.(done, listed.length);
      }
    }

    // The archive as a whole, in one read.
    let archiveSha256: string | null = null;
    if (opts.expectedSha256 && opts.contents !== false && problems.length === 0) {
      const r = await store.read(key);
      if (!r) problems.push("the archive disappeared during verification");
      else {
        const h = createHash("sha256");
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          h.update(value);
        }
        archiveSha256 = h.digest("hex");
        if (archiveSha256 !== opts.expectedSha256) problems.push("the archive's SHA-256 is not the one recorded when it was made");
      }
    }

    return {
      ok: problems.length === 0 && signature === "valid",
      checkedAt: new Date().toISOString(),
      problems,
      signature,
      encrypted,
      files: listed.length,
      bytes,
      archiveSize: head.size,
      archiveSha256,
      manifest,
      password,
    };
  } finally {
    await archive.close().catch(() => undefined);
  }
}
