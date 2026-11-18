import { notFound } from "next/navigation";
import { AdminHeader, Table, td, th } from "@/components/admin/ui";
import { PrintButton } from "@/components/seo/PrintButton";
import { Empty, fmtInt, fmtPct, fmtPos, Section } from "@/components/seo/ui";
import { UUID } from "@/lib/seo-intel/http";
import { getReport } from "@/lib/seo-intel/reports";

export const metadata = { title: "Report" };

const chg = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = await getReport(id);
  if (!r) notFound();
  const g = r.organic.gsc;
  const a = r.organic.ga4;
  // v4 report_flow adds a checked narrative and an R2 PDF to the payload.
  const extra = r as typeof r & { narrative?: string; pdf?: { key: string } };
  return (
    <article className="seo-report">
      {/* Printing: hide the admin chrome and SEO tabs. */}
      <style>{`@media print { [data-admin-shell] > aside, header, footer { display: none !important; } [data-admin-shell] { display: block !important; background: white; } }`}</style>
      <AdminHeader title={`SEO ${r.type} report: ${r.period.start} – ${r.period.end}`} description={`Compared with ${r.period.prevStart} – ${r.period.prevEnd}. Generated ${r.generatedAt.slice(0, 16).replace("T", " ")} UTC. Sources: ${r.sources.gsc}; ${r.sources.ga4}.`} actions={<>{extra.pdf?.key ? <a className="min-h-9 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent print:hidden" href={`/api/admin/seo/reports/${id}/pdf`}>Download PDF</a> : null}<a className="min-h-9 rounded-md border border-line-strong px-3 py-2 text-sm print:hidden" href={`/api/admin/seo/reports/${id}/csv`}>CSV</a><PrintButton /></>} />
      {extra.narrative ? (
        <section aria-label="Summary" className="mb-6 rounded-xl border border-line border-l-4 border-l-accent bg-surface p-4 text-sm leading-relaxed">
          <p className="mb-1 font-semibold">Summary</p>
          <p className="whitespace-pre-line text-fg-muted">{extra.narrative}</p>
          <p className="mt-2 text-xs text-fg-subtle">Written by the report crew from the figures below; every number in it was checked against them.</p>
        </section>
      ) : null}
      {!r.organic.dataComplete && <p className="mb-4 text-sm text-amber-800 dark:text-amber-300">Search Console data for this period is incomplete ({g.current.daysWithData} days with data).</p>}
      <Section title="Organic performance">
        <Table head={<tr><th className={th}>Metric</th><th className={th}>This period</th><th className={th}>Previous</th><th className={th}>Change</th></tr>}>
          <tr><td className={td}>Clicks (GSC)</td><td className={td}>{fmtInt(g.current.clicks)}</td><td className={td}>{fmtInt(g.previous.clicks)}</td><td className={td}>{chg(g.change.clicks)}</td></tr>
          <tr><td className={td}>Impressions (GSC)</td><td className={td}>{fmtInt(g.current.impressions)}</td><td className={td}>{fmtInt(g.previous.impressions)}</td><td className={td}>{chg(g.change.impressions)}</td></tr>
          <tr><td className={td}>CTR (GSC)</td><td className={td}>{fmtPct(g.current.ctr)}</td><td className={td}>{fmtPct(g.previous.ctr)}</td><td className={td}>{chg(g.change.ctr)}</td></tr>
          <tr><td className={td}>Avg position (GSC; lower is better)</td><td className={td}>{fmtPos(g.current.position)}</td><td className={td}>{fmtPos(g.previous.position)}</td><td className={td}>{chg(g.change.position)}</td></tr>
          <tr><td className={td}>Organic sessions (GA4)</td><td className={td}>{fmtInt(a.current.organicSessions)}</td><td className={td}>{fmtInt(a.previous.organicSessions)}</td><td className={td}>{chg(a.change.organicSessions)}</td></tr>
        </Table>
      </Section>
      {([["Best articles", r.bestArticles], ["Growing", r.growing], ["Declining", r.declining]] as const).map(([title, rows]) => (
        <Section key={title} title={title}>
          {rows.length ? <Table head={<tr><th className={th}>Page</th><th className={th}>Clicks</th><th className={th}>Previous</th><th className={th}>Δ</th></tr>}>{rows.map((x) => <tr key={x.page}><td className={`${td} min-w-48 [overflow-wrap:anywhere]`}>{x.title ?? x.page}</td><td className={td}>{fmtInt(x.clicks)}</td><td className={td}>{fmtInt(x.previous)}</td><td className={td}>{x.delta > 0 ? "+" : ""}{fmtInt(x.delta)}</td></tr>)}</Table> : <Empty>None.</Empty>}
        </Section>
      ))}
      {([["New opportunities", r.newOpportunities], ["Decay alerts", r.decayAlerts], ["Next actions", r.nextActions]] as const).map(([title, rows]) => (
        <Section key={title} title={title}>
          {rows.length ? <ul className="space-y-2 text-sm">{rows.map((o) => <li key={o.id}><strong>{o.category.replace(/_/g, " ")}</strong> ({o.band}): {o.problem} <span className="block text-fg-muted">→ {o.action}</span></li>)}</ul> : <Empty>None.</Empty>}
        </Section>
      ))}
      <Section title="Technical issues (latest scan)">
        {r.technical ? <ul className="text-sm">{r.technical.top.map((t) => <li key={`${t.check}-${t.severity}`}>{t.check.replace(/_/g, " ")} ({t.severity}): {t.count}</li>)}{!r.technical.top.length && <li>No errors or warnings.</li>}</ul> : <Empty>No technical scan yet.</Empty>}
      </Section>
      <Section title="Recommendations and completed optimisations">
        <p className="text-sm">{r.recommendations.pending} pending · {r.recommendations.approved} approved · {r.recommendations.rejected} rejected · {r.recommendations.implementedInPeriod} implemented this period · {r.recommendations.proposalsAcceptedInPeriod} proposals accepted into drafts this period.</p>
        {r.completedOptimizations.length > 0 && (
          <Table head={<tr><th className={th}>Change</th><th className={th}>Implemented</th><th className={th}>Baseline clicks (28 d before)</th><th className={th}>Days 1–28 after</th><th className={th}>Days 29–56 after</th></tr>}>
            {r.completedOptimizations.map((o) => {
              const b = o.baseline as { clicks?: number } | null;
              const x = o.after28 as { clicks?: number } | null;
              const y = o.after56 as { clicks?: number } | null;
              return <tr key={o.id}><td className={`${td} min-w-48 [overflow-wrap:anywhere]`}>{o.category.replace(/_/g, " ")}: {o.url}</td><td className={td}>{o.implementedAt?.slice(0, 10)}</td><td className={td}>{fmtInt(b?.clicks ?? null)}</td><td className={td}>{x ? fmtInt(x.clicks ?? null) : "pending"}</td><td className={td}>{y ? fmtInt(y.clicks ?? null) : "pending"}</td></tr>;
            })}
          </Table>
        )}
        <p className="mt-2 text-xs text-fg-subtle">Before/after comparisons are observational: algorithm updates, seasonality and other changes affect the same windows.</p>
      </Section>
    </article>
  );
}
