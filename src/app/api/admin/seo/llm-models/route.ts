import { loadAliases } from "@/lib/llm/status";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/llm-models — the LiteLLM aliases a crew, flow or profile may name (D-110), for AliasPicker. Admins only. */
export const GET = seoRoute("llm-models", {}, async () => json(await loadAliases()));
