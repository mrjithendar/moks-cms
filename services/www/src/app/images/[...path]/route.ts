import { reportError, routeFields, withReference } from "@/lib/http-errors";
import { findSiteImage, SITE_IMAGE_CACHE, siteImageBody, siteImageEtag } from "@/lib/site-images";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Site images that are in R2 (lib/site-images.ts), under the URL they always had. A file that is still on disk in
 * public/images/ never reaches this route: Next serves files in public/ first.
 * - /images/a/b.webp, .svg, .jpg, …: the stored object.
 * - /images/a/b.png of a PNG that is stored as WebP: a PNG made from it, so social cards, feeds and old links that
 *   name the .png still get a PNG. Pages request the .webp (resolveImage).
 * Readers make no third-party request: the bytes come through the site, from memory after the first read. Nothing
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
    const body = await siteImageBody(row, requestPath);
    if (!body) return new Response("Temporarily unavailable", { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
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
