import Link from "next/link";
import { AdminHeader, Table, td, th } from "@/components/admin/ui";
import { Empty } from "@/components/seo/ui";
import { linkSuggestions } from "@/lib/seo-intel/content";

export const metadata = { title: "Internal linking" };

export default async function LinksPage() {
  const rows = await linkSuggestions();
  return (
    <>
      <AdminHeader title="Internal linking" description="Related published articles that are not linked yet, from shared Search Console queries, shared tags and category. Capped per article (Settings → max links per page); existing links are skipped. Add links in the editor where the topic comes up naturally." />
      {rows.length ? (
        <Table head={<tr><th className={th}>From</th><th className={th}>Link to</th><th className={th}>Why</th><th className={th}>Score</th></tr>}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={`${td} [overflow-wrap:anywhere]`}><Link className="underline" href={`/admin/seo/articles/${r.sourceId}`}>{r.sourceTitle}</Link></td>
              <td className={`${td} [overflow-wrap:anywhere]`}>{r.targetTitle}<span className="block text-xs text-fg-subtle">{r.targetPath}</span></td>
              <td className={td}>{r.reason}</td>
              <td className={`${td} tabular-nums`}>{r.score.toFixed(2)}</td>
            </tr>
          ))}
        </Table>
      ) : <Empty>No suggestions yet. They are produced by &ldquo;Generate now&rdquo; on Recommendations.</Empty>}
    </>
  );
}
