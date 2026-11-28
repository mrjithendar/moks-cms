import { createHash } from "node:crypto";
import { configure, Reader, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";
import type { Multipart, ObjectStore } from "./store";

// zip.js would otherwise start Web Workers, which the Node server does not have.
configure({ useWebWorkers: false });

/**
 * Streaming zip plumbing for site backups (D-108): the archive goes to the bucket as it is written and is read back by
 * byte range, so its size never depends on the pod's memory or disk.
 */

/** R2 wants every part but the last of one size; 16 MiB keeps one part in memory and allows archives up to 160 GB. */
export const PART_SIZE = 16 * 1024 * 1024;

/**
 * A WritableStream that uploads what it receives as parts of exactly `partSize` bytes and completes the upload on close.
 * The object appears in the bucket only when the upload completes (the archive is finished, never half-written);
 * abort() cancels the upload, leaving nothing behind. Hashes the bytes on the way: the archive's own SHA-256.
 */
export function multipartSink(mp: Multipart, partSize = PART_SIZE) {
  const hash = createHash("sha256");
  let size = 0;
  let part = 1;
  let pending: Uint8Array[] = [];
  let buffered = 0;
  let digest: string | null = null;
  let state: "open" | "completed" | "aborted" = "open";

  const upload = async (n: number) => {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = pending[0]!;
      const take = Math.min(c.length, n - off);
      out.set(c.subarray(0, take), off);
      off += take;
      if (take === c.length) pending.shift();
      else pending[0] = c.subarray(take);
    }
    buffered -= n;
    await mp.uploadPart(part++, out);
  };

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      hash.update(chunk);
      size += chunk.length;
      pending.push(chunk.slice()); // zip.js may reuse the buffer it wrote from
      buffered += chunk.length;
      while (buffered >= partSize) await upload(partSize);
    },
    async close() {
      if (buffered > 0 || part === 1) await upload(buffered);
      await mp.complete();
      state = "completed";
      digest = hash.digest("hex");
    },
    async abort() {
      pending = [];
      if (state === "open") {
        state = "aborted";
        await mp.abort().catch(() => undefined);
      }
    },
  });
  return {
    writable,
    get state() {
      return state;
    },
    /** After close: the archive's size and SHA-256. */
    result: () => {
      if (digest === null) throw new Error("the archive is not finished");
      return { size, sha256: digest };
    },
    /** Cancel the upload when the archive could not be finished (safe to call more than once). */
    abort: async () => {
      if (state !== "open") return;
      state = "aborted";
      pending = [];
      await mp.abort().catch(() => undefined);
    },
  };
}

/** A stream passed through unchanged, with the SHA-256 and length of what went through. */
export function hashed(stream: ReadableStream<Uint8Array>) {
  const h = createHash("sha256");
  let bytes = 0;
  let digest: string | null = null;
  const out = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        h.update(chunk);
        bytes += chunk.length;
        ctl.enqueue(chunk);
      },
    }),
  );
  return {
    stream: out,
    done: () => {
      digest ??= h.digest("hex");
      return { sha256: digest, bytes };
    },
  };
}

const READ_AHEAD = 1024 * 1024;

async function collect(body: ReadableStream<Uint8Array>, limit = Infinity): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  const r = body.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (n > limit) {
      await r.cancel().catch(() => undefined);
      throw new Error("more data than expected");
    }
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * zip.js Reader over an object in the bucket: small reads (headers, the central directory) by byte range with 1 MiB of
 * read-ahead, an entry's data as one ranged GET stream.
 */
export class StoreReader extends Reader<string> {
  private cache: { start: number; data: Uint8Array } | null = null;

  constructor(
    private readonly store: ObjectStore,
    private readonly key: string,
    private readonly knownSize?: number,
  ) {
    super(key);
  }

  async init() {
    if (this.knownSize !== undefined) this.size = this.knownSize;
    else {
      const head = await this.store.head(this.key);
      if (!head) throw new Error("the archive is not in the bucket");
      this.size = head.size;
    }
  }

  async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const end = Math.min(index + length, this.size);
    if (end <= index) return new Uint8Array(0);
    const c = this.cache;
    if (c && index >= c.start && end <= c.start + c.data.length) return c.data.slice(index - c.start, end - c.start);
    const fetchEnd = Math.min(this.size, Math.max(end, index + READ_AHEAD));
    const r = await this.store.read(this.key, index, fetchEnd - 1);
    if (!r) throw new Error("the archive is no longer in the bucket");
    const data = await collect(r.body, fetchEnd - index);
    this.cache = { start: index, data };
    return data.slice(0, end - index);
  }

  createReadable(options: { offset?: number; size?: number } = {}): ReadableStream<Uint8Array> {
    const offset = options.offset ?? 0;
    const size = options.size ?? this.size - offset;
    const { store, key } = this;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    return new ReadableStream<Uint8Array>({
      async pull(ctl) {
        if (size <= 0) return ctl.close();
        if (!reader) {
          const r = await store.read(key, offset, offset + size - 1);
          if (!r) throw new Error("the archive is no longer in the bucket");
          reader = r.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) ctl.close();
        else ctl.enqueue(value);
      },
      async cancel() {
        await reader?.cancel().catch(() => undefined);
      },
    });
  }
}

export type OpenArchive = { entries: Entry[]; close: () => Promise<void> };

/** The entries of an archive in the bucket (its central directory), with zip.js's strict checks on names and structure. */
export async function openArchive(store: ObjectStore, key: string, size?: number): Promise<OpenArchive> {
  const zip = new ZipReader(new StoreReader(store, key, size));
  try {
    const entries = await zip.getEntries({ filenameValidation: "strict", checkAmbiguity: true });
    return { entries, close: () => zip.close() };
  } catch (error) {
    await zip.close().catch(() => undefined);
    throw error;
  }
}

export const isFile = (e: Entry): e is FileEntry => !e.directory;

/** An entry's decrypted content, chunk by chunk, into `sink` (which may wait: the archive is read as fast as it consumes). */
export async function readEntry(entry: FileEntry, password: string | undefined, sink: (chunk: Uint8Array) => Promise<void> | void): Promise<void> {
  await entry.getData(new WritableStream<Uint8Array>({ write: (c) => sink(c) }), { password: entry.encrypted ? password : undefined, checkSignature: true });
}

/** A small entry as text (manifest, sums, schema), refusing more than `maxBytes`. */
export async function entryText(entry: FileEntry, password: string | undefined, maxBytes: number): Promise<string> {
  if (entry.uncompressedSize > maxBytes) throw new Error(`${entry.filename} is larger than expected`);
  const parts: Uint8Array[] = [];
  let n = 0;
  await readEntry(entry, password, (c) => {
    n += c.length;
    if (n > maxBytes) throw new Error(`${entry.filename} is larger than expected`);
    parts.push(c.slice());
  });
  return Buffer.concat(parts).toString("utf8");
}

/** Feeds `onLine` every line of a text stream (UTF-8), waiting for it; a line over `maxLine` characters is an error. */
export function lineSink(onLine: (line: string) => Promise<void> | void, maxLine = 64 * 1024 * 1024) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let rest = "";
  const take = async (text: string) => {
    rest += text;
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (line) await onLine(line);
    }
    if (rest.length > maxLine) throw new Error("a line in the backup is too long");
  };
  return {
    write: (chunk: Uint8Array) => take(decoder.decode(chunk, { stream: true })),
    end: async () => {
      await take(decoder.decode());
      if (rest) await onLine(rest);
      rest = "";
    },
  };
}
