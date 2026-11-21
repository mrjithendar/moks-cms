import { z } from "zod";
import { newsAgentStatus, saveNewsAgentEndpoint } from "@/lib/news-agent/endpoint";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/news/agent — whether the news agent is found, where, and why (lib/news-agent/endpoint.ts). */
export const GET = seoRoute("news-agent-endpoint", {}, async () => json({ status: await newsAgentStatus() }));

/**
 * PUT /api/admin/news/agent {url} — save the news agent's endpoint (null or "" removes it, back to discovery), then
 * check it at once. Saved even when it does not answer yet. Audit-logged with before/after.
 */
export const PUT = seoRoute("news-agent-endpoint-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const { url } = parse(z.object({ url: z.string().max(300).nullable() }), ctx.body ?? {});
  const { before, after } = await saveNewsAgentEndpoint(url, ctx.actor.id);
  await ctx.audit("news_agent.endpoint", "news_agent", { before, after });
  return json({ status: await newsAgentStatus({}, { fresh: true }) });
});

/** POST /api/admin/news/agent — check again now, without saving anything. */
export const POST = seoRoute("news-agent-endpoint-check", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async () => json({ status: await newsAgentStatus({}, { fresh: true }) }));
