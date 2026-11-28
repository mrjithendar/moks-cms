// A small S3 API emulator for tests and local runs: path-style requests (as the site sends to R2 and custom
// endpoints), no signature checks. Enough of the API for site backups and media: ListObjectsV2, HEAD, GET with Range,
// PUT, DELETE, and multipart uploads (create, upload part, complete, abort, list). Objects live in memory.
//
//   node tests/s3-emulator.mjs 9100      # standalone, for `next dev` with R2_ENDPOINT=http://127.0.0.1:9100
//   import { startS3Emulator } from "./s3-emulator.mjs"   # in a test
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function startS3Emulator(port = 0) {
  /** bucket → key → { body, contentType, cacheControl, lastModified, etag } */
  const buckets = new Map();
  /** uploadId → { bucket, key, parts: Map<number, Buffer>, contentType, cacheControl } */
  const uploads = new Map();
  const bucket = (b) => {
    if (!buckets.has(b)) buckets.set(b, new Map());
    return buckets.get(b);
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://s3");
    const [, b, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const q = url.searchParams;
    const send = (status, payload = "", headers = {}) => {
      res.writeHead(status, { "content-type": "application/xml", ...headers });
      res.end(payload);
    };
    const objects = bucket(decodeURIComponent(b ?? ""));
    try {
      if (req.method === "GET" && !key && q.get("list-type") === "2") {
        const prefix = q.get("prefix") ?? "";
        const max = Number(q.get("max-keys") ?? 1000);
        const after = q.get("continuation-token") ?? "";
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = all.slice(0, max);
        const truncated = all.length > page.length;
        const contents = page.map((k) => { const o = objects.get(k); return `<Contents><Key>${esc(k)}</Key><LastModified>${o.lastModified}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.body.length}</Size></Contents>`; }).join("");
        return send(200, xml(`<ListBucketResult><Name>${esc(b)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${esc(page.at(-1))}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`));
      }
      if (req.method === "GET" && !key && q.has("uploads")) {
        const prefix = q.get("prefix") ?? "";
        const list = [...uploads].filter(([, u]) => u.bucket === b && u.key.startsWith(prefix)).map(([id, u]) => `<Upload><Key>${esc(u.key)}</Key><UploadId>${id}</UploadId></Upload>`).join("");
        return send(200, xml(`<ListMultipartUploadsResult><Bucket>${esc(b)}</Bucket><IsTruncated>false</IsTruncated>${list}</ListMultipartUploadsResult>`));
      }
      if (req.method === "POST" && q.has("uploads")) {
        const id = randomUUID();
        uploads.set(id, { bucket: b, key, parts: new Map(), contentType: req.headers["content-type"] ?? "application/octet-stream", cacheControl: req.headers["cache-control"] ?? "" });
        return send(200, xml(`<InitiateMultipartUploadResult><Bucket>${esc(b)}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`));
      }
      if (req.method === "PUT" && q.has("uploadId")) {
        const u = uploads.get(q.get("uploadId"));
        if (!u) return send(404, xml("<Error><Code>NoSuchUpload</Code></Error>"));
        u.parts.set(Number(q.get("partNumber")), body);
        return send(200, "", { etag: `"${createHash("md5").update(body).digest("hex")}"` });
      }
      if (req.method === "POST" && q.has("uploadId")) {
        const u = uploads.get(q.get("uploadId"));
        if (!u) return send(404, xml("<Error><Code>NoSuchUpload</Code></Error>"));
        const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
        const parts = numbers.map((n) => u.parts.get(n));
        const sizes = parts.slice(0, -1).map((p) => p.length);
        if (parts.some((p) => !p) || new Set(sizes).size > 1) return send(400, xml("<Error><Code>InvalidPart</Code></Error>"));
        const data = Buffer.concat(parts);
        bucket(u.bucket).set(u.key, { body: data, contentType: u.contentType, cacheControl: u.cacheControl, lastModified: new Date().toISOString(), etag: createHash("md5").update(data).digest("hex") });
        uploads.delete(q.get("uploadId"));
        return send(200, xml(`<CompleteMultipartUploadResult><Bucket>${esc(b)}</Bucket><Key>${esc(key)}</Key></CompleteMultipartUploadResult>`));
      }
      if (req.method === "DELETE" && q.has("uploadId")) {
        uploads.delete(q.get("uploadId"));
        return send(204);
      }
      if (req.method === "PUT") {
        objects.set(key, { body, contentType: req.headers["content-type"] ?? "application/octet-stream", cacheControl: req.headers["cache-control"] ?? "", lastModified: new Date().toISOString(), etag: createHash("md5").update(body).digest("hex") });
        return send(200, "", { etag: `"${objects.get(key).etag}"` });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return send(204);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const o = objects.get(key);
        if (!o) return send(404, req.method === "HEAD" ? "" : xml("<Error><Code>NoSuchKey</Code></Error>"));
        let data = o.body;
        let status = 200;
        const headers = { "content-type": o.contentType, "last-modified": new Date(o.lastModified).toUTCString(), etag: `"${o.etag}"`, ...(o.cacheControl ? { "cache-control": o.cacheControl } : {}) };
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Math.min(Number(range[2]), o.body.length - 1) : o.body.length - 1;
          if (start >= o.body.length) return send(416, xml("<Error><Code>InvalidRange</Code></Error>"));
          data = o.body.subarray(start, end + 1);
          status = 206;
          headers["content-range"] = `bytes ${start}-${end}/${o.body.length}`;
        }
        res.writeHead(status, { ...headers, "content-length": String(data.length), "accept-ranges": "bytes" });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      send(400, xml("<Error><Code>NotImplemented</Code></Error>"));
    } catch (e) {
      send(500, xml(`<Error><Code>InternalError</Code><Message>${esc(e.message)}</Message></Error>`));
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ port: server.address().port, buckets, uploads, close: () => new Promise((r) => server.close(r)) })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startS3Emulator(Number(process.argv[2] ?? 9100));
  console.log(`S3 emulator on http://127.0.0.1:${s.port}`);
}
