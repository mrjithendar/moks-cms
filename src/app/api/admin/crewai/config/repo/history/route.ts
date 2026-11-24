import { repoHistory } from "@/lib/crewai/bundle/repo";
import { errorJson } from "@/lib/crewai/bundle/service";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET ?path= — the commits that changed one file (or, without path, the folder), newest first. */
export const GET = seoRoute("crewai-config-repo-history", {}, async (_req, ctx) => {
  const path = ctx.query.get("path");
  if (path && !/^(?!.*\.\.)(?!\/)[A-Za-z0-9_.\/-]{1,300}$/.test(path)) return json({ error: "Not a path inside the folder." }, 400);
  try {
    return json({ items: await repoHistory(path || null, {}, Number(ctx.query.get("limit") ?? 30)) });
  } catch (e) {
    return errorJson(e);
  }
});
