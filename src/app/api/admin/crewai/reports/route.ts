import { z } from "zod";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { createReport, listReports, ReportError } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

const filters = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().regex(/^[a-z_]{2,20}$/).optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
  type: z.string().regex(/^[a-z_0-9]{2,20}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

/** GET /api/admin/crewai/reports — this site's reports (console reports and the weekly/monthly briefings), filtered. */
export const GET = seoRoute("reports-list", {}, async (_req, ctx) => {
  const f = parse(filters, Object.fromEntries(ctx.query.entries()));
  return json(await listReports(f));
});

/**
 * POST /api/admin/crewai/reports — {range: {preset, start?, end?}, categories, crews?, flows?, sources?, title?, email?}.
 * Queues the report (the web worker builds it; the SEO agent analyses it and renders the PDF) and answers at once:
 * 202 {id}, or 200 {id, existing: true} when the same report is already being generated.
 */
export const POST = seoRoute("reports-create", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx) => {
  try {
    const r = await createReport({ id: ctx.user.id, label: ctx.actor.label }, ctx.body ?? {});
    if (!r.existing) await ctx.audit("report.generate", r.id, { request: ctx.body as Record<string, unknown> });
    return json(r, r.existing ? 200 : 202);
  } catch (e) {
    if (e instanceof ReportError) throw new SeoApiError(e.message, e.status, e.code);
    throw e;
  }
});
