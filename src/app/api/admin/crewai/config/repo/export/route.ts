import { z } from "zod";
import { writeRuntimeToRepo } from "@/lib/crewai/bundle/repo";
import { authorOf, errorJson } from "@/lib/crewai/bundle/service";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST {message?} — write the configuration as it runs here to crewconfig/ (one commit or pull request). */
export const POST = seoRoute("crewai-config-repo-export", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(z.object({ message: z.string().trim().max(500).optional() }).strict(), ctx.body ?? {});
  try {
    return json(await writeRuntimeToRepo(ctx.actor, authorOf(ctx.user), { message: b.message }));
  } catch (e) {
    return errorJson(e);
  }
});
