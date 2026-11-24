import { z } from "zod";
import { repoCompare, repoSummary, saveRepoSettings, testRepo } from "@/lib/crewai/bundle/repo";
import { errorJson } from "@/lib/crewai/bundle/service";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/config/repo[?compare=1] — the configuration repository's settings (never the token) and, with
 * compare, its head against what runs here. */
export const GET = seoRoute("crewai-config-repo", {}, async (_req, ctx) => {
  const summary = await repoSummary();
  if (ctx.query.get("compare") !== "1" || !summary.configured) return json({ summary });
  try {
    return json({ summary, compare: await repoCompare() });
  } catch (e) {
    return errorJson(e);
  }
});

/** PUT — save the repository, branch, folder, how changes land (commit or pull request) and the token. */
export const PUT = seoRoute("crewai-config-repo-save", { mutating: true }, async (_req, ctx) => {
  try {
    return json({ summary: await saveRepoSettings(ctx.actor, ctx.body ?? {}) });
  } catch (e) {
    return errorJson(e);
  }
});

/** POST {action: "test"} — check that the repository answers, the token may push and the branch exists. */
export const POST = seoRoute("crewai-config-repo-test", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  parse(z.object({ action: z.literal("test") }).strict(), ctx.body ?? {});
  try {
    return json(await testRepo());
  } catch (e) {
    return errorJson(e);
  }
});
