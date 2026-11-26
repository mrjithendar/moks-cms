import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { EmailButton } from "@/components/crewai/reports/EmailButton";
import { ReportStatus } from "@/components/crewai/reports/ReportClient";
import { kb } from "@/components/crewai/reports/labels";
import { ApiButton } from "@/components/seo/ApiButton";
import { Empty, fmtWhen, Section } from "@/components/seo/ui";
import { buttonClass } from "@/components/ui/form";
import { listDeliveries } from "@/lib/reports/email";
import { listReports } from "@/lib/reports/service";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "SEO-AI reports" };
export const dynamic = "force-dynamic";

/**
 * SEO-AI reports: the weekly and monthly SEO briefings and the reports made in the CrewAI console, in one list, and
 * their email: generate and email, email an existing report (recipients, PDF attached or a signed link, preview), and
 * the history of every email sent (D-102).
 */
export default async function ReportsPage() {
  const [{ items }, s, deliveries] = await Promise.all([listReports({ limit: 30 }), getSeoSettings(), listDeliveries(undefined, 30)]);
  const { mailConfigured } = await import("@/lib/mail");
  const mail = await mailConfigured();
  return (
    <>
      <AdminHeader
        title="SEO-AI reports"
        description="Every report of the site, and its email. The weekly (last full Monday–Sunday) and monthly briefings compare with the previous period; reports made in the CrewAI console cover any dates and categories, with the AI analysis, costs and an action plan. All are stored in R2 and downloaded through short-lived links."
        actions={<>
          <Link className={buttonClass("primary", "sm")} href="/admin/crewai/reports/new?email=1">Generate and email</Link>
          <Link className={buttonClass("secondary", "sm")} href="/admin/crewai/reports/new">New report</Link>
          <ApiButton url="/api/admin/seo/reports/generate" body={{ type: "weekly" }} label="Weekly briefing" />
          <ApiButton url="/api/admin/seo/reports/generate" body={{ type: "monthly" }} label="Monthly briefing" />
        </>}
      />
      <Card className="mb-6">
        <p className="text-sm">
          Email: {mail ? "configured" : <>not configured (<Link className="link" href="/admin/settings/email?section=email">Settings → Email</Link>): nothing is sent until it is</>}.
          {" "}Briefings are sent automatically {s.reports.emailEnabled && s.reports.recipients.length ? `to ${s.reports.recipients.join(", ")}` : "to nobody (switch email on and add recipients)"}.
          {" "}Template, attachments, link lifetime and how long reports are kept: <Link className="link" href="/admin/settings/seo?section=reports">Settings → Search & SEO → Reports</Link>.
        </p>
      </Card>
      <Section title="Reports" description="The newest first. Email sends to the recipients you choose, with the PDF attached when it fits or a download link.">
        {items.length ? (
          <Table head={<tr><th className={th}>Report</th><th className={th}>Dates</th><th className={th}>Status</th><th className={th}>Made</th><th className={th}>Emailed</th><th className={th}>Files</th><th className={th}>Email</th></tr>}>
            {items.map((r) => (
              <tr key={r.id}>
                <td className={td}><Link className="underline" href={r.kind === "briefing" ? `/admin/reports/${r.id}` : `/admin/crewai/reports/${r.id}`}>{r.title}</Link><span className="block text-xs text-fg-subtle">{r.kind === "briefing" ? `${r.preset} briefing (${r.createdBy ? "manual" : "schedule"})` : "CrewAI console report"}</span></td>
                <td className={`${td} whitespace-nowrap`}>{r.start} – {r.end}</td>
                <td className={td}><ReportStatus status={r.status} /></td>
                <td className={`${td} whitespace-nowrap`}>{fmtWhen(r.createdAt)}</td>
                <td className={`${td} whitespace-nowrap`}>{r.emailedAt ? fmtWhen(r.emailedAt) : "—"}</td>
                <td className={`${td} whitespace-nowrap`}>
                  {r.files.pdf ? <a className="underline" href={`/api/admin/crewai/reports/${r.id}/download?format=pdf`}>PDF</a> : <span className="text-fg-subtle">No PDF</span>}
                  {r.kind === "briefing" ? <> · <a className="underline" href={`/api/admin/seo/reports/${r.id}/csv`}>CSV</a></> : r.files.csv ? <> · <a className="underline" href={`/api/admin/crewai/reports/${r.id}/download?format=csv`}>CSV</a></> : null}
                  {r.bytes > 0 && <span className="block text-xs text-fg-subtle">{kb(r.bytes)}{r.summarized ? " · summary checked" : ""}</span>}
                </td>
                <td className={td}>{r.status === "completed" ? <EmailButton id={r.id} /> : <span className="text-xs text-fg-subtle">when finished</span>}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No reports yet.</Empty>}
      </Section>
      <Section title="Email history" description="Every report email: queued, sent, retried after a provider error, or failed with the reason.">
        {deliveries.length ? (
          <Table head={<tr><th className={th}>Report</th><th className={th}>Recipient</th><th className={th}>Status</th><th className={th}>How</th><th className={th}>Queued</th><th className={th}>Sent</th></tr>}>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td className={td}>{d.reportTitle}</td>
                <td className={td}>{d.recipient}</td>
                <td className={td}><ReportStatus status={d.status} />{d.error && <span className="mt-1 block text-xs text-red-700 dark:text-red-300">{d.error}</span>}</td>
                <td className={td}>{d.mode === "attachment" ? "PDF attached" : "Download link"}</td>
                <td className={td}>{fmtWhen(d.createdAt)}</td>
                <td className={td}>{d.sentAt ? fmtWhen(d.sentAt) : "—"}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No report has been emailed yet.</Empty>}
      </Section>
    </>
  );
}
