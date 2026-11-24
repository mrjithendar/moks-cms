import { z } from "zod";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { listDeliveries, previewEmail, queueDeliveries } from "@/lib/reports/email";
import { ReportError } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

const fail = (e: unknown): never => {
  if (e instanceof ReportError) throw new SeoApiError(e.message, e.status, e.code);
  throw e;
};

/** GET /api/admin/crewai/reports/{id}/email — the email as it will be sent (preview), and this report's deliveries. */
export const GET = seoRoute<{ id: string }>("report-email-preview", {}, async (_req, ctx, p) => {
  try {
    const attach = ctx.query.get("attach") !== "false";
    return json({ preview: await previewEmail(p.id, attach), deliveries: await listDeliveries(p.id, 50) });
  } catch (e) {
    return fail(e);
  }
});

const body = z.object({ recipients: z.array(z.string().trim().toLowerCase().email()).min(1, "Add at least one recipient.").max(10), attach: z.boolean().default(true) });

/** POST /api/admin/crewai/reports/{id}/email — {recipients, attach}: one queued delivery per recipient. Audit-logged. */
export const POST = seoRoute<{ id: string }>("report-email", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(body, ctx.body ?? {});
  try {
    const r = await queueDeliveries(p.id, b.recipients, { attach: b.attach, createdBy: ctx.actor.label });
    await ctx.audit("report.email", p.id, { recipients: b.recipients, attach: b.attach });
    return json(r, 202);
  } catch (e) {
    return fail(e);
  }
});
