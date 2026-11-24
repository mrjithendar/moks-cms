import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminHeader, Table, td, th } from "@/components/admin/ui";
import { ReportActions, ReportProgress, ReportStatus } from "@/components/crewai/reports/ReportClient";
import { duration, kb } from "@/components/crewai/reports/labels";
import { Empty, fmtWhen, Section } from "@/components/seo/ui";
import { listDeliveries } from "@/lib/reports/email";
import { REPORT_CSS, renderHtmlBody } from "@/lib/reports/render";
import { getReportData, getReportRow } from "@/lib/reports/service";

export const metadata = { title: "Report" };
export const dynamic = "force-dynamic";

/**
 * One report: status and progress while it runs, then the report itself (summary, findings, root causes, fixes,
 * recommendations, action plan, each category's figures, charts and tables, the sources), its downloads, email and
 * the email history. The report body is rendered by lib/reports/render.ts, which escapes every value it shows.
 */
export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const row = await getReportRow(id);
  if (!row) notFound();
  if (row.kind === "briefing") redirect(`/admin/reports/${id}`);
  const [data, deliveries] = await Promise.all([getReportData(id), listDeliveries(id, 50)]);
  const running = ["queued", "running"].includes(row.status);
  const facts = [`${row.start} – ${row.end}`, `made ${row.createdAt.slice(0, 16).replace("T", " ")} UTC by ${row.createdBy ?? "—"}`, row.durationMs !== null ? `took ${duration(row.durationMs)}` : null, row.llmCostUsd > 0 ? `LLM $${row.llmCostUsd.toFixed(row.llmCostUsd < 0.01 ? 4 : 2)} (${row.llmTokens.toLocaleString("en")} tokens)` : null, row.bytes ? `${Object.keys(row.files).length} file(s), ${kb(row.bytes)}` : null, row.expiresAt ? `kept until ${row.expiresAt.slice(0, 10)}` : null].filter(Boolean);
  return (
    <>
      <AdminHeader title={row.title} description={<span className="flex flex-wrap items-center gap-2"><ReportStatus status={row.status} /> {facts.join(" · ")}{row.runId && <> · <Link className="link" href={`/admin/crewai/runs/${row.runId}`}>report flow run</Link></>}</span>} />
      {sp.existing === "1" && <p role="status" className="mb-4 rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-fg-muted">The same report was already being generated: this is it.</p>}
      <ReportProgress id={id} initial={{ status: row.status, progress: row.progress, error: row.error }} />
      {row.error && <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">{row.error}</p>}
      {row.warnings.map((w) => <p key={w} className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">{w}</p>)}
      <div className="mb-6"><ReportActions id={id} status={row.status} files={Object.keys(row.files)} kind="console" canEmail /></div>
      {data ? (
        <article aria-label="Report" className="rounded-xl border border-line bg-surface p-4 sm:p-6">
          <style>{REPORT_CSS}</style>
          <div dangerouslySetInnerHTML={{ __html: renderHtmlBody(data) }} />
        </article>
      ) : running ? (
        <div className="grid gap-3" aria-label="Loading">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-sunken" />)}</div>
      ) : (
        <Empty>This report has no data{row.status === "failed" ? ": it failed before its data was built. Retry it." : "."}</Empty>
      )}
      <Section title="Email history" description="Each email of this report: who it went to, as an attachment or a link, and whether it was sent.">
        {deliveries.length ? (
          <Table head={<tr><th className={th}>Recipient</th><th className={th}>Status</th><th className={th}>How</th><th className={th}>Queued</th><th className={th}>Sent</th><th className={th}>By</th></tr>}>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td className={td}>{d.recipient}</td>
                <td className={td}><ReportStatus status={d.status} />{d.error && <span className="mt-1 block text-xs text-red-700 dark:text-red-300">{d.error}</span>}{d.attempts > 1 && <span className="block text-xs text-fg-subtle">{d.attempts} attempts</span>}</td>
                <td className={td}>{d.mode === "attachment" ? "PDF attached" : "Download link"}</td>
                <td className={td}>{fmtWhen(d.createdAt)}</td>
                <td className={td}>{d.sentAt ? fmtWhen(d.sentAt) : "—"}</td>
                <td className={td}>{d.createdBy ?? "—"}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty>Not emailed yet.</Empty>}
      </Section>
    </>
  );
}
