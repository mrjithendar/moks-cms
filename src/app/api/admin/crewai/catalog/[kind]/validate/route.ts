import { z } from "zod";
import { checkSpec } from "@/lib/crewai/catalog";
import { customApiError, kindOf } from "@/lib/crewai/custom";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/crewai/catalog/{crews|flows}/validate {spec} — the SEO agent's check of a spec, without saving it (422 + issues). */
export const POST = seoRoute<{ kind: string }>("crewai-catalog-validate", { mutating: true, rate: { max: 60, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(z.object({ spec: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 120_000, "at most 120,000 characters of JSON") }).strict(), ctx.body ?? {});
  try {
    return json({ spec: await checkSpec(kindOf(p), b.spec) });
  } catch (e) {
    customApiError(e);
  }
});
