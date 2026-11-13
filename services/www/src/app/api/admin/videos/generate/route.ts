import { actorOf } from "@/lib/admin";
import { reportError, routeFields } from "@/lib/http-errors";
import { PostError } from "@/lib/posts";
import { getSessionUser } from "@/lib/session";
import { startVideoGeneration } from "@/lib/video-generation";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

/** Cookie-authenticated JSON endpoint: refuse cross-site requests (CSRF) by checking Origin. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Start generating a video for the editor (staff only). Returns at once with the generation's id; the dialog
 * then polls …/generations/{id}/status until the clip is ready (it takes minutes).
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
  const user = await getSessionUser();
  if (!user) return json({ error: "Sign in again." }, 401);
  if (user.role !== "admin" && user.role !== "author") return json({ error: "Not allowed." }, 403);
  const body = (await req.json().catch(() => null)) as { prompt?: unknown; aspectRatio?: unknown } | null;
  if (!body) return json({ error: "Bad request." }, 400);
  try {
    return json(await startVideoGeneration(actorOf(user), body), 202);
  } catch (e) {
    if (e instanceof PostError) return json({ error: e.message }, e.status);
    const ref = reportError("video generation request failed", e, routeFields(req));
    return json({ error: "Video generation failed. The error has been logged.", code: "internal", reference: ref.reference }, 500);
  }
}
