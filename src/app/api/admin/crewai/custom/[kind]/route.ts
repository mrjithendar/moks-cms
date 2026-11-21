import { z } from "zod";
import { customApiError, kindOf, listCustom, saveCustom } from "@/lib/crewai/custom";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/custom/{crews|flows} — the saved custom crews or flows (crew-jobs plan PR 6). */
export const GET = seoRoute<{ kind: string }>("crewai-custom-list", {}, async (_req, _ctx, p) => json({ items: await listCustom(kindOf(p)) }));

/** POST /api/admin/crewai/custom/{crews|flows} {spec} — create or update one; the SEO agent checks it first (422 + issues). */
export const POST = seoRoute<{ kind: string }>("crewai-custom-save", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(z.object({ spec: z.record(z.string(), z.unknown()) }).strict(), ctx.body ?? {});
  try {
    return json({ item: await saveCustom(kindOf(p), ctx.actor, b.spec) });
  } catch (e) {
    customApiError(e);
  }
});
