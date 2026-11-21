import { sql } from "drizzle-orm";
import Link from "next/link";
import { AdminHeader, Card, Stat, Table, td, th } from "@/components/admin/ui";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { filterFrom } from "@/lib/news/analytics-filter";
import { analytics, ANALYTICS_PERIODS, listJobs, listSources, listTopics } from "@/lib/news/service";

export const metadata = { title: "Content analytics" };

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

const sel = "min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-fg";

/**
 * AI & SEO → Content analytics: what every crew job drafted (news stories and blog articles) and how it did, filtered
 * as you need (period, job, what it writes, category, topic, source; all in the address, so a view can be bookmarked):
 * approval rates, edit-distance trend (falling = drafts match your style), time to review, performance, cost, models.
 */
export default async function ContentAnalyticsPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> } = {}) {
  const f = filterFrom((await searchParams) ?? {});
  const db = await getDb();
  const [a, jobs, topics, sources, categories] = await Promise.all([
    analytics(f),
    listJobs(),
    listTopics(),
    listSources(),
    db.execute(sql`select slug, label from category order by sort, slug`).then((r) => rowsOf<{ slug: string; label: string }>(r)),
  ]);
  const filtered = Boolean(f.jobId || f.output || f.category || f.topic || f.sourceId) || f.days !== 90;
  const ideas = a.ideas as { name: string; sent: number; published: number }[];
  const trend = a.editTrend as { week: string; avg: number; n: number }[];
  const max = Math.max(0.01, ...trend.map((t) => Number(t.avg)));
  const review = a.review as { hours: number | null; n: number } | null;
  return (
    <>
      <AdminHeader title="Content analytics" description={`What crew jobs drafted in the last ${f.days} days and how it did: your own review decisions, and Search Console / GA4 data once it is published.`} />
      <form method="get" className="mb-8 flex flex-wrap items-end gap-3" aria-label="Filters">
        <label className="grid gap-1 text-xs text-fg-subtle">Period
          <select name="days" defaultValue={String(f.days)} className={sel}>{ANALYTICS_PERIODS.map((d) => <option key={d} value={d}>{d === 365 ? "Last year" : `Last ${d} days`}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs text-fg-subtle">Job
          <select name="job" defaultValue={f.jobId ?? ""} className={sel}><option value="">All jobs</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs text-fg-subtle">Writes
          <select name="output" defaultValue={f.output ?? ""} className={sel}><option value="">News and articles</option><option value="news">News stories</option><option value="article">Blog articles</option></select>
        </label>
        <label className="grid gap-1 text-xs text-fg-subtle">Category
          <select name="category" defaultValue={f.category ?? ""} className={sel}><option value="">All categories</option>{categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs text-fg-subtle">Topic
          <select name="topic" defaultValue={f.topic ?? ""} className={sel}><option value="">All topics</option>{topics.map((t) => <option key={String(t.slug)} value={String(t.slug)}>{String(t.label)}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs text-fg-subtle">Source
          <select name="source" defaultValue={f.sourceId ?? ""} className={sel}><option value="">All sources</option>{sources.map((x) => <option key={String(x.id)} value={String(x.id)}>{String(x.name)}</option>)}</select>
        </label>
        <button type="submit" className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-white">Apply</button>
        {filtered && <Link href="/admin/content/analytics" className="inline-flex min-h-11 items-center text-sm text-fg-muted underline">Clear filters</Link>}
      </form>
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
        <section aria-labelledby="c" className="min-w-0"><h2 id="c" className="mb-3 text-sm font-semibold">By category</h2><RateTable rows={a.byCategory as Rate[]} label="Category" /></section>
        <section aria-labelledby="i" className="min-w-0">
          <h2 id="i" className="mb-3 text-sm font-semibold">From content ideas (Editorial crew)</h2>
          {ideas.length === 0 ? (
            <Card><p className="text-sm text-fg-muted">No content ideas sent by a job in this period. Jobs that start from content ideas send them to the editorial calendar.</p></Card>
          ) : (
            <Table head={<tr><th className={th}>Job</th><th className={th}>Ideas sent</th><th className={th}>Published</th></tr>}>
              {ideas.map((r) => <tr key={r.name} className="border-t border-line"><td className={td}>{r.name}</td><td className={`${td} tabular-nums`}>{r.sent}</td><td className={`${td} tabular-nums`}>{r.published}</td></tr>)}
            </Table>
          )}
        </section>
        <section aria-labelledby="e" className="min-w-0">
          <h2 id="e" className="mb-3 text-sm font-semibold">Edit distance per week</h2>
          {trend.length === 0 ? (
            <Card><p className="text-sm text-fg-muted">No reviewed drafts with recorded edits{filtered ? " for these filters" : ""} yet.</p></Card>
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
          <h2 id="p" className="mb-3 text-sm font-semibold">Performance once published</h2>
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
