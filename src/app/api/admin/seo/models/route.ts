import { json, seoRoute } from "@/lib/seo-intel/http";
import { listProposals, modelsView } from "@/lib/seo-intel/ml-admin";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/models — every v5 model: latest version, metrics vs the rule, what the site uses now and why. */
export const GET = seoRoute("models", {}, async () => json({ ...(await modelsView()), proposals: await listProposals() }));
