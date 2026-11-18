import { z } from "zod";
import { draftIfScheduled } from "@/lib/seo-agent/orchestrate";
import { scheduleItem, unscheduleItem } from "@/lib/seo-intel/calendar-schedule";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { isDay } from "@/lib/seo-intel/sqlutil";

export const dynamic = "force-dynamic";

const body = z.object({
  date: z.string().refine(isDay, "Use YYYY-MM-DD"),
  time: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)"), z.null()]).default(null),
});

/**
 * POST /api/admin/seo/calendar/{id}/schedule { date, time? } (IST; 09:00 without a time). Pressing Schedule is the
 * person's approval of the draft as it is: a ready draft post is scheduled to publish then, in their name. Without a
 * ready draft the date is kept, `note` says why, and a missing draft is generated (reviewed and scheduled afterwards).
 */
export const POST = seoRoute<{ id: string }>("calendar-schedule", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const b = parse(body, ctx.body);
  const r = await scheduleItem(id, ctx.actor, b.date, b.time);
  await ctx.audit(r.scheduled ? "calendar.schedule" : "calendar.date", id, { date: b.date, time: b.time, publishAt: r.publishAt, note: r.note });
  let draft: unknown = null;
  let draftError: string | null = null;
  if (!r.scheduled) {
    try {
      draft = await draftIfScheduled(id, ctx.actor);
      if (draft) await ctx.audit("calendar.draft", id, { ...(draft as object), automatic: true });
    } catch (e) {
      draftError = `The date is saved, but the draft was not started: ${(e as Error).message}`;
    }
  }
  return json({ ...r, draft, draftError });
});

/** DELETE /api/admin/seo/calendar/{id}/schedule — clear the date; a post the calendar scheduled goes back to draft. */
export const DELETE = seoRoute<{ id: string }>("calendar-unschedule", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const r = await unscheduleItem(id, ctx.actor);
  await ctx.audit("calendar.unschedule", id, r);
  return json(r);
});
