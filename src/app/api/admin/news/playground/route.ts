import { z } from "zod";
import { json, parse, seoRoute, UUID } from "@/lib/seo-intel/http";
import { playground, saveAsDraft } from "@/lib/news/agent";

export const dynamic = "force-dynamic";
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("compare"), jobId: z.string().regex(UUID), clusterId: z.string().regex(UUID), profileKey: z.string().max(42), versionA: z.number().int().min(1), versionB: z.number().int().min(1).nullable().default(null) }),
  z.object({ action: z.literal("save"), jobId: z.string().regex(UUID), clusterId: z.string().regex(UUID), version: z.number().int().min(1) }),
]);

/** POST — compare profile versions on a recent story (nothing saved), or "Save as draft" (normal draft run, all gates). */
export const POST = seoRoute("news-playground", { mutating: true, rate: { max: 10, windowSeconds: 60 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body ?? {});
  if (b.action === "save") return json(await saveAsDraft(b, ctx.actor.label), 202);
  return json(await playground(b, ctx.actor.label), 202);
});
