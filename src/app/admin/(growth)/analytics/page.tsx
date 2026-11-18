import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { BarList, TrendLine } from "@/components/seo/Charts";
import { Empty, FilterBar, fmtInt, fmtPct, Section, SourceBanner } from "@/components/seo/ui";
import { getCategories } from "@/lib/categories";
import { filterOptions, parseFilters, visitorAnalytics } from "@/lib/seo-intel/queries";

export const metadata = { title: "Visitor analytics" };

export default async function VisitorAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const f = parseFilters(await searchParams);
  const [d, categories, opts] = await Promise.all([visitorAnalytics(f), getCategories(), filterOptions("ga4")]);
  const seconds = (v: number) => `${Math.round(v)} s`;
  return (
    <>
      <AdminHeader title="Visitor analytics" description={`Google Analytics 4, ${d.period.start} – ${d.period.end}. ${d.note}`} />
      <SourceBanner status={d.status} />
      <FilterBar f={f} show={["range", "page", "category", "device", "country"]} categories={categories} countries={opts.countries} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Sessions per day (all channels)"><Card><TrendLine label="Sessions" data={d.trend.map((t) => ({ date: t.date, value: t.sessions }))} /></Card></Section>
        <Section title="Organic search sessions per day"><Card><TrendLine label="Organic sessions" data={d.trend.map((t) => ({ date: t.date, value: t.organic }))} /></Card></Section>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Channels"><Card><BarList label="Sessions by channel" items={d.channels.map((x) => ({ key: x.key, value: x.sessions, hint: `engagement ${fmtPct(x.engagementRate)}` }))} /></Card></Section>
        <Section title="Devices"><Card><BarList label="Sessions by device" items={d.devices.map((x) => ({ key: x.key, value: x.sessions }))} /></Card></Section>
        <Section title="Countries"><Card><BarList label="Sessions by country" items={d.countries.map((x) => ({ key: x.key, value: x.sessions }))} /></Card></Section>
        <Section title="New vs returning"><Card><BarList label="Sessions by new vs returning" items={d.newVsReturning.map((x) => ({ key: x.key, value: x.sessions }))} /></Card></Section>
      </div>
      <Section title="Landing pages" description="Engagement rate = engaged sessions ÷ sessions; engagement time per session from userEngagementDuration.">
        {d.landing.length ? (
          <Table head={<tr><th className={th}>Landing page</th><th className={th}>Sessions</th><th className={th}>Organic</th><th className={th}>Engagement rate</th><th className={th}>Engagement / session</th><th className={th}>Views</th></tr>}>
            {d.landing.map((r) => (
              <tr key={r.page}>
                <td className={`${td} max-w-xs min-w-56 [overflow-wrap:anywhere]`}>{r.articleId ? <Link className="underline" href={`/admin/posts/${r.articleId}/insights`}>{r.title ?? r.page}</Link> : r.page}</td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.sessions)}</td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.organic)}</td>
                <td className={`${td} tabular-nums`}>{fmtPct(r.engagementRate)}</td>
                <td className={`${td} tabular-nums`}>{seconds(r.avgEngagementSeconds)}</td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.views)}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No GA4 landing-page data for this period.</Empty>}
      </Section>
    </>
  );
}
