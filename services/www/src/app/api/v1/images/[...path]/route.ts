import { putSiteImage, SITE_IMAGE_MAX_BYTES, siteImagePath } from "@/lib/site-images";
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
    return putSiteImage(actor, path, await bodyBytes(request, SITE_IMAGE_MAX_BYTES));
  });
}
