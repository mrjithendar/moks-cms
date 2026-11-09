import Link from "next/link";
import { AdminHeader, Table, td, th } from "@/components/admin/ui";
import { Empty, FilterBar, fmtInt, fmtPct, fmtPos, Pager, Section } from "@/components/seo/ui";
import { getCategories } from "@/lib/categories";
import { pageIntelligence, parseFilters } from "@/lib/seo-intel/queries";

export const metadata = { title: "Page intelligence" };

const SORTS = [["clicks", "Clicks"], ["impressions", "Impressions"], ["ctr", "Lowest CTR"], ["position", "Best position"], ["sessions", "GA4 sessions"], ["change", "Biggest drop"]] as const;

export default async function PageIntelligencePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const f = parseFilters(sp);
  const [d, categories] = await Promise.all([pageIntelligence(f), getCategories()]);
  const base = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
  const sortLink = (s: string) => { const p = new URLSearchParams(base); p.set("sort", s); p.delete("offset"); return `?${p}`; };
  return (
    <>
      <AdminHeader title="Page intelligence" description={`Every page with Search Console data, joined with GA4 landing-page sessions and the CMS article. ${d.period.start} – ${d.period.end}.`} />
      <FilterBar f={f} show={["range", "page", "category", "device", "searchType"]} categories={categories} />
      <p className="mb-3 flex flex-wrap gap-2 text-sm text-fg-subtle">Sort: {SORTS.map(([k, l]) => <Link key={k} href={sortLink(k)} aria-current={f.sort === k ? "true" : undefined} className={f.sort === k ? "font-semibold text-fg" : "underline"}>{l}</Link>)}</p>
      <Section title={`${d.total} pages`}>
        {d.rows.length ? (
          <Table head={<tr><th className={th}>Page</th><th className={th}>Clicks</th><th className={th}>Change</th><th className={th}>Impr.</th><th className={th}>CTR</th><th className={th}>Pos.</th><th className={th}>GA4 sessions</th><th className={th}>Engagement</th><th className={th}>Open recs</th></tr>}>
            {d.rows.map((r) => (
              <tr key={r.page}>
                <td className={`${td} max-w-xs [overflow-wrap:anywhere]`}>
                  {r.articleId ? <Link className="underline" href={`/admin/seo/articles/${r.articleId}`}>{r.title}</Link> : r.page}
                  {r.category && <span className="block text-xs text-fg-subtle">{r.category}</span>}
                </td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.clicks)}</td>
                <td className={`${td} tabular-nums`}>{r.change === null ? "—" : `${r.change > 0 ? "+" : ""}${fmtPct(r.change, 0)}`}</td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.impressions)}</td>
                <td className={`${td} tabular-nums`}>{fmtPct(r.ctr)}</td>
                <td className={`${td} tabular-nums`}>{fmtPos(r.position)}</td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.sessions)}</td>
                <td className={`${td} tabular-nums`}>{fmtPct(r.engagementRate)}</td>
                <td className={`${td} tabular-nums`}>{r.openRecommendations}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No page data yet. Connect Search Console under Integrations and run a sync.</Empty>}
        <Pager total={d.total} limit={f.limit} offset={f.offset} base={base} />
      </Section>
    </>
  );
}
