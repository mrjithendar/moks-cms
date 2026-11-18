import { z } from "zod";
import { improveCalendarDraft } from "@/lib/seo-agent/orchestrate";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/seo/calendar/{id}/improve { instructions? } — the Editorial Crew reads the item's current draft and
 * revises it (never publishes). A scheduled post goes back to draft first, to be reviewed and scheduled again.
 */
export const POST = seoRoute<{ id: string }>("calendar-improve", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const b = parse(z.object({ instructions: z.string().trim().max(1500).optional() }), ctx.body ?? {});
  const r = await improveCalendarDraft(id, ctx.actor, b.instructions ?? null);
  await ctx.audit("calendar.improve", id, { ...r, instructions: b.instructions ?? null });
  return json(r, 202);
});
