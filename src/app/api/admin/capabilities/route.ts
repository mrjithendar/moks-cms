import { moduleStates } from "@/lib/modules";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/capabilities — the admin's optional modules and whether this deployment has them (lib/modules.ts):
 * {modules: [{id, label, installed, available, version, reason, menuGroups, setupHref}]}. The menu and the modules' pages
 * use the same answer; a client that draws its own navigation asks here instead of keeping a flag of its own.
 */
export const GET = seoRoute("capabilities", {}, async () => json({ modules: await moduleStates() }));
