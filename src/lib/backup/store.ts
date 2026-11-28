import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { s3ForBucket } from "../storage";

/**
 * The object storage a site backup reads from and writes to: the media bucket (the files a full backup holds, and where
 * a restore puts them back) and the backup bucket (the archives), both through the media storage account's
 * S3-compatible API (Cloudflare R2, Amazon S3 or any S3-compatible service such as MinIO).
 *
 * Archives never touch the pod's disk (read-only root, a 64 MiB /tmp): they are streamed to the bucket as a multipart
 * upload and read back by byte range. tests/fake-backup-store.ts is the in-memory stand-in.
 */
export type StoreObject = { key: string; size: number; lastModified: string | null };
export type ObjectRead = { body: ReadableStream<Uint8Array>; size: number; contentType: string | null; cacheControl: string | null };
export type Multipart = { uploadPart: (partNumber: number, data: Uint8Array) => Promise<void>; complete: () => Promise<void>; abort: () => Promise<void> };

export interface ObjectStore {
  readonly bucket: string;
  list(prefix: string): Promise<StoreObject[]>;
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** The object (or bytes `start`..`end`, both inclusive), or null when it does not exist. */
  read(key: string, start?: number, end?: number): Promise<ObjectRead | null>;
  put(key: string, data: Uint8Array, contentType: string, cacheControl?: string): Promise<void>;
  remove(key: string): Promise<void>;
  multipart(key: string, contentType: string, cacheControl?: string): Promise<Multipart>;
  /** Abort every unfinished multipart upload under `prefix` (left by a backup whose pod stopped); how many. */
  abortIncomplete(prefix: string): Promise<number>;
}

const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
/** Backups are private: no CDN or browser may keep a copy. */
export const PRIVATE = "private, no-store";

function s3Store(s3: S3Client, Bucket: string): ObjectStore {
  return {
    bucket: Bucket,
    async list(prefix) {
      const out: StoreObject[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0), lastModified: o.LastModified?.toISOString() ?? null });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? null };
      } catch (e) {
        if (status(e) === 404) return null;
        throw e;
      }
    },
    async read(key, start, end) {
      try {
        const range = start === undefined ? undefined : `bytes=${start}-${end ?? ""}`;
        const r = await s3.send(new GetObjectCommand({ Bucket, Key: key, ...(range ? { Range: range } : {}) }));
        if (!r.Body) return null;
        return { body: r.Body.transformToWebStream() as ReadableStream<Uint8Array>, size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? null, cacheControl: r.CacheControl ?? null };
      } catch (e) {
        if (status(e) === 404 || status(e) === 416) return null;
        throw e;
      }
    },
    async put(key, data, contentType, cacheControl = PRIVATE) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: data, ContentType: contentType, CacheControl: cacheControl, ContentLength: data.length }));
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async multipart(key, contentType, cacheControl = PRIVATE) {
      const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, CacheControl: cacheControl }));
      if (!UploadId) throw new Error("the storage service did not start the upload");
      const parts: { PartNumber: number; ETag: string }[] = [];
      return {
        async uploadPart(PartNumber, data) {
          const r = await s3.send(new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber, Body: data, ContentLength: data.length }));
          if (!r.ETag) throw new Error(`the storage service did not confirm part ${PartNumber}`);
          parts.push({ PartNumber, ETag: r.ETag });
        },
        async complete() {
          parts.sort((a, b) => a.PartNumber - b.PartNumber);
          await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }));
        },
        async abort() {
          await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId }));
        },
      };
    },
    async abortIncomplete(prefix) {
      let n = 0;
      let KeyMarker: string | undefined;
      let UploadIdMarker: string | undefined;
      do {
        const r = await s3.send(new ListMultipartUploadsCommand({ Bucket, Prefix: prefix, KeyMarker, UploadIdMarker }));
        for (const u of r.Uploads ?? []) {
          if (!u.Key || !u.UploadId) continue;
          await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: u.Key, UploadId: u.UploadId })).catch(() => undefined);
          n++;
        }
        KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
        UploadIdMarker = r.IsTruncated ? r.NextUploadIdMarker : undefined;
      } while (KeyMarker);
      return n;
    },
  };
}

/** Where the archives live: `bucket` from Settings → Backups, "" for the media bucket. */
export async function backupStore(bucket: string): Promise<ObjectStore> {
  const { s3, bucket: name } = await s3ForBucket(bucket);
  return s3Store(s3, name);
}

/** The media bucket: what a full backup holds under jithendar/, and where a restore puts files back. */
export async function mediaStore(): Promise<ObjectStore> {
  const { s3, mediaBucket } = await s3ForBucket("");
  return s3Store(s3, mediaBucket);
}
