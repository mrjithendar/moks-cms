import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { MetricCell } from "@/components/seo/MetricCell";
import { Empty, fmtInt } from "@/components/seo/ui";
import { contentOverview } from "@/lib/seo-intel/content";
import type { Metric } from "@/lib/seo-intel/issue-details";

export const metadata = { title: "Content optimization" };

const COLS: [Metric, string][] = [["score", "Score"], ["errors", "Errors"], ["warnings", "Warnings"], ["notices", "Notices"], ["broken_links", "Broken links"], ["missing_alt", "Missing alt"], ["heading_issues", "Headings"]];

/**
 * Every number is interactive: hover (mouse), tap or keyboard focus opens its details — the located issues (up to 5,
 * then "View all"), why each matters, how to fix it, and "Fix with Claude" for fixable ones (creates or extends the
 * article's draft; never edits directly). The score opens its calculation.
 */
export default async function ContentPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const tab = (await searchParams).tab === "news" ? "news" : "articles";
  const all = await contentOverview();
  const rows = all.filter((r) => (tab === "news" ? r.collection === "news" : r.collection !== "news"));
  return (
    <>
      <AdminHeader title="Content optimization" description="Every published article, weakest audit first. Hover, tap or focus any number for the issues behind it. Word count and keyword density are not scored (they are not ranking factors)." />
      <nav aria-label="Content tabs" className="mb-4 flex gap-1 border-b border-line">
        {([["articles", "Articles"], ["news", "News"]] as const).map(([k, l]) => <Link key={k} href={`?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`-mb-px min-h-11 border-b-2 px-3 pt-3 text-sm font-medium ${tab === k ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>{l} <span className="tabular-nums text-fg-subtle">({all.filter((r) => (k === "news" ? r.collection === "news" : r.collection !== "news")).length})</span></Link>)}
      </nav>
      {!rows.length ? <Empty>No published {tab === "news" ? "news articles" : "articles"} in the database yet.</Empty> : (
        <>
          {/* Phones: cards */}
          <ul className="grid gap-3 md:hidden">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl border border-line bg-surface p-4">
                <Link className="font-semibold text-fg underline [overflow-wrap:anywhere]" href={`/admin/seo/articles/${r.id}`}>{r.title}</Link>
                <p className="text-xs text-fg-subtle">{r.path} · {fmtInt(r.clicks)} clicks (28 d)</p>
                <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
                  {COLS.map(([m, l]) => (
                    <div key={m} className="rounded-lg bg-surface-muted p-1.5">
                      <dt className="text-fg-subtle">{l}</dt>
                      <dd className="text-base font-semibold text-fg"><MetricCell articleId={r.id} metric={m} value={r.counts[m]} run={r.run} title={r.title} /></dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          {/* Desktop: dense table with a sticky header */}
          <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-surface-muted">
                <tr className="text-left text-xs text-fg-subtle">
                  <th className="px-4 py-2.5 font-semibold">Article</th>
                  {COLS.map(([m, l]) => <th key={m} className="px-2 py-2.5 text-right font-semibold">{l}</th>)}
                  <th className="px-3 py-2.5 text-right font-semibold">Clicks 28 d</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Open recs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-muted">
                    <td className="px-4 py-2 [overflow-wrap:anywhere]"><Link className="font-medium text-fg underline" href={`/admin/seo/articles/${r.id}`}>{r.title}</Link><span className="block text-xs text-fg-subtle">{r.path} · {r.category}</span></td>
                    {COLS.map(([m]) => <td key={m} className="px-2 py-2 text-right"><MetricCell articleId={r.id} metric={m} value={r.counts[m]} run={r.run} title={r.title} /></td>)}
                    <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.clicks)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.pendingRecommendations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
