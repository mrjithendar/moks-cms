import { createHash } from "node:crypto";
import { and, asc, eq, ne, or } from "drizzle-orm";
import { imageSize } from "image-size";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { IMAGE_PREFIX, MAX_IMAGE_BYTES } from "./images";
import { log } from "./log";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { deleteObject, getObjectBytes, putObject, storageReady } from "./storage";

/**
 * Site images in R2: the files a site keeps under public/images/ and its content refers to as /images/...
 *
 * They used to reach the pod only inside the site's content image (copied to public/images/ at start), so every new
 * image meant an image build and a restart, and the copy grew with every article. PUT /api/v1/images/<path> stores a
 * file in R2 instead, under
 *
 *   jithendar/www/site-images/<path below /images/>
 *
 * and records it in table site_image. /images/... URLs do not change: a file that is still on disk is served from
 * disk as before (and wins), anything else by app/images/[...path] from R2.
 *
 * PNG files are stored as lossless WebP when that is smaller (the same pixels, about half the bytes for diagrams).
 * The row then has two paths: `path`, as pushed and as content refers to it (/images/a/b.png), and `servedPath`, what
 * pages request (/images/a/b.webp). The .png URL keeps answering, with a PNG made from the stored WebP, so social
 * cards, feeds and old links that name the .png get a PNG.
 */
export const SITE_IMAGE_ROOT = "jithendar/www/site-images";
export const SITE_IMAGE_MAX_BYTES = MAX_IMAGE_BYTES;
/** Same as next.config.ts sends for /images/ files on disk: a day, then revalidate in the background for a week. */
export const SITE_IMAGE_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const SVG_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 12_000;
const MAX_PATH = 200;
const MAX_DEPTH = 6;
const SVG = "image/svg+xml";

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  svg: SVG,
};

/** One path segment: letters, digits, dot, underscore, hyphen; starts with a letter or digit (no dot files). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A whole /images/... path made of such segments, for lookups by a src that content or a request names. */
const SRC = /^\/images(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export type SiteImageRow = typeof schema.siteImage.$inferSelect;

/** What the API returns for one image. `path` is what content refers to; `servedPath` is what pages request. */
export type SiteImageInfo = {
  path: string;
  servedPath: string;
  contentType: string;
  bytes: number;
  sourceBytes: number;
  sha256: string;
  width: number;
  height: number;
  /** True when a pushed PNG is stored as lossless WebP. */
  converted: boolean;
  updatedAt: string;
};

const extOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const md5Base64 = (b: Buffer) => createHash("md5").update(b).digest("base64");

function info(row: SiteImageRow): SiteImageInfo {
  return {
    path: row.path,
    servedPath: row.servedPath,
    contentType: row.contentType,
    bytes: row.sizeBytes,
    sourceBytes: row.sourceBytes,
    sha256: row.sourceSha256,
    width: row.width,
    height: row.height,
    converted: row.servedPath !== row.path,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The /images/... path for the segments after /api/v1/images/ or /images/. Throws a 400 for anything that is not a
 * plain file path with an image extension: the path becomes part of an object key and of a public URL.
 */
export function siteImagePath(segments: readonly string[]): string {
  const bad = (why: string) => new PostError(`Not a valid image path: ${why}.`, 400);
  if (segments.length === 0 || segments.length > MAX_DEPTH) throw bad(`use 1 to ${MAX_DEPTH} path segments below /images/`);
  for (const s of segments) {
    if (!SEGMENT.test(s) || s.includes("..")) throw bad("each segment may hold letters, digits, dots, underscores and hyphens, and starts with a letter or digit");
  }
  const path = `${IMAGE_PREFIX}${segments.join("/")}`;
  if (path.length > MAX_PATH) throw bad(`longer than ${MAX_PATH} characters`);
  if (!(extOf(path) in EXT_TYPES) || !segments.at(-1)!.includes(".")) throw bad(`the file name must end in ${Object.keys(EXT_TYPES).map((e) => `.${e}`).join(", ")}`);
  return path;
}

/** R2 key of the object served at `servedPath`. */
export function siteImageKey(servedPath: string): string {
  if (!SRC.test(servedPath) || servedPath.includes("..")) throw new Error("invalid site image path");
  return `${SITE_IMAGE_ROOT}/${servedPath.slice(IMAGE_PREFIX.length)}`;
}

/** The type of a raster image, from its first bytes; null for anything else. */
function sniffRaster(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.subarray(1, 8).toString("latin1") === "PNG\r\n\x1a\n") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const head = b.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.slice(4, 8) === "ftyp" && (head.slice(8, 12) === "avif" || head.slice(8, 12) === "avis")) return "image/avif";
  return null;
}

/**
 * Why an SVG is refused, or null. Pages show SVGs through <img>, where browsers run no script, but the same URL can
 * be opened directly: scripts, event handlers and javascript: links are refused here, and the response is sandboxed
 * as well (app/images/[...path]). <foreignObject> stays allowed: draw.io uses it for every text label.
 */
export function svgProblem(bytes: Buffer): string | null {
  if (bytes.length > SVG_MAX_BYTES) return `SVG files must be ${SVG_MAX_BYTES / 1024 / 1024} MB or smaller`;
  const text = bytes.toString("utf8");
  if (!/<svg[\s>]/i.test(text.slice(0, 4096))) return "the file is not an SVG document";
  if (/<script[\s>/]/i.test(text)) return "SVG files with a <script> element are not accepted";
  if (/<[^<>]*\son[a-z]+\s*=/i.test(text)) return "SVG files with event handler attributes (onload, onclick, …) are not accepted";
  if (/(?:href|src)\s*=\s*["']?\s*javascript:/i.test(text)) return "SVG files with javascript: links are not accepted";
  return null;
}

type Inspected = { contentType: string; width: number; height: number };

/** Validate a pushed file by its content: the type its name says, readable, sane size. */
function inspect(path: string, bytes: Buffer): Inspected {
  if (bytes.length === 0) throw new PostError("The file is empty.", 400);
  if (bytes.length > SITE_IMAGE_MAX_BYTES) throw new PostError(`Site images must be ${SITE_IMAGE_MAX_BYTES / 1024 / 1024} MB or smaller.`, 413);
  const expected = EXT_TYPES[extOf(path)]!;
  if (expected === SVG) {
    const problem = svgProblem(bytes);
    if (problem) throw new PostError(`${path}: ${problem}.`, 400);
  } else {
    const found = sniffRaster(bytes);
    if (found !== expected) throw new PostError(`${path}: the file is ${found ?? "not a supported image"}, but its name says ${expected}.`, 400);
  }
  let size: { width?: number; height?: number };
  try {
    size = imageSize(bytes);
  } catch {
    throw new PostError(`${path}: not a readable image.`, 400);
  }
  if (!size.width || !size.height) throw new PostError(`${path}: the image has no readable width and height.`, 400);
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) throw new PostError(`${path}: images must be at most ${MAX_SIDE} pixels on each side.`, 400);
  return { contentType: expected, width: Math.round(size.width), height: Math.round(size.height) };
}

/**
 * A PNG as lossless WebP, or null when that would not be the same picture (16-bit or animated PNG) or sharp cannot
 * read the file. The caller keeps the PNG unless the WebP is smaller.
 */
async function losslessWebp(png: Buffer): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(png).metadata();
    if (meta.depth !== "uchar" || (meta.pages ?? 1) > 1) return null;
    return await sharp(png).webp({ lossless: true, effort: 4 }).toBuffer();
  } catch (err) {
    log.warn("site image kept as PNG", { event: "site_image_webp_failed", err });
    return null;
  }
}

async function pngFrom(webp: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(webp).png().toBuffer();
}

// --- Lookups ---------------------------------------------------------------------------------

/**
 * The row for a /images/... src, by the path content uses or by the path pages request. Undefined for anything
 * else, and during `next build`, which has no database (it prerenders from files that are on disk).
 */
export async function findSiteImage(src: string): Promise<SiteImageRow | undefined> {
  if (src.length > MAX_PATH || !SRC.test(src) || src.includes("..")) return undefined;
  if (process.env.NEXT_PHASE === "phase-production-build") return undefined;
  const db = await getDb();
  const rows = await db.select().from(schema.siteImage).where(or(eq(schema.siteImage.path, src), eq(schema.siteImage.servedPath, src))).limit(2);
  return rows.find((r) => r.path === src) ?? rows[0];
}

/** Every site image in R2, by path (`limit` at most 1000). */
export async function listSiteImages(opts: { limit?: number; offset?: number } = {}): Promise<SiteImageInfo[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 1000) || 1000, 1), 1000);
  const offset = Math.max(Math.floor(opts.offset ?? 0) || 0, 0);
  const db = await getDb();
  const rows = await db.select().from(schema.siteImage).orderBy(asc(schema.siteImage.path)).limit(limit).offset(offset);
  return rows.map(info);
}

// --- Serving ---------------------------------------------------------------------------------

export type SiteImageBody = { bytes: Buffer; contentType: string; etag: string };

/**
 * Bodies already read from R2, newest last. Site images are few and small, and SVGs are requested by every reader
 * (next/image does not re-encode them), so a pod keeps up to 32 MB of them in memory instead of asking R2 each time.
 * An entry is only used while its ETag still matches the row, so a replaced image is never served stale.
 */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_ENTRY = 2 * 1024 * 1024;
const cache = new Map<string, SiteImageBody>();
let cacheBytes = 0;

function forget(key: string) {
  const old = cache.get(key);
  if (!old) return;
  cache.delete(key);
  cacheBytes -= old.bytes.length;
}

function remember(key: string, body: SiteImageBody) {
  forget(key);
  if (body.bytes.length > CACHE_MAX_ENTRY) return;
  cache.set(key, body);
  cacheBytes += body.bytes.length;
  for (const [oldest, value] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(oldest);
    cacheBytes -= value.bytes.length;
  }
}

/** Tests: start from an empty body cache. */
export function clearSiteImageCache() {
  cache.clear();
  cacheBytes = 0;
}

/** The ETag of what `requestPath` answers with: the pushed file's hash, marked when it is the PNG made from a WebP. */
export function siteImageEtag(row: SiteImageRow, requestPath: string): string {
  return `"${row.sourceSha256.slice(0, 32)}${requestPath === row.servedPath ? "" : "-png"}"`;
}

/**
 * The bytes to answer a request for `requestPath` with: the stored object, or, for the .png path of an image stored
 * as WebP, a PNG made from it. Null when the object is missing from R2.
 */
export async function siteImageBody(row: SiteImageRow, requestPath: string): Promise<SiteImageBody | null> {
  const etag = siteImageEtag(row, requestPath);
  const hit = cache.get(requestPath);
  if (hit?.etag === etag) {
    remember(requestPath, hit); // newest last
    return hit;
  }
  const stored = await getObjectBytes(row.storageKey, SITE_IMAGE_MAX_BYTES * 2);
  if (!stored) return null;
  const body: SiteImageBody = requestPath === row.servedPath ? { bytes: stored, contentType: row.contentType, etag } : { bytes: await pngFrom(stored), contentType: "image/png", etag };
  remember(requestPath, body);
  return body;
}

// --- Upload ----------------------------------------------------------------------------------

export type PutSiteImageResult = SiteImageInfo & { created: boolean; unchanged: boolean };

/**
 * Store one site image in R2 and record it. Pushing the same bytes again changes nothing (`unchanged`), so a push
 * tool can send every file each time. Only an admin (or an API key an admin owns) may do this: a site image can be
 * part of any page, not only of the caller's own posts.
 */
export async function putSiteImage(actor: Actor, path: string, bytes: Buffer): Promise<PutSiteImageResult> {
  if (actor.role !== "admin") throw new PostError("Only an admin (or an API key that belongs to an admin) can push site images.", 403);
  if (!SRC.test(path) || !(extOf(path) in EXT_TYPES)) throw new PostError("Not a valid image path.", 400);
  if (!(await storageReady())) throw new PostError("Media storage (Cloudflare R2) is not configured. An admin must set it up under Admin → Storage first.", 409);
  const checked = inspect(path, bytes);
  const sourceSha256 = sha256(bytes);
  const db = await getDb();
  const [existing] = await db.select().from(schema.siteImage).where(eq(schema.siteImage.path, path));
  if (existing && existing.sourceSha256 === sourceSha256) return { ...info(existing), created: false, unchanged: true };

  let stored = bytes;
  let contentType = checked.contentType;
  let servedPath = path;
  if (checked.contentType === "image/png") {
    const webp = await losslessWebp(bytes);
    if (webp && webp.length < bytes.length) {
      stored = webp;
      contentType = "image/webp";
      servedPath = path.replace(/\.png$/i, ".webp");
    }
  }
  // a.png (stored as a.webp) and a real a.webp would answer at the same URL.
  const [clash] = await db
    .select({ path: schema.siteImage.path })
    .from(schema.siteImage)
    .where(and(ne(schema.siteImage.path, path), or(eq(schema.siteImage.servedPath, servedPath), eq(schema.siteImage.path, servedPath), eq(schema.siteImage.servedPath, path))));
  if (clash) throw new PostError(`${path} would share a URL with ${clash.path}, which is already stored. Rename one of the two files.`, 409);

  const storageKey = siteImageKey(servedPath);
  await putObject(storageKey, stored, { contentType, cacheControl: SITE_IMAGE_CACHE, contentMd5: md5Base64(stored) });
  const values = { servedPath, storageKey, contentType, sizeBytes: stored.length, sourceBytes: bytes.length, sourceSha256, width: checked.width, height: checked.height, uploadedBy: actor.id, updatedAt: new Date() };
  const [row] = await db
    .insert(schema.siteImage)
    .values({ path, ...values })
    .onConflictDoUpdate({ target: schema.siteImage.path, set: values })
    .returning();
  // The earlier version lived under another key when it was stored in the other format.
  if (existing && existing.storageKey !== storageKey) await deleteObject(existing.storageKey).catch((err) => log.warn("old site image object not deleted", { event: "site_image_cleanup_failed", err }));
  for (const key of new Set([path, servedPath, existing?.servedPath ?? path])) forget(key);
  await audit(actor, existing ? "site_image.replace" : "site_image.create", path, { servedPath, bytes: stored.length, sourceBytes: bytes.length });
  return { ...info(row!), created: !existing, unchanged: false };
}
