import { z } from "zod";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { generateReport } from "@/lib/seo-intel/reports";

export const dynamic = "force-dynamic";

const body = z.object({ type: z.enum(["weekly", "monthly"]) });

/** POST /api/admin/seo/reports/generate — { type } builds (or rebuilds) the last full period's report now. */
export const POST = seoRoute("reports-generate", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx) => {
  const { type } = parse(body, ctx.body);
  const r = await generateReport(type, "manual");
  await ctx.audit("report.generate", r.id, { type, emailed: r.emailed });
  return json(r, 201);
});
