import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/admin/ui";
import { HealthScore } from "@/components/seo/HealthScore";
import { SyncedCharts } from "@/components/seo/SyncedCharts";
import { Sparkline } from "@/components/seo/table-kit";
import { Empty, fmtInt, fmtPct, fmtPos, fmtWhen, Section, SourceBanner } from "@/components/seo/ui";
import { overviewExtras } from "@/lib/seo-intel/overview-v2";
import { overview, parseFilters, type Kpi } from "@/lib/seo-intel/queries";

function Delta({ k }: { k: Kpi }) {
  if (k.change === null) return <span className="text-xs text-fg-subtle">{k.period === "current" ? "now" : "no comparison"}</span>;
  const good = k.lowerIsBetter ? k.change < 0 : k.change > 0;
  const flat = Math.abs(k.change) < 0.0005;
  return (
    <span className={`text-xs font-medium tabular-nums ${flat ? "text-fg-subtle" : good ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300"}`}>
      <span aria-hidden="true">{flat ? "■" : k.change > 0 ? "▲" : "▼"} </span>
      {k.change > 0 ? "+" : k.change < 0 ? "−" : ""}{(Math.abs(k.change) * 100).toFixed(1)}%
      <span className="sr-only"> {flat ? "unchanged" : k.change > 0 ? "increase" : "decrease"} vs previous period{flat ? "" : good ? " (better)" : " (worse)"}</span>
    </span>
  );
}

/** Search & traffic on the admin Dashboard (it used to be a separate "SEO overview" page). */
export async function SeoOverview({ sp, controls }: { sp: Record<string, string | undefined>; controls?: ReactNode }) {
  const f = parseFilters(sp);
  const compare = sp.compare === "1";
  const data = await overview(f);
  const x = await overviewExtras(f, data.gscPeriod, data.status.gsc);
  const pending = x.steps.filter((s) => !s.done);
  const setupNeeded = x.steps.slice(0, 3).some((s) => !s.done);
  const series: Record<string, { values: number[]; invert?: boolean }> = {
    clicks: { values: x.series.cur.map((d) => d.clicks) },
    impressions: { values: x.series.cur.map((d) => d.impressions) },
    ctr: { values: x.series.cur.map((d) => d.ctr ?? NaN) },
    position: { values: x.series.cur.map((d) => d.position ?? NaN), invert: true },
    organicSessions: { values: x.series.cur.map((d) => d.sessions ?? NaN) },
  };
  const fmt = (k: Kpi) => (k.format === "pct" ? fmtPct(k.value) : k.format === "pos" ? fmtPos(k.value) : fmtInt(k.value));
  const kpis = data.kpis.filter((k) => !["pending"].includes(k.key));
  return (
    <>
      <h2 className="mb-1 mt-10 text-xl font-semibold text-fg">Search &amp; traffic</h2>
      <p className="mb-4 text-sm text-fg-muted">Search Console and GA4 for jithendar.com, AI drafts waiting for you, and what needs attention.</p>
      {controls}
      <SourceBanner status={data.status.gsc} />
      <SourceBanner status={data.status.ga4} />

      {pending.length > 0 && (
        <details open={setupNeeded} className="mb-6 rounded-xl border border-line bg-surface p-4">
          <summary className="cursor-pointer font-semibold text-fg">{setupNeeded ? "Connect your data to get started" : `Setup: ${x.steps.length - pending.length} of ${x.steps.length} done`}</summary>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2">
            {x.steps.map((s, i) => (
              <li key={s.key} className="flex gap-3 rounded-lg border border-line p-3">
                <span aria-hidden="true" className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? "bg-emerald-600 text-white" : "bg-surface-sunken text-fg-muted"}`}>{s.done ? "✓" : i + 1}</span>
                <span className="min-w-0 text-sm"><Link href={s.href} className="font-medium text-fg underline">{s.label}</Link><span className="sr-only">{s.done ? " (done)" : " (to do)"}</span><span className="block text-xs text-fg-subtle">{s.hint}</span></span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="mb-8 grid gap-4 md:grid-cols-3">
        <HealthScore score={x.health.score} inputs={x.health.inputs} />
        <Card className="!p-5">
          <p className="text-sm text-fg-subtle">Review queue</p>
          <p className="mt-1 text-4xl font-semibold tabular-nums text-fg">{x.queue.ready}</p>
          <p className="mt-1 text-sm text-fg-muted">draft{x.queue.ready === 1 ? "" : "s"} ready for review{x.queue.scheduled ? ` · ${x.queue.scheduled} scheduled` : ""}{x.queue.failed ? ` · ${x.queue.failed} failed` : ""}</p>
          <Link href="/admin/review" className="mt-3 inline-flex min-h-9 items-center rounded-md bg-accent px-3 text-sm font-semibold text-on-accent hover:bg-accent-hover">Open the queue</Link>
        </Card>
        <Card className="!p-5">
          <p className="text-sm text-fg-subtle">Top movers (clicks)</p>
          {x.movers.up.length + x.movers.down.length ? (
            <ul className="mt-2 space-y-1.5 text-sm">
              {[...x.movers.up.slice(0, 3), ...x.movers.down.slice(0, 2)].map((m) => (
                <li key={m.page} className="flex items-center justify-between gap-2">
                  {m.articleId ? <Link href={`/admin/posts/${m.articleId}/insights`} className="min-w-0 truncate text-fg hover:underline">{m.title ?? m.page}</Link> : <span className="min-w-0 truncate text-fg">{m.title ?? m.page.replace(/^https?:\/\/[^/]+/, "")}</span>}
                  <span className={`shrink-0 tabular-nums text-xs font-medium ${m.delta > 0 ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300"}`}><span aria-hidden="true">{m.delta > 0 ? "▲" : "▼"}</span> {m.delta > 0 ? "+" : "−"}{fmtInt(Math.abs(m.delta))}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-fg-subtle">No page-level movement in this period yet.</p>}
        </Card>
      </div>

      <Section title="Key metrics" description={`${data.gscPeriod.start} – ${data.gscPeriod.end}, against the previous ${data.gscPeriod.days} days. Search Console clicks and GA4 sessions are different measurements and are never combined.`}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((k) => (
            <li key={k.key}>
              <Card className="!p-4">
                <p className="text-sm text-fg-subtle">{k.label}</p>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <p className="text-2xl font-semibold tabular-nums tracking-tight text-fg">{fmt(k)}</p>
                  {series[k.key] && <Sparkline values={series[k.key]!.values} invert={series[k.key]!.invert} label={`${k.label} per day`} />}
                </div>
                <p className="mt-1"><Delta k={k} /></p>
                <dl className="mt-2 space-y-0.5 text-xs text-fg-subtle">
                  <div><dt className="inline">Source: </dt><dd className="inline">{k.source}</dd></div>
                  <div><dt className="inline">Period: </dt><dd className="inline">{k.period}</dd></div>
                  {k.period !== "current" && <div><dt className="inline">Last sync: </dt><dd className="inline">{fmtWhen(k.lastSync)}</dd></div>}
                  {k.note && <div className="text-amber-800 dark:text-amber-300">{k.note}</div>}
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Trends" description={compare ? "Dashed: the previous period, aligned day by day." : "Turn on “Compare to previous” above for a dashed previous-period line."}>
        {x.series.cur.some((d) => d.impressions > 0) ? (
          <SyncedCharts
            compare={compare}
            dates={x.series.cur.map((d) => d.date)}
            annotations={x.annotations}
            charts={[
              { key: "clicks", label: "Organic clicks", cur: x.series.cur.map((d) => d.clicks), prev: x.series.prev.map((d) => d.clicks), format: "int" },
              { key: "impressions", label: "Impressions", cur: x.series.cur.map((d) => d.impressions), prev: x.series.prev.map((d) => d.impressions), format: "int" },
              { key: "ctr", label: "CTR", cur: x.series.cur.map((d) => d.ctr), prev: x.series.prev.map((d) => d.ctr), format: "pct" },
              { key: "position", label: "Average position", cur: x.series.cur.map((d) => d.position), prev: x.series.prev.map((d) => d.position), format: "pos", invert: true },
            ]}
          />
        ) : <Empty>No Search Console data in this period yet. Charts appear after the first sync.</Empty>}
      </Section>
    </>
  );
}
