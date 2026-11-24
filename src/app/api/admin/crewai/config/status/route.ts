import { syncStatus } from "@/lib/crewai/bundle/sync";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/config/status[?fresh=1] — the configuration as it runs: version, counts, last sync, drift. */
export const GET = seoRoute("crewai-config-status", {}, async (_req, ctx) => json(await syncStatus({ fresh: ctx.query.get("fresh") === "1" })));
