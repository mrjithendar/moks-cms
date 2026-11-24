import { SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { downloadUrl, ReportError } from "@/lib/reports/service";
import { FILE_KINDS, type FileKind } from "@/lib/reports/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/crewai/reports/{id}/download?format=pdf|html|json|csv — a 5-minute signed link to the file in R2
 * (302). The objects are private; no permanent or public URL exists. Admin only, audit-logged.
 */
export const GET = seoRoute<{ id: string }>("report-download", { rate: { max: 60, windowSeconds: 60 } }, async (_req, ctx, p) => {
  const format = (ctx.query.get("format") ?? "pdf") as FileKind;
  if (!FILE_KINDS.includes(format)) throw new SeoApiError("Use format=pdf, html, json or csv.", 400, "invalid");
  try {
    const { url, file } = await downloadUrl(p.id, format, 300);
    await ctx.audit("report.download", p.id, { format, bytes: file.bytes });
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } });
  } catch (e) {
    if (e instanceof ReportError) throw new SeoApiError(e.message, e.status, e.code);
    throw e;
  }
});
