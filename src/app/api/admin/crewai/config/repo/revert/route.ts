import { z } from "zod";
import { revertRepoFile } from "@/lib/crewai/bundle/repo";
import { authorOf, errorJson } from "@/lib/crewai/bundle/service";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const body = z.object({ path: z.string().regex(/^(?!.*\.\.)(?!\/)[A-Za-z0-9_.\/-]{1,300}$/), to: SHA, base: SHA, expected: SHA.nullable() }).strict();

/** POST {path, to, base, expected} — save the file as it was at commit `to` (a new commit or pull request). */
export const POST = seoRoute("crewai-config-repo-revert", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body ?? {});
  try {
    return json(await revertRepoFile(b.path, b.to, b.base, b.expected, ctx.actor, authorOf(ctx.user)));
  } catch (e) {
    return errorJson(e);
  }
});
