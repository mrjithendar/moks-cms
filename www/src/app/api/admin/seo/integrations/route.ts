import { json, seoRoute } from "@/lib/seo-intel/http";
import { integrationsView } from "@/lib/seo-intel/queries";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/integrations — connection state. Never returns key material (only the service-account email). */
export const GET = seoRoute("integrations", {}, async () => json(await integrationsView()));
