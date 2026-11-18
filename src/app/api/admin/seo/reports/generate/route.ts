import { z } from "zod";
import { AgentError, kickoff } from "@/lib/seo-agent/client";
import { orchestrator } from "@/lib/seo-agent/endpoint";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { generateReport } from "@/lib/seo-intel/reports";

export const dynamic = "force-dynamic";

const body = z.object({ type: z.enum(["weekly", "monthly"]) });

/**
 * POST /api/admin/seo/reports/generate — { type } builds (or rebuilds) the last full period's report now. With
 * the SEO agent on it starts report_flow (numbers → checked narrative → PDF in R2 → email), like the CronJob.
 */
export const POST = seoRoute("reports-generate", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx) => {
  const { type } = parse(body, ctx.body);
  if ((await orchestrator()) === "crewai") {
    try {
      const r = await kickoff("report_flow", { period: type }, { actor: ctx.actor.label });
      await ctx.audit("report.generate", undefined, { type, runId: r.run_id, existing: r.existing });
      return json(r, 202);
    } catch (e) {
      if (e instanceof AgentError) throw new SeoApiError(e.message, 503, "agent_unavailable");
      throw e;
    }
  }
  const r = await generateReport(type, "manual");
  await ctx.audit("report.generate", r.id, { type, emailed: r.emailed });
  return json(r, 201);
});
