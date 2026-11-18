import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { recordReview } from "@/lib/news/service";
import { REJECT_CATEGORIES } from "@/lib/news/schema";
import { reject } from "@/lib/seo-agent/orchestrate";

export const dynamic = "force-dynamic";
const body = z.object({ category: z.enum(REJECT_CATEGORIES), reason: z.string().trim().max(2000).nullable().default(null) });

/** POST — reject a news draft with a categorised reason (off-topic, low value, duplicate, inaccurate, style): learning loop. */
export const POST = seoRoute<{ id: string }>("news-draft-reject", { mutating: true }, async (_req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  await reject(p.id, ctx.actor, `${b.category}${b.reason ? `: ${b.reason}` : ""}`);
  await recordReview(ctx.actor, p.id, "rejected", { category: b.category, reason: b.reason });
  return json({ status: "rejected" });
});
