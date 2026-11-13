import { actorOf } from "@/lib/admin";
import { reportError, routeFields } from "@/lib/http-errors";
import { PostError } from "@/lib/posts";
import { getSessionUser } from "@/lib/session";
import { videoGenerationPreview } from "@/lib/video-generation";

export const dynamic = "force-dynamic";

/** Preview of an unaccepted generated video: only its author (or an admin), never cached; Range supported for seeking. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user || (user.role !== "admin" && user.role !== "author")) return new Response("Not found", { status: 404 });
  try {
    const range = req.headers.get("range") ?? undefined;
    const { body, contentType, contentRange, contentLength } = await videoGenerationPreview(actorOf(user), (await params).id, range && /^bytes=\d*-\d*$/.test(range) ? range : undefined);
    const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Accept-Ranges": "bytes" };
    if (contentRange) headers["Content-Range"] = contentRange;
    if (contentLength) headers["Content-Length"] = String(contentLength);
    return new Response(body, { status: contentRange ? 206 : 200, headers });
  } catch (e) {
    if (e instanceof PostError) return new Response(e.message, { status: e.status });
    reportError("generated video preview failed", e, { ...routeFields(req), status: 503 });
    return new Response("Unavailable", { status: 503 });
  }
}
