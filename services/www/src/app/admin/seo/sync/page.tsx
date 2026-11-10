import { AdminHeader, Card, StatusPill, Table, td, th } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { SyncErrorCell } from "@/components/seo/SyncErrorCell";
import { Empty, fmtWhen, Pager, Section } from "@/components/seo/ui";
import { syncHistory } from "@/lib/seo-intel/queries";

export const metadata = { title: "Sync history" };

const tone = (s: string) => (s === "succeeded" ? "ok" : s === "partial" || s === "running" ? "degraded" : s === "skipped" ? "info" : "down");

export default async function SyncHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);
  const d = await syncHistory(50, offset, sp.jobType);
  return (
    <>
      <AdminHeader title="Sync history" description="Every scheduled, manual and backfill run: window, status, rows written, Google API requests, retries and errors. Queued runs start within about 30 seconds." />
      <Section title="Run now" description="Sync now re-fetches the trailing window (default 4 days, which also corrects provisional data). Backfill fetches up to 16 months in resumable slices; it never runs on a schedule.">
        <Card>
          <div className="flex flex-wrap gap-3">
            <ApiButton url="/api/admin/seo/sync" body={{ source: "both", mode: "sync" }} label="Sync GSC + GA4 now" variant="primary" />
            <ApiButton url="/api/admin/seo/sync" body={{ source: "gsc", mode: "backfill", months: 16 }} label="Backfill Search Console (16 months)" confirm="Queue a 16-month Search Console backfill? It uses API quota and runs in the background." />
            <ApiButton url="/api/admin/seo/sync" body={{ source: "ga4", mode: "backfill", months: 16 }} label="Backfill GA4 (16 months)" confirm="Queue a 16-month GA4 backfill? It uses GA4 token quota and runs in the background." />
          </div>
        </Card>
      </Section>
      <Section title={`${d.total} runs`}>
        {d.rows.length ? (
          <Table head={<tr><th className={th}>Started</th><th className={th}>Job</th><th className={th}>Trigger</th><th className={th}>Window</th><th className={th}>Status</th><th className={th}>Rows</th><th className={th}>Requests</th><th className={th}>Retries</th><th className={th}>Error</th></tr>}>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td className={`${td} whitespace-nowrap`}>{fmtWhen(r.startedAt)}</td>
                <td className={td}>{r.jobType}</td>
                <td className={td}>{r.trigger}{r.actor ? <span className="block text-xs text-fg-subtle">{r.actor}</span> : null}</td>
                <td className={`${td} whitespace-nowrap`}>{r.window ?? "—"}</td>
                <td className={td}><StatusPill status={tone(r.status)} /> <span className="text-xs">{r.status}</span></td>
                <td className={`${td} tabular-nums`}>{r.rows}</td>
                <td className={`${td} tabular-nums`}>{r.apiRequests}</td>
                <td className={`${td} tabular-nums`}>{r.retries}</td>
                <td className={`${td} text-xs`}>
                  <SyncErrorCell error={r.error} errorCode={r.errorCode} correlationId={r.correlationId} job={r.jobType} />
                  <span className="block text-fg-subtle">id {r.correlationId.slice(0, 8)}</span>
                </td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No runs yet.</Empty>}
        <Pager total={d.total} limit={50} offset={offset} base={new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][])} />
      </Section>
    </>
  );
}
