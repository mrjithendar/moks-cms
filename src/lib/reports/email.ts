import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { enqueue } from "../jobs";
import { log } from "../log";
import { fmt } from "./format";
import { esc } from "./render";
import { getReportData, getReportRow, reportScope, ReportError, type ReportRow } from "./service";
import type { SiteReport } from "./types";

/**
 * Report email (SEO-AI Reports, D-102). One delivery row per recipient (seo_report_deliveries), each sent by job
 * "report_email" in the web worker's queue: queued → sent, or retried (a provider error, tried again with backoff) →
 * sent or failed. The PDF is attached when the provider accepts its size (Settings → Reports: attach, largest PDF);
 * otherwise, and always as well, the email has a signed R2 download link (valid Settings → Reports hours, at most 7
 * days) and the admin link (sign-in required). Only admins send; the audit log records every send and its recipients.
 */
const MAX_ATTEMPTS = 3;
const R2_MAX_LINK_S = 7 * 24 * 3600;

const q = async <T = Record<string, unknown>>(db: Db, query: ReturnType<typeof sql>) => rowsOf<T>(await db.execute(query));

export type EmailOptions = { attach: boolean; createdBy: string };
export type Delivery = { id: string; recipient: string; status: "queued" | "sent" | "failed" | "retried"; mode: "attachment" | "link"; attempts: number; error: string | null; createdBy: string | null; createdAt: string; sentAt: string | null };

export async function queueDeliveries(reportId: string, recipients: string[], opts: EmailOptions): Promise<{ queued: number; ids: string[] }> {
  const row = await getReportRow(reportId);
  if (!row) throw new ReportError("Report not found.", 404, "not_found");
  if (row.status !== "completed") throw new ReportError("Only a finished report can be emailed.", 409, "not_completed");
  const { mailConfigured } = await import("../mail");
  if (!(await mailConfigured())) throw new ReportError("Email is not configured: set it up under Settings → Email first.", 409, "mail_not_configured");
  const db = await getDb();
  const msg = await buildMessage(row, await getReportData(reportId), opts.attach);
  const ids: string[] = [];
  for (const to of [...new Set(recipients.map((r) => r.trim().toLowerCase()))].slice(0, 10)) {
    const [d] = await q<{ id: string }>(db, sql`insert into seo_report_deliveries (report_id, recipient, mode, subject, created_by) values (${reportId}, ${to}, ${msg.mode}, ${msg.subject.slice(0, 300)}, ${opts.createdBy}) returning id`);
    await enqueue("report_email", { deliveryId: d!.id, attach: opts.attach }, { dedupeKey: `report_email:${d!.id}`, maxAttempts: MAX_ATTEMPTS });
    ids.push(d!.id);
  }
  return { queued: ids.length, ids };
}

export async function listDeliveries(reportId?: string, limit = 50): Promise<(Delivery & { reportId: string; reportTitle: string })[]> {
  const db = await getDb();
  const { siteId } = reportScope();
  const rows = await q(db, sql`
    select d.*, r.title from seo_report_deliveries d join seo_reports r on r.id = d.report_id
    where (r.site_id = ${siteId} or r.site_id is null) ${reportId ? sql`and d.report_id = ${reportId}` : sql``} order by d.created_at desc limit ${limit}`);
  return rows.map((r) => ({ id: String(r.id), reportId: String(r.report_id), reportTitle: String(r.title ?? "Report"), recipient: String(r.recipient), status: String(r.status) as Delivery["status"], mode: String(r.mode) as Delivery["mode"], attempts: Number(r.attempts), error: (r.error as string | null) ?? null, createdBy: (r.created_by as string | null) ?? null, createdAt: new Date(String(r.created_at)).toISOString(), sentAt: r.sent_at ? new Date(String(r.sent_at)).toISOString() : null }));
}

type Built = { subject: string; text: string; html: string; mode: "attachment" | "link"; pdfBytes: number | null; maxBytes: number; linkHours: number };

/** The email exactly as it will be sent (also the preview), without the signed link, which is made at send time. */
export async function buildMessage(row: ReportRow, data: SiteReport | null, attach: boolean, link = "{signed download link}"): Promise<Built> {
  const { getSeoSettings } = await import("../seo-intel/settings");
  const { activeMailProvider, PROVIDER_MAX_BYTES } = await import("../mail");
  const s = (await getSeoSettings()).reports;
  const provider = (await activeMailProvider()) ?? "smtp";
  const maxBytes = s.attachMaxMb > 0 ? Math.min(s.attachMaxMb * 1024 * 1024, PROVIDER_MAX_BYTES[provider] ?? Infinity) : (PROVIDER_MAX_BYTES[provider] ?? 10 * 1024 * 1024);
  const pdfBytes = row.files.pdf?.bytes ?? null;
  // Base64 makes an attachment about a third larger in the message.
  const mode = attach && s.attachPdf && pdfBytes !== null && pdfBytes * 1.37 + 200_000 <= maxBytes ? "attachment" : "link";
  const scope = reportScope();
  const period = `${row.start} – ${row.end}`;
  const subject = s.subjectTemplate.replace(/\{title\}/g, row.title).replace(/\{period\}/g, period).replace(/\{site\}/g, scope.siteName).slice(0, 250);
  const admin = `${scope.origin}/admin/crewai/reports/${row.id}`;
  const linkHours = s.linkHours > 0 ? s.linkHours : R2_MAX_LINK_S / 3600;
  const a = data?.analysis ?? null;
  const findings = (data?.findings ?? []).slice(0, 5);
  const critical = (a?.action_plan ?? []).filter((x) => x.priority === "critical" || x.priority === "high").slice(0, 5);
  const headline = (data?.summary.headline ?? []).slice(0, 6);
  const lines = [
    row.title,
    `Period: ${period}${data ? ` (${data.range.days} days, compared with ${data.range.previousStart} – ${data.range.previousEnd})` : ""}`,
    "",
    ...(s.introText ? [s.introText, ""] : []),
    "Executive summary",
    a?.executive_summary || (headline.length ? headline.map((k) => `- ${k.label}: ${fmt(k.value, k.format)}`).join("\n") : "See the attached report."),
    "",
    ...(findings.length ? ["Key findings", ...findings.map((f) => `- [${f.severity}] ${f.title}`), ""] : []),
    ...(critical.length ? ["Critical recommendations", ...critical.map((x) => `- [${x.priority}] ${x.action}${x.owner ? ` (${x.owner})` : ""}`), ""] : []),
    mode === "attachment" ? "The full report is attached as a PDF." : pdfBytes === null ? "The report has no PDF; open it in the admin." : "The PDF is too large to attach: download it with the link below.",
    ...(pdfBytes !== null ? [`Download the PDF (link valid for ${linkHours} hours): ${link}`] : []),
    `Open it in the admin (sign-in required): ${admin}`,
  ];
  const text = lines.join("\n");
  const li = (x: string) => `<li>${esc(x)}</li>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a"><div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
<div style="background:#1e3a8a;color:#fff;padding:14px 20px;font-weight:700">MOKS · ${esc(scope.siteName)}</div><div style="height:3px;background:#14b8a6"></div><div style="padding:20px">
<h1 style="font-size:20px;margin:0 0 4px">${esc(row.title)}</h1><p style="margin:0 0 16px;color:#64748b">${esc(period)}</p>
${s.introText ? `<p>${esc(s.introText)}</p>` : ""}<h2 style="font-size:16px;color:#1e3a8a">Executive summary</h2>${a?.executive_summary ? `<p>${esc(a.executive_summary)}</p>` : headline.length ? `<ul>${headline.map((k) => li(`${k.label}: ${fmt(k.value, k.format)}`)).join("")}</ul>` : ""}
${findings.length ? `<h2 style="font-size:16px;color:#1e3a8a">Key findings</h2><ul>${findings.map((f) => li(`[${f.severity}] ${f.title}`)).join("")}</ul>` : ""}
${critical.length ? `<h2 style="font-size:16px;color:#1e3a8a">Critical recommendations</h2><ul>${critical.map((x) => li(`[${x.priority}] ${x.action}${x.owner ? ` (${x.owner})` : ""}`)).join("")}</ul>` : ""}
<p>${mode === "attachment" ? "The full report is attached as a PDF." : pdfBytes === null ? "The report has no PDF; open it in the admin." : "The PDF is too large to attach: download it with the button below."}</p>
${pdfBytes !== null ? `<p><a href="${esc(link)}" style="display:inline-block;background:#1e40af;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">Download the PDF</a> <span style="color:#64748b;font-size:13px">valid for ${esc(linkHours)} hours</span></p>` : ""}
<p style="font-size:13px"><a href="${esc(admin)}" style="color:#1e40af">Open the report in the admin</a> (sign-in required)</p></div>
<div style="padding:12px 20px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px">Figures computed from the site's own records. Confidential: sent by an administrator of ${esc(scope.siteName)}.</div></div></body></html>`;
  return { subject, text, html, mode, pdfBytes, maxBytes, linkHours };
}

export async function previewEmail(reportId: string, attach = true) {
  const row = await getReportRow(reportId);
  if (!row) throw new ReportError("Report not found.", 404, "not_found");
  const m = await buildMessage(row, await getReportData(reportId), attach);
  const { getSeoSettings } = await import("../seo-intel/settings");
  const { mailConfigured } = await import("../mail");
  return { subject: m.subject, text: m.text, html: m.html, mode: m.mode, pdfBytes: m.pdfBytes, maxBytes: m.maxBytes, linkHours: m.linkHours, configuredRecipients: (await getSeoSettings()).reports.recipients, mailConfigured: await mailConfigured() };
}

/** Job "report_email": send one delivery. Throws to be retried by the queue; the last attempt marks it failed. */
export async function reportEmailHandler(payload: Record<string, unknown>) {
  const id = String(payload.deliveryId ?? "");
  const db = await getDb();
  const [d] = await q<{ report_id: string; recipient: string; status: string; attempts: number }>(db, sql`update seo_report_deliveries set attempts = attempts + 1, updated_at = now() where id = ${id} and status in ('queued', 'retried') returning report_id, recipient, status, attempts`);
  if (!d) return;
  const row = await getReportRow(d.report_id);
  if (!row) {
    await db.execute(sql`update seo_report_deliveries set status = 'failed', error = 'The report was deleted.', updated_at = now() where id = ${id}`);
    return;
  }
  try {
    const { presignGet, getObjectBytes } = await import("../storage");
    const pdf = row.files.pdf;
    const { linkHours } = await buildMessage(row, null, false);
    const link = pdf ? await presignGet(pdf.key, pdf.filename, Math.min(R2_MAX_LINK_S, Math.round(linkHours * 3600))) : "";
    const m = await buildMessage(row, await getReportData(row.id), payload.attach !== false, link);
    const bytes = m.mode === "attachment" && pdf ? await getObjectBytes(pdf.key, m.maxBytes) : null;
    const mode = bytes ? "attachment" : "link";
    const { sendRichMail } = await import("../mail");
    const sent = await sendRichMail({ to: d.recipient, subject: m.subject, text: m.text, html: m.html, attachments: bytes ? [{ filename: pdf!.filename, content: bytes, contentType: "application/pdf" }] : [] });
    await db.execute(sql`update seo_report_deliveries set status = 'sent', mode = ${mode}, provider = ${sent.provider}, error = null, sent_at = now(), updated_at = now() where id = ${id}`);
    await db.execute(sql`update seo_reports set emailed_at = now() where id = ${row.id}`);
  } catch (e) {
    const error = (e as Error).message.slice(0, 480);
    const last = Number(d.attempts) >= MAX_ATTEMPTS;
    await db.execute(sql`update seo_report_deliveries set status = ${last ? "failed" : "retried"}, error = ${error}, updated_at = now() where id = ${id}`);
    log.warn("report email not sent", { operation: "report_email", deliveryId: id, attempt: Number(d.attempts), outcome: last ? "failed" : "retry", error });
    if (!last) throw e;
  }
}
