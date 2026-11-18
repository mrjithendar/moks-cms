import { deleteItem, patchSchema, updateItem } from "@/lib/seo-intel/calendar";
import { holdScheduledPost } from "@/lib/seo-intel/calendar-schedule";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** PATCH /api/admin/seo/calendar/{id} — title, category, cluster, owner, brief, linked post. Dates go through /schedule. */
export const PATCH = seoRoute<{ id: string }>("calendar-patch", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const change = await updateItem(id, parse(patchSchema, ctx.body));
  await ctx.audit("calendar.update", id, change);
  return json(change.after);
});

/**
 * DELETE /api/admin/seo/calendar/{id} — remove the item from the calendar (hidden, so the suggestion engine does not
 * add it again). Its post is kept; a post the calendar scheduled goes back to draft first.
 */
export const DELETE = seoRoute<{ id: string }>("calendar-delete", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const unscheduled = await holdScheduledPost(id, ctx.actor, "Item deleted from the calendar.");
  await deleteItem(id);
  await ctx.audit("calendar.delete", id, { unscheduled });
  return json({ deleted: true, unscheduled });
});
