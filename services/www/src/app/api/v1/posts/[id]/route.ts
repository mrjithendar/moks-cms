import { getPostRow, PostError, trashPost, updatePost } from "@/lib/posts";
import { api, assertDraftStatus, canPublish, DRAFT_STATUSES, json, serialize } from "../../_lib";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params;
  return api(request, "posts:read", async ({ actor }) => serialize(await getPostRow(actor, id)));
}

/**
 * Partial update: only the fields you send change. Changing the slug records a redirect.
 * Scope posts:draft may edit a post only while it is a draft or in review, and cannot change that: a post that is
 * published, scheduled or archived needs posts:write.
 */
export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  return api(request, ["posts:draft", "posts:write"], async (auth) => {
    const patch = await json(request);
    if (canPublish(auth)) return serialize(await updatePost(auth.actor, id, patch));
    const current = await getPostRow(auth.actor, id);
    if (!DRAFT_STATUSES.includes(current.status)) {
      throw new PostError(`This key can only edit drafts (scope posts:draft) and this post is ${current.status}. Edit it in Admin → Posts, or use a key with posts:write.`, 403);
    }
    assertDraftStatus(patch);
    // baseVersion: if an editor published it between the check above and this write, the write is refused (409).
    return serialize(await updatePost(auth.actor, id, patch, { baseVersion: current.version }));
  });
}

/**
 * Moves the post to the trash (scope posts:write): readers no longer see it, and it can be restored in
 * Admin → Posts → Trash. The API never deletes a post permanently; only a signed-in admin or author can, from the trash.
 */
export async function DELETE(request: Request, { params }: Ctx) {
  const { id } = await params;
  return api(request, "posts:write", async ({ actor }) => {
    await trashPost(actor, id);
    return undefined;
  });
}
