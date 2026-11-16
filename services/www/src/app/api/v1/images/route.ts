import { listSiteImages } from "@/lib/site-images";
import { api } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/images?limit=&offset= (scope images:write or posts:read): the site images stored in R2, by path, with
 * the SHA-256 of each pushed file, so a push tool can tell which local files are new or changed. At most 1000 per call.
 */
export function GET(request: Request) {
  return api(request, ["images:write", "posts:read"], async () => {
    const q = new URL(request.url).searchParams;
    return listSiteImages({ limit: Number(q.get("limit") ?? 1000), offset: Number(q.get("offset") ?? 0) });
  });
}
