import { createItem, createSchema, listCalendar } from "@/lib/seo-intel/calendar";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { isDay } from "@/lib/seo-intel/sqlutil";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/calendar?from&to&status — scheduled items in the range plus unscheduled ones. */
export const GET = seoRoute("calendar", {}, async (_req, ctx) => {
  const from = ctx.query.get("from");
  const to = ctx.query.get("to");
  return json(await listCalendar({ from: isDay(from) ? from : undefined, to: isDay(to) ? to : undefined, status: ctx.query.get("status") ?? undefined }));
});

/** POST /api/admin/seo/calendar — add a manual item { title, category?, targetDate?, notes? } (status approved). */
export const POST = seoRoute("calendar-create", { mutating: true }, async (_req, ctx) => {
  const input = parse(createSchema, ctx.body);
  const id = await createItem(input);
  await ctx.audit("calendar.create", id, { title: input.title, targetDate: input.targetDate ?? null });
  return json({ id }, 201);
});
