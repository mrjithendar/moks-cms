import { reportError, routeFields, withReference } from "@/lib/http-errors";
import { findSiteImage, isImageType, SITE_IMAGE_CACHE, siteImageBody, siteImageEtag, type SiteImageRow } from "@/lib/site-images";
import { getObject, publicObjectUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

const RANGE = /^bytes=\d*-\d*$/;
const unavailable = () => new Response("Temporarily unavailable", { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Site images that are in R2 (lib/site-images.ts), under the URL they always had. A file that is still on disk in
 * public/images/ never reaches this route: Next serves files in public/ first.
 * - /images/a/b.webp, .svg, .jpg, …: the stored object.
 * - /images/a/b.png of a PNG that is stored as WebP: a PNG made from it, so social cards, feeds and old links that
 *   name the .png still get a PNG. Pages request the .webp (resolveImage).
 * - /images/a/b.pdf, .mp4, .webm, .mp3 (documents and media): a redirect to R2's public domain when one is configured
 *   (Cloudflare serves the bytes and range requests), otherwise streamed from R2 with Range support.
 * Readers make no third-party request for images: the bytes come through the site, from memory after the first read. Nothing
 * here can run script: SVGs with scripts or event handlers are refused when they are pushed, and every response is
 * sandboxed for the case that someone opens the URL directly.
 */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const requestPath = `/images/${(await params).path.join("/")}`;
  try {
    const row = await findSiteImage(requestPath);
    if (!row) return notFound();
    const etag = siteImageEtag(row, requestPath);
    const cacheHeaders = { ETag: etag, "Cache-Control": SITE_IMAGE_CACHE };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: cacheHeaders });
    if (!isImageType(row.contentType)) return await streamFile(request, row, cacheHeaders);
    const body = await siteImageBody(row, requestPath);
    if (!body) return unavailable();
    const svg = body.contentType === "image/svg+xml";
    return new Response(new Uint8Array(body.bytes), {
      headers: {
        ...cacheHeaders,
        "Content-Type": body.contentType,
        "Content-Length": String(body.bytes.length),
        "X-Content-Type-Options": "nosniff",
        // SVGs keep their inline styles and embedded (data:) images and fonts; nothing may load from elsewhere or run.
        "Content-Security-Policy": svg ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox" : "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    const ref = reportError("site image request failed", error, routeFields(request));
    return new Response(withReference("Temporarily unavailable.", ref), { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
  }
}

/** A document or media file: never read whole into memory. */
async function streamFile(request: Request, row: SiteImageRow, cacheHeaders: Record<string, string>): Promise<Response> {
  const url = await publicObjectUrl(row.storageKey);
  if (url) return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "public, max-age=3600" } });
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader && RANGE.test(rangeHeader) ? rangeHeader : undefined;
  const res = await getObject(row.storageKey, range);
  if (!res?.Body) return unavailable();
  const name = row.path.slice(row.path.lastIndexOf("/") + 1);
  const headers: Record<string, string> = {
    ...cacheHeaders,
    "Content-Type": row.contentType,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": `inline; filename="${name}"`,
  };
  if (res.ContentLength !== undefined) headers["Content-Length"] = String(res.ContentLength);
  if (res.ContentRange) headers["Content-Range"] = res.ContentRange;
  return new Response(res.Body.transformToWebStream(), { status: res.ContentRange ? 206 : 200, headers });
}
