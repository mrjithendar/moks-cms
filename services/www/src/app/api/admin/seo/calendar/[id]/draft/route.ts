import { createDraftFromItem } from "@/lib/seo-intel/calendar";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/calendar/{id}/draft — create a DRAFT post from an approved item (never published). */
export const POST = seoRoute<{ id: string }>("calendar-draft", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const r = await createDraftFromItem(id, ctx.actor);
  await ctx.audit("calendar.draft", id, r);
  return json(r, 201);
});
