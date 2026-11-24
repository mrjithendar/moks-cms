import { repoTree } from "@/lib/crewai/bundle/repo";
import { errorJson } from "@/lib/crewai/bundle/service";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/config/repo/files[?ref=] — the folder's files at the branch head (or a commit or branch). */
export const GET = seoRoute("crewai-config-repo-files", {}, async (_req, ctx) => {
  try {
    return json(await repoTree({}, ctx.query.get("ref") ?? undefined));
  } catch (e) {
    return errorJson(e);
  }
});
