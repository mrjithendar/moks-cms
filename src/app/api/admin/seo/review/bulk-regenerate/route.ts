import { z } from "zod";
import { regenerate } from "@/lib/seo-agent/orchestrate";
import { getDraft } from "@/lib/seo-intel/drafts";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(25), feedback: z.string().trim().max(2000).nullable().optional() });

/** POST /api/admin/seo/review/bulk-regenerate — a fresh generation for several drafts waiting for review or failed. */
export const POST = seoRoute("review-bulk-regenerate", { mutating: true, rate: { max: 6, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  const done: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of b.ids) {
    const d = await getDraft(id);
    if (!d || !["ready_for_review", "generation_failed"].includes(d.status)) {
      skipped.push({ id, reason: d ? `This draft is ${d.status.replace(/_/g, " ")}.` : "Draft not found." });
      continue;
    }
    try {
      const r = await regenerate(id, ctx.actor, b.feedback || null);
      await ctx.audit("draft.regenerate", d.article_id, { draftId: id, bulk: true, ...r });
      done.push(id);
    } catch (e) {
      skipped.push({ id, reason: (e as Error).message.slice(0, 300) });
    }
  }
  return json({ regenerated: done.length, skipped }, 202);
});
