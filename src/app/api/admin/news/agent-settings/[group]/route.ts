import { z } from "zod";
import { AgentError, putNewsAgentSettings } from "@/lib/news-agent/client";
import { NEWS_TOO_OLD } from "@/lib/news-agent/settings-client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

// Only the shape is checked here; the news agent owns the fields and their rules and answers 422 with its issues.
const value = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.array(z.string().max(300)).max(300), z.null()]);
const body = z.object({ values: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/), value) });
const GROUP = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * PUT /api/admin/news/agent-settings/{group} — hand one group's changed fields to the news agent
 * (PUT /admin-settings/{group}), which validates, stores (secrets sealed) and applies them. Audit-logged by field name
 * only: a value may be a secret (the Claude key).
 */
export const PUT = seoRoute<{ group: string }>("news-agent-settings-put", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx, params) => {
  if (!GROUP.test(params.group ?? "")) throw new SeoApiError("No such settings group.", 404, "not_found");
  const { values } = parse(body, ctx.body);
  try {
    const view = await putNewsAgentSettings(params.group, values, ctx.actor.label);
    const cleared = Object.entries(values).filter(([, v]) => v === null || v === "" || (Array.isArray(v) && v.length === 0)).map(([k]) => k);
    await ctx.audit("news_agent_settings.update", params.group, { saved: Object.keys(values).filter((k) => !cleared.includes(k)).sort(), cleared: cleared.sort() });
    return json({ view });
  } catch (e) {
    if (e instanceof AgentError) {
      if (e.status === 404 || e.status === 405) throw new SeoApiError(NEWS_TOO_OLD, 503, "agent");
      throw new SeoApiError(e.message, e.status === 422 ? 400 : e.status >= 500 ? 503 : e.status, e.status === 422 ? "invalid" : "agent", e.issues);
    }
    throw e;
  }
});
