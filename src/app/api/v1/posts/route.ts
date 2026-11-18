import { collections, type Collection } from "@/config/taxonomy";
import { createPost, listPosts } from "@/lib/posts";
import { api, assertDraftStatus, canPublish, json, serialize } from "../_lib";

export const dynamic = "force-dynamic";

/** GET /api/v1/posts?status=&collection=&limit=&offset= (scope posts:read) */
export function GET(request: Request) {
  return api(request, "posts:read", async ({ actor }) => {
    const q = new URL(request.url).searchParams;
    const collection = (collections as readonly string[]).includes(q.get("collection") ?? "") ? (q.get("collection") as Collection) : undefined;
    const rows = await listPosts(actor, {
      status: q.get("status") ?? undefined,
      collection,
      limit: Number(q.get("limit") ?? 50) || 50,
      offset: Number(q.get("offset") ?? 0) || 0,
    });
    return rows.map(serialize);
  });
}

/**
 * POST /api/v1/posts: same validation as the editor. Scope posts:draft creates a draft (or a post in review) and
 * nothing else; posts:write may also create a post that is published or scheduled straight away.
 */
export function POST(request: Request) {
  return api(
    request,
    ["posts:draft", "posts:write"],
    async (auth) => {
      const body = await json(request);
      if (!canPublish(auth)) assertDraftStatus(body);
      return serialize(await createPost(auth.actor, body));
    },
    201,
  );
}
