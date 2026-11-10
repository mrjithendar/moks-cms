import { z } from "zod";
import { ignoreGap, sendGapToCalendar } from "@/lib/seo-agent/gaps";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ action: z.enum(["calendar", "ignore"]) });

/** POST /api/admin/seo/keywords/ask-gaps/{id} — "Asked on site" content gap → editorial calendar idea, or ignore. */
export const POST = seoRoute<{ id: string }>("ask-gap", { mutating: true, rate: { max: 60, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  const gapId = Number(id);
  if (!Number.isInteger(gapId) || gapId <= 0) throw new SeoApiError("Question not found.", 404, "not_found");
  const b = parse(body, ctx.body);
  if (b.action === "ignore") {
    await ignoreGap(gapId);
    await ctx.audit("keywords.ask_gap_ignore", String(gapId));
    return json({ ok: true });
  }
  const r = await sendGapToCalendar(gapId);
  await ctx.audit("keywords.ask_gap_calendar", String(gapId), r);
  return json(r, 201);
});
