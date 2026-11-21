import { z } from "zod";
import { loadLlmProviders, PROVIDERS_TOO_OLD } from "@/lib/llm-providers-view";
import { AgentError, putLlmProvider } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/llm-providers — the seo-agent's provider kinds, providers and models. Never a key. */
export const GET = seoRoute("llm-providers", {}, async () => json(await loadLlmProviders()));

// Only the shape is checked here; the agent owns the rules (kinds, URLs, prices) and answers 422 with its issues.
const price = z.number().finite().nonnegative().nullable();
const count = z.number().int().positive().nullable();
const model = z.object({
  model_id: z.string().min(1).max(200),
  label: z.string().max(120),
  enabled: z.boolean(),
  free: z.boolean(),
  input_usd: price,
  output_usd: price,
  cache_read_usd: price,
  cache_write_usd: price,
  context_window: count,
  max_output: count,
  structured_output: z.boolean(),
  tools: z.boolean(),
  vision: z.boolean(),
});
const body = z.object({
  id: z.string().min(2).max(40),
  kind: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  base_url: z.string().max(300),
  region: z.string().max(40),
  deployment: z.string().max(120),
  api_version: z.string().max(40),
  api_key: z.string().max(4000).optional(),
  models: z.array(model).max(500).optional(),
});

/**
 * PUT /api/admin/seo/llm-providers — hand one provider (and its models, when sent) to the seo-agent, which
 * validates, seals the key and stores it. Audit-logged here by name only: the key is never written to the audit
 * log, only whether it was set, replaced or removed.
 */
export const PUT = seoRoute("llm-providers-put", { mutating: true, rate: { max: 40, windowSeconds: 600 } }, async (_req, ctx) => {
  const next = parse(body, ctx.body);
  try {
    const { saved, ...view } = await putLlmProvider(next, ctx.actor.label);
    await ctx.audit("llm_provider.update", next.id, {
      kind: next.kind,
      enabled: next.enabled,
      created: saved?.created ?? null,
      key: next.api_key === undefined ? "unchanged" : next.api_key === "" ? "removed" : "set",
      models: next.models === undefined ? "unchanged" : next.models.map((m) => `${m.model_id}${m.enabled ? " (on)" : ""}`).sort(),
    });
    return json({ view });
  } catch (e) {
    if (e instanceof AgentError) {
      if (e.status === 404 || e.status === 405) throw new SeoApiError(PROVIDERS_TOO_OLD, 503, "agent");
      throw new SeoApiError(e.message, e.status === 422 ? 400 : e.status >= 500 ? 503 : e.status, e.status === 422 ? "invalid" : "agent", e.issues);
    }
    throw e;
  }
});
