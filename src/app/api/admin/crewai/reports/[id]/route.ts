import { z } from "zod";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { cancelReport, deleteReport, getReportRow, regenerateReport, ReportError, retryReport } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

const fail = (e: unknown): never => {
  if (e instanceof ReportError) throw new SeoApiError(e.message, e.status, e.code);
  throw e;
};

/** GET /api/admin/crewai/reports/{id} — status, progress, files and errors (the page polls this while it runs). */
export const GET = seoRoute<{ id: string }>("report-get", { rate: { max: 300, windowSeconds: 60 } }, async (_req, _ctx, p) => {
  const row = await getReportRow(p.id);
  if (!row) throw new SeoApiError("Report not found.", 404, "not_found");
  return json({ report: { ...row, files: Object.fromEntries(Object.entries(row.files).map(([k, f]) => [k, { bytes: f!.bytes, filename: f!.filename, contentType: f!.contentType }])) } });
});

const action = z.object({ action: z.enum(["cancel", "retry", "regenerate"]) });

/** POST /api/admin/crewai/reports/{id} — {action: cancel | retry | regenerate}. Audit-logged. */
export const POST = seoRoute<{ id: string }>("report-action", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(action, ctx.body ?? {});
  const actor = { id: ctx.user.id, label: ctx.actor.label };
  try {
    if (b.action === "cancel") await cancelReport(p.id, actor);
    else if (b.action === "retry") await retryReport(p.id, actor);
    else return json(await regenerateReport(p.id, actor), 202);
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
});

/** DELETE /api/admin/crewai/reports/{id} — deletes the report and its files in R2 (a running one is cancelled first). */
export const DELETE = seoRoute<{ id: string }>("report-delete", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx, p) => {
  try {
    await deleteReport(p.id, { id: ctx.user.id, label: ctx.actor.label });
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
});
