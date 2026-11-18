import { revalidatePath } from "next/cache";
import { z } from "zod";
import { agentStatus, saveAdminEndpoint } from "@/lib/seo-agent/endpoint";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/agent/endpoint — whether the SEO agent is on, where it is, and why (endpoint.ts). */
export const GET = seoRoute("agent-endpoint", {}, async () => json({ status: await agentStatus() }));

/**
 * PUT /api/admin/seo/agent/endpoint {url} — save the agent's endpoint (null or "" removes it, back to discovery), then
 * check it at once. Saved even when it does not answer yet (the agent may start later). Audit-logged with before/after.
 */
export const PUT = seoRoute("agent-endpoint-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const { url } = parse(z.object({ url: z.string().max(300).nullable() }), ctx.body ?? {});
  const { before, after } = await saveAdminEndpoint(url, ctx.actor.id);
  await ctx.audit("seo_agent.endpoint", "seo_agent", { before, after });
  const status = await agentStatus({}, { fresh: true });
  // Footer link, llms.txt and the Ask the Blog widget follow the agent.
  revalidatePath("/", "layout");
  return json({ status });
});

/** POST /api/admin/seo/agent/endpoint — check again now (discovery or the saved endpoint), without saving anything. */
export const POST = seoRoute("agent-endpoint-check", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async () => {
  const status = await agentStatus({}, { fresh: true });
  revalidatePath("/", "layout");
  return json({ status });
});
