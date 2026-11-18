import { AdminHeader, Card, Stat, Table, td, th } from "@/components/admin/ui";
import { analytics } from "@/lib/news/service";

export const metadata = { title: "Analytics" };

type Rate = { name?: string; topic?: string; approved: number; rejected: number };

function RateTable({ rows, label }: { rows: Rate[]; label: string }) {
  if (!rows.length) return <Card><p className="text-sm text-fg-muted">No reviewed drafts yet.</p></Card>;
  return (
    <Table head={<tr><th className={th}>{label}</th><th className={th}>Approved</th><th className={th}>Rejected</th><th className={th}>Approval rate</th></tr>}>
      {rows.map((r) => {
        const n = Number(r.approved) + Number(r.rejected);
        const rate = n ? Number(r.approved) / n : 0;
        return (
          <tr key={String(r.name ?? r.topic)} className="border-t border-line">
            <td className={td}>{String(r.name ?? r.topic)}</td>
            <td className={`${td} tabular-nums`}>{r.approved}</td>
            <td className={`${td} tabular-nums`}>{r.rejected}</td>
            <td className={td}>
              <span className="inline-flex items-center gap-2 tabular-nums">
                <span className="h-2 w-24 overflow-hidden rounded bg-surface-muted" aria-hidden="true"><span className="block h-2 bg-emerald-500" style={{ width: `${Math.round(rate * 100)}%` }} /></span>
                {n ? `${Math.round(rate * 100)}%` : "—"}
              </span>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

/** Approval rates, edit-distance trend (falling = drafts match your style), time to review, performance, cost, models. */
export default async function NewsAnalyticsPage() {
  const a = await analytics(90);
  const trend = a.editTrend as { week: string; avg: number; n: number }[];
  const max = Math.max(0.01, ...trend.map((t) => Number(t.avg)));
  const review = a.review as { hours: number | null; n: number } | null;
  return (
    <>
      <AdminHeader title="News analytics" description="Last 90 days. These numbers come from your own review decisions and Search Console / GA4 data for published news." />
      <div className="mb-8 grid gap-4 sm:grid-cols-4">
        <Stat label="Approved articles" value={a.approved} />
        <Stat label="Cost per approved article" value={a.costPerApproved === null ? "—" : `$${a.costPerApproved.toFixed(3)}`} hint={`total spend $${a.spend.toFixed(2)} (LLM + images, incl. rejected and failed drafts)`} />
        <Stat label="Time to review" value={review?.hours ? `${review.hours.toFixed(1)} h` : "—"} hint={`${review?.n ?? 0} reviewed`} />
        <Stat label="Edit distance (latest week)" value={trend.length ? Number(trend[trend.length - 1]!.avg).toFixed(2) : "—"} hint="0 = published as drafted, 1 = rewritten" />
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="j" className="min-w-0"><h2 id="j" className="mb-3 text-sm font-semibold">By job</h2><RateTable rows={a.byJob as Rate[]} label="Job" /></section>
        <section aria-labelledby="t" className="min-w-0"><h2 id="t" className="mb-3 text-sm font-semibold">By topic</h2><RateTable rows={a.byTopic as Rate[]} label="Topic" /></section>
        <section aria-labelledby="s" className="min-w-0"><h2 id="s" className="mb-3 text-sm font-semibold">By source</h2><RateTable rows={a.bySource as Rate[]} label="Source" /></section>
        <section aria-labelledby="e" className="min-w-0">
          <h2 id="e" className="mb-3 text-sm font-semibold">Edit distance per week</h2>
          {trend.length === 0 ? (
            <Card><p className="text-sm text-fg-muted">No published news with recorded edits yet.</p></Card>
          ) : (
            <figure>
              <svg role="img" aria-labelledby="et" viewBox={`0 0 ${trend.length * 40} 120`} className="h-32 w-full">
                <title id="et">Average edit distance per week</title>
                {trend.map((t, i) => {
                  const h = (Number(t.avg) / max) * 100;
                  return <rect key={t.week} x={i * 40 + 8} y={110 - h} width={24} height={h} className="fill-sky-500" />;
                })}
              </svg>
              <figcaption className="sr-only">{trend.map((t) => `${t.week}: ${Number(t.avg).toFixed(2)} (${t.n})`).join("; ")}</figcaption>
              <div className="overflow-x-auto"><table className="mt-2 w-full text-xs"><tbody>{trend.map((t) => <tr key={t.week}><td>{t.week}</td><td className="tabular-nums">{Number(t.avg).toFixed(3)}</td><td className="text-fg-subtle">{t.n} articles</td></tr>)}</tbody></table></div>
            </figure>
          )}
        </section>
        <section aria-labelledby="p" className="min-w-0">
          <h2 id="p" className="mb-3 text-sm font-semibold">Performance of published news</h2>
          {(a.perf as unknown[]).length === 0 ? (
            <Card><p className="text-sm text-fg-muted">Collected 7 and 28 days after publishing (needs Search Console / GA4 sync).</p></Card>
          ) : (
            <Table head={<tr><th className={th}>Window</th><th className={th}>Avg clicks</th><th className={th}>Avg engagement</th><th className={th}>Articles</th></tr>}>
              {(a.perf as { window: string; clicks: number; engagement: number | null; n: number }[]).map((p) => <tr key={p.window} className="border-t border-line"><td className={td}>{p.window}</td><td className={`${td} tabular-nums`}>{Number(p.clicks).toFixed(1)}</td><td className={`${td} tabular-nums`}>{p.engagement === null ? "—" : `${(Number(p.engagement) * 100).toFixed(0)}%`}</td><td className={`${td} tabular-nums`}>{p.n}</td></tr>)}
            </Table>
          )}
        </section>
        <section aria-labelledby="m" className="min-w-0">
          <h2 id="m" className="mb-3 text-sm font-semibold">Models</h2>
          {(a.models as unknown[]).length === 0 ? (
            <Card><p className="text-sm text-fg-muted">No models trained yet. The ranker trains once there are enough labelled decisions (Settings).</p></Card>
          ) : (
            <Table head={<tr><th className={th}>Kind</th><th className={th}>Version</th><th className={th}>Metrics</th><th className={th}>Samples</th></tr>}>
              {(a.models as { kind: string; version: string; active: boolean; metrics: Record<string, unknown>; n_samples: number; notes: string | null }[]).map((m) => (
                <tr key={`${m.kind}:${m.version}`} className="border-t border-line">
                  <td className={td}>{m.kind}{m.active ? " · active" : ""}</td>
                  <td className={td}><code className="text-xs">{m.version}</code></td>
                  <td className={`${td} text-xs`}>{m.kind === "ranker" ? `v2 AUC ${(m.metrics.v2 as { auc?: number })?.auc ?? "—"} vs v1 ${(m.metrics.v1 as { auc?: number })?.auc ?? "—"}; NDCG@5 ${(m.metrics.v2 as { ndcg5?: number })?.ndcg5 ?? "—"}` : `macro F1 ${String(m.metrics.macro_f1 ?? "—")}`}{m.notes ? ` · ${m.notes}` : ""}</td>
                  <td className={`${td} tabular-nums`}>{m.n_samples}</td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
