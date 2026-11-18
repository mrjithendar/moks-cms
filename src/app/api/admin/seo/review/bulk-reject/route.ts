import { z } from "zod";
import { rejectDraft } from "@/lib/seo-intel/drafts";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(100), reason: z.string().trim().max(2000).nullable().optional() });

/** POST /api/admin/seo/review/bulk-reject — reject several drafts at once. (Approving is always one article at a time.) */
export const POST = seoRoute("review-bulk-reject", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  const done: string[] = [];
  const skipped: string[] = [];
  for (const id of b.ids) {
    try {
      const r = await rejectDraft(id, ctx.actor, b.reason || null);
      await ctx.audit("draft.reject", r.article_id, { draftId: id, reason: b.reason || null, bulk: true });
      done.push(id);
    } catch {
      skipped.push(id);
    }
  }
  return json({ rejected: done.length, skipped });
});
