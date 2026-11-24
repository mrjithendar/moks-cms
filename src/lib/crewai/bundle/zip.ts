import { configure, TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";

/**
 * The bundle as a zip (a crewconfig/ folder) and back. Client-safe: the Import page reads an uploaded zip in the browser
 * and sends its files as JSON, so the server never unpacks archives. Text files only; anything else in a zip is skipped.
 */

configure({ useWebWorkers: false });

export const ZIP_ROOT = "crewconfig/";
const MAX_FILES = 2000;
const MAX_BYTES = 8 * 1024 * 1024;

export async function zipFiles(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { level: 6 });
  for (const p of Object.keys(files).sort()) await zip.add(`${ZIP_ROOT}${p}`, new TextReader(files[p]!));
  return zip.close();
}

/** The files of a zip, paths relative to its crewconfig/ folder (or to its root when it has none). */
export async function unzipFiles(bytes: Uint8Array): Promise<Record<string, string>> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = (await reader.getEntries()).filter((e) => !e.directory);
    if (entries.length > MAX_FILES) throw new Error(`The zip has more than ${MAX_FILES} files.`);
    const total = entries.reduce((n, e) => n + (e.uncompressedSize ?? 0), 0);
    if (total > MAX_BYTES) throw new Error(`The zip unpacks to more than ${MAX_BYTES / 1024 / 1024} MB.`);
    const names = entries.map((e) => e.filename.replace(/\\/g, "/"));
    const root = names.every((n) => n.startsWith(ZIP_ROOT)) ? ZIP_ROOT : names.find((n) => n.endsWith("/manifest.json"))?.replace(/manifest\.json$/, "") ?? "";
    const out: Record<string, string> = {};
    for (const e of entries) {
      const name = e.filename.replace(/\\/g, "/");
      if (!name.startsWith(root) || !/\.(ya?ml|md|json)$/i.test(name) || name.includes("__MACOSX/")) continue;
      out[name.slice(root.length)] = await e.getData!(new TextWriter());
    }
    return out;
  } finally {
    await reader.close();
  }
}
