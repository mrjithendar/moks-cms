import { SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { getReportData } from "@/lib/reports/service";
import { renderHtmlDocument } from "@/lib/reports/render";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/crewai/reports/{id}/preview — the report as its standalone HTML file, rendered from the stored data,
 * for the in-app preview (a sandboxed frame). Its own CSP allows nothing but its inline styles.
 */
export const GET = seoRoute<{ id: string }>("report-preview", { rate: { max: 60, windowSeconds: 60 } }, async (_req, _ctx, p) => {
  const data = await getReportData(p.id);
  if (!data) throw new SeoApiError("This report has no data yet.", 404, "not_found");
  return new Response(renderHtmlDocument(data), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox", "Referrer-Policy": "no-referrer" },
  });
});
