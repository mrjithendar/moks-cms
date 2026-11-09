import { testIntegrations } from "@/lib/seo-intel/integrations";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/integrations/test — one real request per provider; connected only on a real success. */
export const POST = seoRoute("integrations-test", { mutating: true, rate: { max: 6, windowSeconds: 600 } }, async (_req, ctx) => {
  const results = await testIntegrations();
  await ctx.audit("integrations.test", undefined, { results: results.map((r) => ({ provider: r.provider, status: r.status })) });
  return json({ results });
});
