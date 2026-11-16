import { isCollection, POST_FILE_MAX_BYTES, pushPostFile } from "@/lib/post-files";
import { PostError } from "@/lib/posts";
import { api, bodyBytes, canPublish } from "../../../../_lib";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/posts/by-path/<collection>/<slug>[.mdx][?mode=create][&live=1] (scope posts:draft or posts:write).
 * The body is the post's MDX file, frontmatter included, as it is in the site's repository.
 * - A new slug is created as a draft. A post that is a draft or in review is updated from the file.
 * - `mode=create` never changes an existing post (`action: "exists"`).
 * - A published, scheduled or archived post is skipped. With `live=1` and a posts:write key its content is updated;
 *   its status and publication date never change.
 * Answers `{ action: created | updated | unchanged | exists | skipped, id, status, url, admin, reason? }`.
 */
export function PUT(request: Request, { params }: { params: Promise<{ collection: string; slug: string }> }) {
  return api(request, ["posts:draft", "posts:write"], async (auth) => {
    const { collection, slug: name } = await params;
    const slug = name.replace(/\.mdx$/, "");
    if (!isCollection(collection) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new PostError("Use /api/v1/posts/by-path/<blog|news|projects>/<slug>, the slug in lower-case letters, digits and hyphens.", 400);
    const q = new URL(request.url).searchParams;
    const source = (await bodyBytes(request, POST_FILE_MAX_BYTES)).toString("utf8");
    return pushPostFile({ actor: auth.actor, canPublish: canPublish(auth) }, collection, slug, source, { createOnly: q.get("mode") === "create", updateLive: q.get("live") === "1" });
  });
}
