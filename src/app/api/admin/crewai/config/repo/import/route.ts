import { z } from "zod";
import { importBundle, importRequestOptions } from "@/lib/crewai/bundle/import";
import { repoFiles, repoSettings } from "@/lib/crewai/bundle/repo";
import { errorJson } from "@/lib/crewai/bundle/service";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = importRequestOptions.extend({ ref: z.string().max(200).optional(), dryRun: z.boolean().default(true) }).strict();

/**
 * POST {ref?, dryRun, policy, prune, kinds, only, allowPartial} — import crewconfig/ from the repository at the branch
 * head (or `ref`): a plan, or applied and recorded with the commit it came from.
 */
export const POST = seoRoute("crewai-config-repo-import", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const { ref, dryRun, ...opts } = parse(body, ctx.body ?? {});
  try {
    const s = await repoSettings();
    const { commit, files } = await repoFiles({}, ref);
    const out = await importBundle({ files }, { ...opts, policy: opts.policy ?? "overwrite", dryRun }, ctx.actor, { source: "repository", revision: commit, ref: ref ?? s.branch, url: `https://github.com/${s.repo}/tree/${commit}/${s.path}`, label: `${s.repo}@${commit.slice(0, 12)}` });
    return json({ ...out, commit });
  } catch (e) {
    return errorJson(e);
  }
});
