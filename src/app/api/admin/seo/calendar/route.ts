import type { Actor } from "@/lib/posts";
import { draftIfScheduled } from "@/lib/seo-agent/orchestrate";
import { createItem, createSchema, listCalendar } from "@/lib/seo-intel/calendar";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { isDay } from "@/lib/seo-intel/sqlutil";

export const dynamic = "force-dynamic";

/** A date with no draft starts "Generate draft" by itself (draftIfScheduled); a failure there never undoes the calendar change. */
async function autoDraft(id: string, ctx: { actor: Actor; audit: (action: string, target?: string, detail?: Record<string, unknown>) => Promise<unknown> }) {
  try {
    const r = await draftIfScheduled(id, ctx.actor);
    if (r) await ctx.audit("calendar.draft", id, { ...r, automatic: true });
    return r ? { draft: r } : {};
  } catch (e) {
    return { draftError: `The date is saved, but the draft was not started: ${(e as Error).message}` };
  }
}


/** GET /api/admin/seo/calendar?from&to&status — scheduled items in the range plus unscheduled ones. */
export const GET = seoRoute("calendar", {}, async (_req, ctx) => {
  const from = ctx.query.get("from");
  const to = ctx.query.get("to");
  return json(await listCalendar({ from: isDay(from) ? from : undefined, to: isDay(to) ? to : undefined, status: ctx.query.get("status") ?? undefined }));
});

/**
 * POST /api/admin/seo/calendar — add a manual item { title, category?, targetDate?, targetTime?, notes? }. A date given
 * here is kept and its draft generated; the post is scheduled once the person has reviewed the draft and presses
 * Schedule (calendar-schedule.ts).
 */
export const POST = seoRoute("calendar-create", { mutating: true }, async (_req, ctx) => {
  const input = parse(createSchema, ctx.body);
  const id = await createItem(input);
  await ctx.audit("calendar.create", id, { title: input.title, targetDate: input.targetDate ?? null });
  return json({ id, ...(await autoDraft(id, ctx)) }, 201);
});
