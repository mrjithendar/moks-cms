import { getDraft, previewOf } from "@/lib/seo-intel/drafts";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/drafts/{id} — status, changes and verification (the review page polls this while generating). */
export const GET = seoRoute<{ id: string }>("drafts-get", {}, async (_req, _ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const d = await getDraft(id);
  if (!d) throw new SeoApiError("Draft not found.", 404, "not_found");
  const p = previewOf(d);
  return json({ id: d.id, status: d.status, failureReason: d.failure_reason ?? null, changes: d.changes, flags: d.flags, verification: d.verification ?? null, conflicts: p.conflicts, article: d.article });
});
