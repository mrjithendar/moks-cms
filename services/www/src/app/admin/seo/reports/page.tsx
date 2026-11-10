import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { Empty, fmtWhen, Section } from "@/components/seo/ui";
import { listReports } from "@/lib/seo-intel/reports";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  const [reports, s] = await Promise.all([listReports(), getSeoSettings()]);
  return (
    <>
      <AdminHeader title="Reports" description="Weekly (last full Monday–Sunday) and monthly (last full month) reports, compared with the previous period. CSV export, a printable page, and (when the CrewAI report flow runs them) a designed PDF stored in R2 with a checked summary." actions={<><ApiButton url="/api/admin/seo/reports/generate" body={{ type: "weekly" }} label="Generate weekly" /><ApiButton url="/api/admin/seo/reports/generate" body={{ type: "monthly" }} label="Generate monthly" /></>} />
      <Card>
        <p className="text-sm">Email: {s.reports.emailEnabled && s.reports.recipients.length ? `on, to ${s.reports.recipients.join(", ")} (through Admin → Storage & email)` : "off. Enable it and add recipients in Settings; nothing is sent until both are set."}</p>
      </Card>
      <Section title="Generated reports">
        {reports.length ? (
          <Table head={<tr><th className={th}>Period</th><th className={th}>Type</th><th className={th}>Generated</th><th className={th}>Emailed</th><th className={th}>PDF (R2)</th><th className={th}>Export</th></tr>}>
            {reports.map((r) => (
              <tr key={r.id}>
                <td className={td}><Link className="underline" href={`/admin/seo/reports/${r.id}`}>{r.start} – {r.end}</Link></td>
                <td className={td}>{r.type}</td>
                <td className={td}>{fmtWhen(r.generatedAt)} ({r.trigger})</td>
                <td className={td}>{r.emailedAt ? fmtWhen(r.emailedAt) : "—"}</td>
                <td className={td}>
                  {r.pdf ? (
                    <a className="underline" href={`/api/admin/seo/reports/${r.id}/pdf`} download={r.pdf.filename ?? undefined}>Download PDF</a>
                  ) : <span className="text-fg-subtle">Not generated</span>}
                  {r.pdf && <span className="ml-1 text-xs text-fg-subtle">{Math.max(1, Math.round(r.pdf.bytes / 1024))} KB{r.summarized ? " · summary checked" : ""}</span>}
                </td>
                <td className={td}><a className="underline" href={`/api/admin/seo/reports/${r.id}/csv`}>CSV</a></td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No reports yet.</Empty>}
      </Section>
    </>
  );
}
