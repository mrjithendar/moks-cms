import { listSyncs } from "@/lib/crewai/bundle/sync";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/config/syncs — every configuration import and export, newest first (the audit trail). */
export const GET = seoRoute("crewai-config-syncs", {}, async (_req, ctx) => json({ items: await listSyncs(Number(ctx.query.get("limit") ?? 50)) }));
