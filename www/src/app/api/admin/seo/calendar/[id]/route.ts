import { patchSchema, updateItem } from "@/lib/seo-intel/calendar";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** PATCH /api/admin/seo/calendar/{id} — status (flow-checked; "published" only follows the linked post), date, owner, linked post. */
export const PATCH = seoRoute<{ id: string }>("calendar-patch", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const change = await updateItem(id, parse(patchSchema, ctx.body));
  await ctx.audit("calendar.update", id, change);
  return json(change.after);
});
