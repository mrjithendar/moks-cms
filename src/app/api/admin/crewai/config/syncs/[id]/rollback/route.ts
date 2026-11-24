import { rollbackImport } from "@/lib/crewai/bundle/import";
import { errorJson } from "@/lib/crewai/bundle/service";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/crewai/config/syncs/{id}/rollback — put the configuration back as it was before that import (its
 * snapshot), as a new import that overwrites and removes what the import added. Recorded and audit-logged like any import.
 */
export const POST = seoRoute<{ id: string }>("crewai-config-rollback", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  try {
    return json(await rollbackImport(id, ctx.actor));
  } catch (e) {
    return errorJson(e);
  }
});
