import Link from "next/link";
import { AdminHeader, Table, td, th } from "@/components/admin/ui";
import { Empty, fmtInt } from "@/components/seo/ui";
import { contentOverview } from "@/lib/seo-intel/content";

export const metadata = { title: "Content optimization" };

export default async function ContentPage() {
  const rows = await contentOverview();
  return (
    <>
      <AdminHeader title="Content optimization" description="Every published article, weakest audit first. The audit checks structure, headings, code examples, alt text, links, freshness, possibly outdated versions and intent match. Word count and keyword density are not scored (they are not ranking factors)." />
      {rows.length ? (
        <Table head={<tr><th className={th}>Article</th><th className={th}>Audit</th><th className={th}>Errors</th><th className={th}>Warnings</th><th className={th}>Clicks 28d</th><th className={th}>Open recs</th><th className={th}>Updated</th></tr>}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={`${td} [overflow-wrap:anywhere]`}><Link className="underline" href={`/admin/seo/articles/${r.id}`}>{r.title}</Link><span className="block text-xs text-fg-subtle">{r.path} · {r.category}</span></td>
              <td className={`${td} tabular-nums`}>{Math.round(r.score * 100)}</td>
              <td className={`${td} tabular-nums`}>{r.errors}</td>
              <td className={`${td} tabular-nums`}>{r.warnings}</td>
              <td className={`${td} tabular-nums`}>{fmtInt(r.clicks)}</td>
              <td className={`${td} tabular-nums`}>{r.pendingRecommendations}</td>
              <td className={`${td} whitespace-nowrap`}>{r.updatedAt?.slice(0, 10) ?? "—"}</td>
            </tr>
          ))}
        </Table>
      ) : <Empty>No published articles in the database yet.</Empty>}
    </>
  );
}
