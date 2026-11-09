import { AdminHeader, Card } from "@/components/admin/ui";
import { TrendLine } from "@/components/seo/Charts";
import { FilterBar, KpiCard, Section, SourceBanner } from "@/components/seo/ui";
import { getCategories } from "@/lib/categories";
import { overview, parseFilters } from "@/lib/seo-intel/queries";

export const metadata = { title: "Overview" };

export default async function SeoOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const f = parseFilters(await searchParams);
  const [data, categories] = await Promise.all([overview(f), getCategories()]);
  return (
    <>
      <AdminHeader
        title="SEO intelligence"
        description="Search Console and GA4 data for jithendar.com, turned into evidence-backed recommendations. Nothing here edits or publishes content; every change goes through the editor."
      />
      <SourceBanner status={data.status.gsc} />
      <SourceBanner status={data.status.ga4} />
      <FilterBar f={f} show={["range", "page", "category", "device", "searchType"]} categories={categories} />
      <Section title="Key metrics" description="Change is against the previous period of equal length. Search Console clicks and GA4 sessions are different measurements and are never combined.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.kpis.map((k) => <KpiCard key={k.key} kpi={k} />)}
        </div>
      </Section>
      <Section title="Organic clicks per day" description={`Search Console site totals (${f.searchType}), ${data.gscPeriod.start} – ${data.gscPeriod.end}.`}>
        <Card><TrendLine label="Clicks" data={data.trend.map((t) => ({ date: t.date, value: t.clicks }))} /></Card>
      </Section>
      <Section title="Impressions per day">
        <Card><TrendLine label="Impressions" data={data.trend.map((t) => ({ date: t.date, value: t.impressions }))} /></Card>
      </Section>
    </>
  );
}
