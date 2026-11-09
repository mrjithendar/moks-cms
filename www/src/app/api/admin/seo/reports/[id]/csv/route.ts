import { SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { getReport, reportCsv } from "@/lib/seo-intel/reports";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/reports/{id}/csv — CSV export (spreadsheet-injection safe). */
export const GET = seoRoute<{ id: string }>("report-csv", {}, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Report not found.", 404, "not_found");
  const r = await getReport(id);
  if (!r) throw new SeoApiError("Report not found.", 404, "not_found");
  await ctx.audit("report.export", id, { format: "csv" });
  return new Response(reportCsv(r), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="seo-${r.type}-${r.period.start}.csv"`, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
  });
});
