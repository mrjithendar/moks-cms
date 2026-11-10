import { patchSchema, updateItem } from "@/lib/seo-intel/calendar";
import type { Actor } from "@/lib/posts";
import { draftIfScheduled } from "@/lib/seo-agent/orchestrate";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** Scheduling creates the draft post by itself (draftIfScheduled); a failure there never undoes the calendar change. */
async function autoDraft(id: string, ctx: { actor: Actor; audit: (action: string, target?: string, detail?: Record<string, unknown>) => Promise<unknown> }) {
  try {
    const r = await draftIfScheduled(id, ctx.actor);
    if (r) await ctx.audit("calendar.draft", id, { ...r, automatic: true });
    return r ? { draft: r } : {};
  } catch (e) {
    return { draftError: `The item is scheduled, but its draft post was not created: ${(e as Error).message}` };
  }
}


/** PATCH /api/admin/seo/calendar/{id} — status (flow-checked; "published" only follows the linked post), date, owner, linked post. */
export const PATCH = seoRoute<{ id: string }>("calendar-patch", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const change = await updateItem(id, parse(patchSchema, ctx.body));
  await ctx.audit("calendar.update", id, change);
  return json({ ...change.after, ...(await autoDraft(id, ctx)) });
});
