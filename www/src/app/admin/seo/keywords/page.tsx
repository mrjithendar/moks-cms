import { AdminHeader, Table, td, th } from "@/components/admin/ui";
import { Empty, FilterBar, fmtInt, fmtPct, fmtPos, Pager, Section } from "@/components/seo/ui";
import { getCategories } from "@/lib/categories";
import { keywordOpportunities, parseFilters } from "@/lib/seo-intel/queries";

export const metadata = { title: "Keyword opportunities" };

export default async function KeywordsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const f = parseFilters({ sort: "impressions", ...sp });
  const [d, categories] = await Promise.all([keywordOpportunities(f), getCategories()]);
  const base = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
  return (
    <>
      <AdminHeader title="Keyword opportunities" description={`Search Console queries, ${d.period.start} – ${d.period.end}. ${d.coverageNote}`} />
      <FilterBar f={f} show={["range", "query", "page", "category", "device", "searchType"]} categories={categories} />
      <Section title={`${d.total} queries`}>
        {d.rows.length ? (
          <Table head={<tr><th className={th}>Query</th><th className={th}>Clicks</th><th className={th}>Impr.</th><th className={th}>CTR</th><th className={th}>Pos.</th><th className={th}>Pages</th><th className={th}>Signals</th></tr>}>
            {d.rows.map((r) => (
              <tr key={r.query}>
                <td className={`${td} [overflow-wrap:anywhere]`}>{r.query}<span className="block text-xs text-fg-subtle [overflow-wrap:anywhere]">{r.topPage}</span></td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.clicks)}</td>
                <td className={`${td} tabular-nums`}>{fmtInt(r.impressions)}</td>
                <td className={`${td} tabular-nums`}>{fmtPct(r.ctr)}</td>
                <td className={`${td} tabular-nums`}>{fmtPos(r.position)}</td>
                <td className={`${td} tabular-nums`}>{r.pages}</td>
                <td className={td}>{r.flags.join(", ") || "—"}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No query data yet.</Empty>}
        <Pager total={d.total} limit={f.limit} offset={f.offset} base={base} />
      </Section>
    </>
  );
}
