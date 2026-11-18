import { actorOf } from "@/lib/admin";
import { reportError, routeFields } from "@/lib/http-errors";
import { PostError } from "@/lib/posts";
import { getSessionUser } from "@/lib/session";
import { videoGenerationProgress } from "@/lib/video-generation";

export const dynamic = "force-dynamic";
// The poll that finds the clip ready downloads it from the provider and stores it before answering.
export const maxDuration = 120;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

/** Progress of a video generation: running, succeeded (with the preview URL) or failed (with the reason). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user || (user.role !== "admin" && user.role !== "author")) return json({ error: "Not found." }, 404);
  try {
    return json(await videoGenerationProgress(actorOf(user), (await params).id));
  } catch (e) {
    if (e instanceof PostError) return json({ error: e.message }, e.status);
    const ref = reportError("video generation status failed", e, routeFields(req));
    return json({ error: "Could not check the video. The error has been logged.", code: "internal", reference: ref.reference }, 500);
  }
}
