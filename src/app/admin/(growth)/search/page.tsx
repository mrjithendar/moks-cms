import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { BarList, TrendLine } from "@/components/seo/Charts";
import { Empty, FilterBar, fmtInt, fmtPct, fmtPos, Section, SourceBanner } from "@/components/seo/ui";
import { getCategories } from "@/lib/categories";
import { filterOptions, parseFilters, searchPerformance } from "@/lib/seo-intel/queries";

export const metadata = { title: "Search performance" };

type PageLike = { page: string; title: string | null; articleId: string | null; clicks: number; impressions: number; ctr: number; position: number | null; prevClicks: number | null; delta: number };

function PageTable({ rows, showDelta = false }: { rows: PageLike[]; showDelta?: boolean }) {
  if (!rows.length) return <Empty>No pages for this period and filter.</Empty>;
  return (
    <Table head={<tr><th className={th}>Page</th><th className={th}>Clicks</th>{showDelta && <th className={th}>Δ clicks</th>}<th className={th}>Impressions</th><th className={th}>CTR</th><th className={th}>Position</th></tr>}>
      {rows.map((r) => (
        <tr key={r.page}>
          <td className={`${td} max-w-xs min-w-56 [overflow-wrap:anywhere]`}>
            {r.articleId ? <Link className="underline" href={`/admin/posts/${r.articleId}/insights`}>{r.title ?? r.page}</Link> : r.page}
            {r.title && <span className="block text-xs text-fg-subtle">{new URL(r.page).pathname}</span>}
          </td>
          <td className={`${td} tabular-nums`}>{fmtInt(r.clicks)}</td>
          {showDelta && <td className={`${td} tabular-nums`}>{r.delta > 0 ? "+" : ""}{fmtInt(r.delta)}</td>}
          <td className={`${td} tabular-nums`}>{fmtInt(r.impressions)}</td>
          <td className={`${td} tabular-nums`}>{fmtPct(r.ctr)}</td>
          <td className={`${td} tabular-nums`}>{fmtPos(r.position)}</td>
        </tr>
      ))}
    </Table>
  );
}

function QueryTable({ rows }: { rows: { query: string; clicks: number; impressions: number; ctr: number; position: number | null }[] }) {
  if (!rows.length) return <Empty>No queries for this period and filter.</Empty>;
  return (
    <Table head={<tr><th className={th}>Query</th><th className={th}>Clicks</th><th className={th}>Impressions</th><th className={th}>CTR</th><th className={th}>Position</th></tr>}>
      {rows.map((r) => (
        <tr key={r.query}>
          <td className={`${td} min-w-56 [overflow-wrap:anywhere]`}>{r.query}</td>
          <td className={`${td} tabular-nums`}>{fmtInt(r.clicks)}</td>
          <td className={`${td} tabular-nums`}>{fmtInt(r.impressions)}</td>
          <td className={`${td} tabular-nums`}>{fmtPct(r.ctr)}</td>
          <td className={`${td} tabular-nums`}>{fmtPos(r.position)}</td>
        </tr>
      ))}
    </Table>
  );
}

export default async function SearchPerformancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const f = parseFilters(await searchParams);
  const [d, categories, opts] = await Promise.all([searchPerformance(f), getCategories(), filterOptions("gsc")]);
  return (
    <>
      <AdminHeader title="Search performance" description={`Google Search Console, ${f.searchType} search, ${d.period.start} – ${d.period.end} (compared with ${d.period.prevStart} – ${d.period.prevEnd}).`} />
      <SourceBanner status={d.status} />
      <FilterBar f={f} show={["range", "page", "query", "category", "device", "country", "searchType"]} categories={categories} countries={opts.countries} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Clicks per day"><Card><TrendLine label="Clicks" data={d.trend.map((t) => ({ date: t.date, value: t.clicks }))} /></Card></Section>
        <Section title="Average position per day"><Card><TrendLine label="Average position" invert data={d.trend.map((t) => ({ date: t.date, value: t.position }))} /></Card></Section>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Clicks by device"><Card><BarList label="Clicks by device" items={d.devices.map((x) => ({ key: x.key, value: x.clicks }))} /></Card></Section>
        <Section title="Clicks by country" description="ISO 3166 alpha-3 codes, as Search Console reports them."><Card><BarList label="Clicks by country" items={d.countries.map((x) => ({ key: x.key.toUpperCase(), value: x.clicks }))} /></Card></Section>
      </div>
      <Section title="Top pages"><PageTable rows={d.topPages} /></Section>
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Gaining pages"><PageTable rows={d.gaining} showDelta /></Section>
        <Section title="Losing pages"><PageTable rows={d.losing} showDelta /></Section>
      </div>
      <Section title="Top queries" description={d.coverageNote}><QueryTable rows={d.topQueries} /></Section>
      <Section title="High impressions, low CTR for their position" description="CTR well below the yardstick for the query's position band (brand queries excluded). Thresholds in Settings."><QueryTable rows={d.lowCtr} /></Section>
      <Section title="Positions 5–20 (striking distance)" description="Queries close to the first page or the top results, with meaningful impressions."><QueryTable rows={d.striking} /></Section>
    </>
  );
}
