import type { ObjectStore, StoreObject } from "@/lib/backup/store";

/**
 * In-memory stand-in for lib/backup/store.ts: buckets of objects, multipart uploads that only appear on complete (as
 * on R2/S3), ranged reads, and switches to make a call fail (interrupted backups).
 */
export type FakeObject = { body: Buffer; contentType: string; cacheControl: string; lastModified: string };

export function fakeBuckets() {
  const buckets = new Map<string, Map<string, FakeObject>>();
  const uploads = new Map<string, { bucket: string; key: string; parts: Map<number, Buffer>; contentType: string; cacheControl: string }>();
  const fail = { uploadPart: null as null | ((n: number) => Error | null), read: null as null | ((key: string) => Error | null) };
  const stats = { partSizes: [] as number[], aborted: 0 };
  let seq = 0;
  const bucket = (name: string) => {
    let b = buckets.get(name);
    if (!b) buckets.set(name, (b = new Map()));
    return b;
  };
  const stream = (buf: Buffer) =>
    new ReadableStream<Uint8Array>({
      start(ctl) {
        // Several chunks, like a network body.
        for (let i = 0; i < buf.length; i += 64 * 1024) ctl.enqueue(new Uint8Array(buf.subarray(i, i + 64 * 1024)));
        ctl.close();
      },
    });
  const store = (name: string): ObjectStore => ({
    bucket: name,
    async list(prefix) {
      return [...bucket(name)].filter(([k]) => k.startsWith(prefix)).map(([key, o]): StoreObject => ({ key, size: o.body.length, lastModified: o.lastModified })).sort((a, b) => a.key.localeCompare(b.key));
    },
    async head(key) {
      const o = bucket(name).get(key);
      return o ? { size: o.body.length, contentType: o.contentType } : null;
    },
    async read(key, start, end) {
      const err = fail.read?.(key);
      if (err) throw err;
      const o = bucket(name).get(key);
      if (!o) return null;
      const s = start ?? 0;
      const e = end === undefined ? o.body.length - 1 : Math.min(end, o.body.length - 1);
      const slice = o.body.subarray(s, e + 1);
      return { body: stream(Buffer.from(slice)), size: slice.length, contentType: o.contentType, cacheControl: o.cacheControl };
    },
    async put(key, data, contentType, cacheControl = "private, no-store") {
      bucket(name).set(key, { body: Buffer.from(data), contentType, cacheControl, lastModified: new Date().toISOString() });
    },
    async remove(key) {
      bucket(name).delete(key);
    },
    async multipart(key, contentType, cacheControl = "private, no-store") {
      const id = `u${++seq}`;
      uploads.set(id, { bucket: name, key, parts: new Map(), contentType, cacheControl });
      return {
        async uploadPart(n, data) {
          const err = fail.uploadPart?.(n);
          if (err) throw err;
          stats.partSizes.push(data.length);
          uploads.get(id)!.parts.set(n, Buffer.from(data));
        },
        async complete() {
          const u = uploads.get(id)!;
          const parts = [...u.parts].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
          // R2: every part but the last has one size.
          const sizes = parts.slice(0, -1).map((p) => p.length);
          if (new Set(sizes).size > 1) throw new Error("parts of different sizes");
          bucket(name).set(key, { body: Buffer.concat(parts), contentType: u.contentType, cacheControl: u.cacheControl, lastModified: new Date().toISOString() });
          uploads.delete(id);
        },
        async abort() {
          stats.aborted++;
          uploads.delete(id);
        },
      };
    },
    async abortIncomplete(prefix) {
      let n = 0;
      for (const [id, u] of uploads) if (u.bucket === name && u.key.startsWith(prefix)) {
        uploads.delete(id);
        n++;
      }
      return n;
    },
  });
  return { buckets, bucket, store, uploads, fail, stats };
}
