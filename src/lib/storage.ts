import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { seal, unseal, type Sealed } from "./secrets";
import { traceAwsClient } from "./trace";

/**
 * Media storage: one Cloudflare R2 bucket through its S3-compatible API.
 *
 *   jithendar/www/media/{kind}/{yyyy}/{mm}/{unique-id}.{ext}   uploaded and accepted media
 *   jithendar/www/tmp/generated/{yyyy}/{mm}/{id}.{ext}         unaccepted AI images (expire after a day)
 *
 * These are object-key prefixes inside the configured bucket. The authenticated API endpoint
 * (https://<account>.r2.cloudflarestorage.com) is only used server-side; readers get media from
 * /media/{id}/{name} on this site, or from R2_PUBLIC_BASE_URL (a custom domain on the bucket) for
 * large files. Configuration comes from R2_* environment variables (the Kubernetes Secret) or, when
 * those are absent, from Admin → Storage (credentials sealed in the database).
 */
export const MEDIA_ROOT = "jithendar/www/media";
export const TMP_ROOT = "jithendar/www/tmp";
export const MEDIA_KINDS = ["images", "videos", "audio", "documents"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Uniquely named objects never change, so they are cached for a year. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

const SETTING_KEY = "storage.r2";

function yyyymm(now: Date): [string, string] {
  return [String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0")];
}

const EXT = /^[a-z0-9]{1,5}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** jithendar/www/media/{kind}/{yyyy}/{mm}/{id}.{ext}: the id is a random UUID, never a user-supplied name. */
export function mediaObjectKey(kind: MediaKind, id: string, ext: string, now = new Date()): string {
  if (!MEDIA_KINDS.includes(kind)) throw new Error(`unknown media kind: ${kind}`);
  if (!ID.test(id)) throw new Error("media id must be a UUID");
  if (!EXT.test(ext)) throw new Error("invalid extension");
  const [yyyy, mm] = yyyymm(now);
  return `${MEDIA_ROOT}/${kind}/${yyyy}/${mm}/${id}.${ext}`;
}

export function tempObjectKey(id: string, ext: string, now = new Date()): string {
  if (!ID.test(id) || !EXT.test(ext)) throw new Error("invalid temporary key");
  const [yyyy, mm] = yyyymm(now);
  return `${TMP_ROOT}/generated/${yyyy}/${mm}/${id}.${ext}`;
}

// --- Configuration --------------------------------------------------------------------------

/** Where media is stored: Cloudflare R2 (the default, and every setup before 2026-11-18) or Amazon S3. */
export type StorageProvider = "r2" | "s3";
export const PROVIDER_LABEL: Record<StorageProvider, string> = { r2: "Cloudflare R2", s3: "Amazon S3" };

type StoredR2 = {
  /** Absent in settings saved before 2026-11-18: R2. */
  provider?: StorageProvider;
  /** S3 only (e.g. eu-central-1). */
  region?: string;
  accountId: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: Sealed;
  publicBaseUrl: string;
  verifiedAt: string | null;
};

export type R2Config = {
  source: "env" | "admin";
  provider: StorageProvider;
  /** "auto" for R2; the bucket's region for S3. */
  region: string;
  /** True when the endpoint is a custom one (an R2 jurisdiction, an S3-compatible service): path-style requests. */
  customEndpoint: boolean;
  accountId: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: () => string;
  /** Public delivery base (custom domain or r2.dev), no trailing slash; "" when the bucket is private. */
  publicBaseUrl: string;
  verifiedAt: string | null;
};

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const REGION = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;

/** The S3 API endpoint: R2's account endpoint, AWS's regional one, or the override (jurisdiction, S3-compatible). */
export function endpointFor(accountId: string, override = "", provider: StorageProvider = "r2", region = "auto"): string {
  const custom = override.replace(/\/+$/, "");
  if (custom) return custom;
  return provider === "s3" ? `https://s3.${region}.amazonaws.com` : `https://${accountId}.r2.cloudflarestorage.com`;
}

function envConfig(): R2Config | null {
  const e = process.env;
  // Amazon S3 from the deployment: S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (S3_ENDPOINT and
  // S3_PUBLIC_BASE_URL optional). R2_* wins when both are set.
  if (!e.R2_ACCOUNT_ID && !e.R2_BUCKET && !e.R2_ACCESS_KEY_ID && (e.S3_BUCKET || e.S3_ACCESS_KEY_ID)) {
    const missing = ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !e[k]);
    if (missing.length) throw new Error(`S3 is partly configured; missing ${missing.join(", ")}`);
    const secret = e.S3_SECRET_ACCESS_KEY!;
    return {
      source: "env",
      provider: "s3",
      region: e.S3_REGION!,
      customEndpoint: Boolean(e.S3_ENDPOINT),
      accountId: "",
      endpoint: endpointFor("", e.S3_ENDPOINT, "s3", e.S3_REGION!),
      bucket: e.S3_BUCKET!,
      accessKeyId: e.S3_ACCESS_KEY_ID!,
      secretAccessKey: () => secret,
      publicBaseUrl: (e.S3_PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
      verifiedAt: "env",
    };
  }
  if (!e.R2_ACCOUNT_ID && !e.R2_BUCKET && !e.R2_ACCESS_KEY_ID) return null;
  const missing = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((k) => !e[k]);
  if (missing.length) throw new Error(`R2 is partly configured; missing ${missing.join(", ")}`);
  const secret = e.R2_SECRET_ACCESS_KEY!;
  return {
    source: "env",
    provider: "r2",
    region: "auto",
    customEndpoint: Boolean(e.R2_ENDPOINT),
    accountId: e.R2_ACCOUNT_ID!,
    endpoint: endpointFor(e.R2_ACCOUNT_ID!, e.R2_ENDPOINT),
    bucket: e.R2_BUCKET!,
    accessKeyId: e.R2_ACCESS_KEY_ID!,
    secretAccessKey: () => secret,
    publicBaseUrl: (e.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
    // Environment configuration is trusted at start-up; Admin → System status checks it live.
    verifiedAt: "env",
  };
}

async function storedConfig(): Promise<StoredR2 | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, SETTING_KEY));
  return (row?.value as StoredR2 | undefined) ?? null;
}

export async function readR2Config(): Promise<R2Config | null> {
  const env = envConfig();
  if (env) return env;
  const c = await storedConfig();
  if (!c) return null;
  return fromStored(c);
}

function fromStored(c: StoredR2): R2Config {
  const provider = c.provider ?? "r2";
  const region = provider === "s3" ? (c.region ?? "us-east-1") : "auto";
  return { ...c, source: "admin", provider, region, customEndpoint: Boolean(c.endpoint), endpoint: endpointFor(c.accountId, c.endpoint, provider, region), secretAccessKey: () => unseal(c.secretAccessKey) };
}

/** Safe view for the admin form and status page: never includes the secret. */
export async function storageSummary() {
  const c = await readR2Config();
  if (!c) return null;
  return { source: c.source, provider: c.provider, region: c.region, accountId: c.accountId, endpoint: c.endpoint, customEndpoint: c.customEndpoint, bucket: c.bucket, accessKeyId: c.accessKeyId, publicBaseUrl: c.publicBaseUrl, verifiedAt: c.verifiedAt };
}

export async function storageReady(): Promise<boolean> {
  return Boolean((await readR2Config())?.verifiedAt);
}

const common = {
  /** Optional: an R2 jurisdiction endpoint (https://<account>.eu.r2.cloudflarestorage.com), an S3-compatible service, or a local emulator. */
  endpoint: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default(""),
  publicBaseUrl: z.union([z.literal(""), z.url({ protocol: /^https$/ })]).default(""),
  accessKeyId: z.string().trim().min(3).max(200),
  /** Blank keeps the stored secret. */
  secretAccessKey: z.string().max(400).default(""),
};
export const storageInput = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("r2"),
    accountId: z.string().trim().toLowerCase().regex(ACCOUNT_ID, "the 32-character account ID from the Cloudflare dashboard"),
    bucket: z.string().trim().regex(BUCKET, "not a valid R2 bucket name"),
    ...common,
  }),
  z.object({
    provider: z.literal("s3"),
    region: z.string().trim().toLowerCase().regex(REGION, "an AWS region such as us-east-1 or ap-south-1"),
    bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "not a valid S3 bucket name"),
    ...common,
  }),
]);

// --- Client ---------------------------------------------------------------------------------

let cached: { key: string; s3: S3Client } | undefined;

function clientFor(c: R2Config): S3Client {
  const secret = c.secretAccessKey();
  const key = JSON.stringify([c.endpoint, c.accessKeyId, secret]);
  if (cached?.key === key) return cached.s3;
  const s3 = traceAwsClient(new S3Client({
    region: c.region, // "auto" for R2 (required by the SDK, ignored by R2); the bucket's region for S3
    endpoint: c.endpoint,
    // R2 and custom endpoints take path-style requests; AWS S3 prefers virtual-hosted ones (bucket.s3.region…).
    forcePathStyle: c.provider === "r2" || c.customEndpoint,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: secret },
    // Send checksums only where an operation requires them; we send Content-MD5 ourselves on uploads.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }), "r2");
  cached = { key, s3 };
  return s3;
}

async function requireR2(): Promise<{ c: R2Config; s3: S3Client }> {
  const c = await readR2Config();
  if (!c?.verifiedAt) throw new PostError("Media storage (Cloudflare R2 or Amazon S3) is not configured. An admin must set it up under Admin → Settings → Storage first.", 409);
  return { c, s3: clientFor(c) };
}

export type ObjectInfo = { size: number; contentType?: string; etag?: string };

export async function putObject(key: string, body: Buffer, opts: { contentType: string; cacheControl?: string; contentMd5?: string }) {
  const { c, s3 } = await requireR2();
  await s3.send(
    new PutObjectCommand({
      Bucket: c.bucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl ?? IMMUTABLE,
      // R2 rejects the upload if the bytes it received do not match.
      ContentMD5: opts.contentMd5,
    }),
  );
}

export async function headObject(key: string): Promise<ObjectInfo | null> {
  const { c, s3 } = await requireR2();
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
    return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType, etag: r.ETag };
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** Streamed read, optionally a byte range ("bytes=0-1023"). null if the object does not exist. */
export async function getObject(key: string, range?: string) {
  const { c, s3 } = await requireR2();
  try {
    return await s3.send(new GetObjectCommand({ Bucket: c.bucket, Key: key, ...(range ? { Range: range } : {}) }));
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || status === 416) return null;
    throw e;
  }
}

/** Whole object as bytes, refusing anything larger than `maxBytes`. */
export async function getObjectBytes(key: string, maxBytes: number): Promise<Buffer | null> {
  const res = await getObject(key);
  if (!res?.Body) return null;
  if (Number(res.ContentLength ?? 0) > maxBytes) throw new PostError("The stored file is larger than allowed.", 413);
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function deleteObject(key: string) {
  const { c, s3 } = await requireR2();
  await s3.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
}

export async function copyObject(from: string, to: string, opts: { contentType: string; cacheControl?: string }) {
  const { c, s3 } = await requireR2();
  await s3.send(
    new CopyObjectCommand({
      Bucket: c.bucket,
      Key: to,
      CopySource: `${c.bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
      MetadataDirective: "REPLACE",
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl ?? IMMUTABLE,
    }),
  );
}

export async function listObjects(prefix: string, continuationToken?: string, maxKeys = 100) {
  const { c, s3 } = await requireR2();
  const r = await s3.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: prefix, ContinuationToken: continuationToken, MaxKeys: Math.min(maxKeys, 1000) }));
  return {
    objects: (r.Contents ?? []).map((o) => ({ key: o.Key!, size: Number(o.Size ?? 0), lastModified: o.LastModified?.toISOString() ?? null })),
    next: r.IsTruncated ? r.NextContinuationToken : undefined,
  };
}

/**
 * Object operations on another bucket of the same R2 account (backups can live in a private bucket of their
 * own); `bucket` empty means the media bucket. Uses the media storage credentials, so the R2 API token must
 * be allowed to write that bucket too.
 */
export async function bucketOps(bucket = "") {
  const { c, s3 } = await requireR2();
  const Bucket = bucket.trim() || c.bucket;
  return {
    bucket: Bucket,
    sameAsMedia: Bucket === c.bucket,
    mediaIsPublic: Boolean(c.publicBaseUrl),
    put: async (key: string, body: Buffer, contentType = "application/octet-stream") => {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, CacheControl: "private, no-store" }));
    },
    list: async (prefix: string) => {
      const keys: { key: string; size: number; lastModified: string | null }[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) keys.push({ key: o.Key, size: Number(o.Size ?? 0), lastModified: o.LastModified?.toISOString() ?? null });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    remove: async (key: string) => {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    get: async (key: string) => {
      const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
  };
}

/**
 * Short-lived URL the browser PUTs one file to. Content-Type and Content-Length are part of the
 * signature, so the upload fails unless it is exactly the declared type and size.
 */
export async function presignPut(key: string, contentType: string, contentLength: number, expiresIn = 600): Promise<string> {
  const { c, s3 } = await requireR2();
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: c.bucket, Key: key, ContentType: contentType, ContentLength: contentLength, CacheControl: IMMUTABLE }),
    { expiresIn, signableHeaders: new Set(["content-type", "content-length"]) },
  );
}

/** Short-lived download link for private media. */
export async function presignGet(key: string, filename: string, expiresIn = 300): Promise<string> {
  const { c, s3 } = await requireR2();
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: c.bucket, Key: key, ResponseContentDisposition: `inline; filename="${filename.replace(/["\\]/g, "")}"`, ResponseCacheControl: "private, no-store" }),
    { expiresIn },
  );
}

/** Public URL of an object on the configured delivery domain, or null when the bucket is not public. */
export async function publicObjectUrl(key: string): Promise<string | null> {
  const c = await readR2Config();
  if (!c?.publicBaseUrl) return null;
  return `${c.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// --- Admin configuration ----------------------------------------------------------------------

/** A write, read-back and delete under the tmp prefix proves the credentials and bucket work. */
async function probe(c: R2Config) {
  const s3 = clientFor(c);
  const Key = `${TMP_ROOT}/.storage-check-${crypto.randomUUID()}`;
  await s3.send(new PutObjectCommand({ Bucket: c.bucket, Key, Body: "ok", ContentType: "text/plain" }));
  const got = await s3.send(new GetObjectCommand({ Bucket: c.bucket, Key }));
  const body = await got.Body?.transformToString();
  await s3.send(new DeleteObjectCommand({ Bucket: c.bucket, Key }));
  if (body !== "ok") throw new Error("read-back did not match");
}

/** Save the configuration, then prove it works. Uploads stay disabled until it does. */
export async function saveStorageConfig(actor: Actor, raw: unknown): Promise<{ verified: boolean; error?: string }> {
  if (actor.role !== "admin") throw new PostError("Only admins can configure storage.", 403);
  if (envConfig()) throw new PostError("Storage is configured by R2_* or S3_* environment variables (the Kubernetes Secret). Change it there.", 409);
  const parsed = storageInput.safeParse({ provider: "r2", ...(raw as object) });
  if (!parsed.success) throw new PostError("The storage settings are not valid.", 400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const input = parsed.data;
  const existing = await storedConfig();
  if (!input.secretAccessKey && !existing) throw new PostError("Enter the secret access key.", 400);
  const stored: StoredR2 = {
    provider: input.provider,
    ...(input.provider === "s3" ? { region: input.region } : {}),
    accountId: input.provider === "r2" ? input.accountId : "",
    endpoint: input.endpoint,
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey ? seal(input.secretAccessKey) : existing!.secretAccessKey,
    publicBaseUrl: input.publicBaseUrl.replace(/\/+$/, ""),
    verifiedAt: null,
  };
  let error: string | undefined;
  try {
    await probe(fromStored(stored));
    stored.verifiedAt = new Date().toISOString();
  } catch (e) {
    error = (e as Error).message;
  }
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: SETTING_KEY, value: stored, updatedBy: actor.id })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: stored, updatedBy: actor.id, updatedAt: new Date() } });
  await audit(actor, "storage.configure", stored.bucket, { provider: input.provider, verified: !error });
  return { verified: !error, error };
}

/** Status check for Admin → System status: list one key under the media prefix. */
export async function checkStorage(): Promise<{ status: "ok" | "degraded" | "not configured"; detail: string }> {
  const c = await readR2Config();
  if (!c) return { status: "not configured", detail: "uploads disabled until Cloudflare R2 or Amazon S3 is configured" };
  const s3 = clientFor(c);
  await s3.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: `${MEDIA_ROOT}/`, MaxKeys: 1 }));
  return {
    status: c.verifiedAt ? "ok" : "degraded",
    detail: `${PROVIDER_LABEL[c.provider]} bucket ${c.bucket}${c.provider === "s3" ? ` (${c.region})` : ""} (${c.source === "env" ? "from Secret" : "from admin"})${c.publicBaseUrl ? ` · public ${new URL(c.publicBaseUrl).host}` : " · served through the site"}${c.verifiedAt ? "" : " · not verified"}`,
  };
}

/** Context folder kept on the media row for organisation in the admin (not part of the object key). */
const CONTEXT = /^(library|generated|pages\/[a-z0-9-]+|authors\/[a-z0-9-]+|posts\/(blog|news|projects)\/[a-z0-9-]+)$/;

export function normaliseContext(value: string | null | undefined): string {
  return value && CONTEXT.test(value) ? value : "library";
}
