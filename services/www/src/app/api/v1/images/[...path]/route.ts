import { PostError } from "@/lib/posts";
import { completeSiteFileUpload, putSiteImage, SITE_FILE_DIRECT_MAX_BYTES, siteImagePath, startSiteFileUpload } from "@/lib/site-images";
import { api, bodyBytes } from "../../_lib";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/images/<path> (scope images:write, a key that belongs to an admin): store the request body as the site
 * image /images/<path> in R2. The body is the file itself (PNG, JPEG, WebP, AVIF, GIF or SVG, at most 5 MB); its type
 * is read from the bytes and must match the file name. A PNG is stored as lossless WebP when that is smaller.
 * Sending the same bytes again changes nothing (`unchanged: true`), so every file can be sent on every push.
 */
export function PUT(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return api(request, "images:write", async ({ actor }) => {
    const path = siteImagePath((await params).path);
    return putSiteImage(actor, path, await bodyBytes(request, SITE_FILE_DIRECT_MAX_BYTES));
  });
}

/**
 * POST /api/v1/images/<path> (same scope): a direct upload of a document or media file too large for one PUT (PDF,
 * MP4, WebM, MP3; lib/site-images.ts FILE_TYPES), in three steps:
 *   1. {"action":"start","size":<bytes>,"sha256":"<hex>"} → {upload, uploadUrl, headers, expiresInSeconds}
 *   2. PUT the file to uploadUrl with those headers (straight to R2; within expiresInSeconds)
 *   3. {"action":"complete","upload":"<id>","size":<bytes>,"sha256":"<hex>"} → the same answer as PUT
 */
export function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return api(request, "images:write", async ({ actor }) => {
    const path = siteImagePath((await params).path);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new PostError("Send a JSON body with action start or complete.", 400);
    }
    if (body?.action === "start") return startSiteFileUpload(actor, path, body);
    if (body?.action === "complete") return completeSiteFileUpload(actor, path, body);
    throw new PostError('action must be "start" or "complete".', 400);
  });
}
