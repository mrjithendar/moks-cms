import { getSync } from "@/lib/crewai/bundle/sync";
import { json, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/config/syncs/{id} — one import or export with its plan (the snapshot stays on the server). */
export const GET = seoRoute<{ id: string }>("crewai-config-sync", {}, async (_req, _ctx, { id }) => {
  const r = await getSync(id);
  if (!r) throw new SeoApiError("No such import or export.", 404, "not_found");
  const { snapshot, ...rest } = r;
  return json({ ...rest, hasSnapshot: Boolean(snapshot) });
});
