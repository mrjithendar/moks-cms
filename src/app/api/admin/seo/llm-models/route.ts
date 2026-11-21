import { loadLlmModels } from "@/lib/llm-providers-view";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/llm-models — models that are switched on, for ModelPicker. Admins only. */
export const GET = seoRoute("llm-models", {}, async () => json(await loadLlmModels()));
