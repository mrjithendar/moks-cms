import { SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { getReport } from "@/lib/seo-intel/reports";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/seo/reports/{id}/pdf — the designed PDF that report_flow stored in R2: a 5-minute presigned link
 * (the object itself is private). Admin only, audited.
 */
export const GET = seoRoute<{ id: string }>("report-pdf", {}, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Report not found.", 404, "not_found");
  const r = (await getReport(id)) as (Awaited<ReturnType<typeof getReport>> & { pdf?: { key: string; filename: string } }) | null;
  if (!r) throw new SeoApiError("Report not found.", 404, "not_found");
  if (!r.pdf?.key) throw new SeoApiError("This report has no PDF yet. PDFs are created by the CrewAI report flow.", 404, "no_pdf");
  const { presignGet } = await import("@/lib/storage");
  const url = await presignGet(r.pdf.key, r.pdf.filename, 300);
  await ctx.audit("report.export", id, { format: "pdf" });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } });
});
