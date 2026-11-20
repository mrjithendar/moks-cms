import { loadAgentSettings } from "@/lib/seo-agent/settings-client";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/agent-settings — the settings the seo-agent lets an admin change, as the agent reports them. */
export const GET = seoRoute("agent-settings", {}, async () => json(await loadAgentSettings()));
