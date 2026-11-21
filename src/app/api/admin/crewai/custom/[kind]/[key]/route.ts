import { z } from "zod";
import { customApiError, deleteCustom, kindOf, setCustomEnabled } from "@/lib/crewai/custom";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** PATCH /api/admin/crewai/custom/{crews|flows}/{key} {enabled} — switch a custom crew or flow on or off. */
export const PATCH = seoRoute<{ kind: string; key: string }>("crewai-custom-toggle", { mutating: true }, async (_req, ctx, p) => {
  const b = parse(z.object({ enabled: z.boolean() }).strict(), ctx.body ?? {});
  try {
    return json({ item: await setCustomEnabled(kindOf(p), ctx.actor, p.key, b.enabled) });
  } catch (e) {
    customApiError(e);
  }
});

/** DELETE /api/admin/crewai/custom/{crews|flows}/{key} — delete (a crew in use is refused; a flow's schedules go too). */
export const DELETE = seoRoute<{ kind: string; key: string }>("crewai-custom-delete", { mutating: true }, async (_req, ctx, p) => {
  try {
    return json(await deleteCustom(kindOf(p), ctx.actor, p.key));
  } catch (e) {
    customApiError(e);
  }
});
