import Link from "next/link";
<<<<<<< HEAD
import { getDb } from "@/db";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Badge } from "@/components/seo/badges";
import { LinkDecision } from "@/components/seo/LinkDecision";
import { Empty, Section } from "@/components/seo/ui";
import { linkSuggestions } from "@/lib/seo-intel/content";
import { linkReport } from "@/lib/seo-intel/internal-links";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Internal linking" };

export default async function LinksPage({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const sort = (await searchParams).sort ?? "inbound";
  const s = await getSeoSettings();
  const [r, v1] = await Promise.all([linkReport(await getDb(), s), linkSuggestions()]);
  const rows = [...r.rows].sort((a, b) => (sort === "outbound" ? b.outbound - a.outbound : sort === "words" ? b.words - a.words : a.inbound - b.inbound));
  const L = s.links;
  return (
    <>
      <AdminHeader
        title="Internal linking"
        description={`Links are proposed automatically into drafts and reviewed like any other change. Limits: ≤ ${L.maxNewPerDraft} new links per draft, total ≤ 1 per ${L.wordsPerLink} words, ≥ ${L.minWordsBetween} words apart, ≤ ${L.maxInboundPerTargetPerRun} new inbound per target per week, relevance ≥ ${L.minRelevance}. Never in headings, code, captions, the first sentence or existing links. Tune them in Settings (docs/seo/INTERNAL_LINKING.md).`}
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        {[["Published articles", r.rows.length], ["Orphans (no inbound)", r.orphans.length], ["Over the density cap", r.overLinked.length], ["Pending link changes", r.pending.filter((p) => p.change.decision === "pending").length]].map(([label, n]) => (
          <Card key={String(label)} className="!p-4"><p className="text-sm text-fg-subtle">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums text-fg">{n}</p></Card>
        ))}
      </div>

      <Section title="Pending link suggestions" description="From open drafts. Accepting here is the same as accepting in the draft's review page; the article is published only when you approve its draft.">
        {r.pending.length ? (
          <ul className="grid gap-3">
            {r.pending.map((p) => (
              <li key={`${p.draft_id}-${p.change.id}`} className="rounded-xl border border-line bg-surface p-4">
                <p className="text-sm text-fg"><Link className="font-semibold underline" href={`/admin/seo/review/${p.draft_id}`}>{p.title}</Link> → <code className="text-xs">{p.change.target}</code></p>
                <p className="mt-1 text-sm text-fg-muted">Anchor: “<span className="font-medium text-fg">{p.change.before}</span>”{p.change.location.headingPath ? ` in “${p.change.location.headingPath}”` : ""}</p>
                <p className="mt-1 text-xs text-fg-subtle">{p.change.rationale}</p>
                <div className="mt-2"><LinkDecision draftId={p.draft_id} changeId={p.change.id} decision={p.change.decision} /></div>
              </li>
            ))}
          </ul>
        ) : <Empty>No pending link changes. They are added to drafts by the weekly run.</Empty>}
      </Section>

      <Section title={`Orphans (${r.orphans.length})`} description="No other published article links to these. They get priority as link targets, within the limits above.">
        {r.orphans.length ? <ul className="flex flex-wrap gap-2">{r.orphans.map((o) => <li key={o.path}><Link href={`/admin/seo/articles/${o.id}`} className="inline-flex min-h-9 items-center rounded-full border border-line px-3 text-sm hover:bg-surface-muted">{o.title}</Link></li>)}</ul> : <Empty>No orphans.</Empty>}
      </Section>

      {r.overLinked.length > 0 && (
        <Section title={`Over-linked (${r.overLinked.length})`} description={`More internal links than 1 per ${L.wordsPerLink} words. No new links are proposed for these.`}>
          <ul className="flex flex-wrap gap-2">{r.overLinked.map((o) => <li key={o.path}><Badge t="amber">{o.title} · {o.outbound}/{o.cap}</Badge></li>)}</ul>
        </Section>
      )}

      <Section title="Link graph" description="Inbound = published articles linking here; outbound = internal links in the body; cap = 1 per configured words.">
        <nav aria-label="Sort" className="mb-2 flex gap-3 text-sm">{[["inbound", "Fewest inbound"], ["outbound", "Most outbound"], ["words", "Longest"]].map(([k, l]) => <Link key={k} href={`?sort=${k}`} aria-current={sort === k ? "true" : undefined} className={sort === k ? "font-semibold text-fg underline" : "text-fg-muted hover:underline"}>{l}</Link>)}</nav>
        {rows.length ? (
          <Table head={<tr><th className={th}>Article</th><th className={th}>Inbound</th><th className={th}>Outbound</th><th className={th}>Words</th><th className={th}>Cap</th></tr>}>
            {rows.map((row) => (
              <tr key={row.path}>
                <td className={`${td} [overflow-wrap:anywhere]`}><Link className="underline" href={`/admin/seo/articles/${row.id}`}>{row.title}</Link><span className="block text-xs text-fg-subtle">{row.path}</span></td>
                <td className={`${td} tabular-nums`}>{row.inbound === 0 ? <Badge t="amber">0 · orphan</Badge> : row.inbound}</td>
                <td className={`${td} tabular-nums`}>{row.overLinked ? <Badge t="red">{row.outbound} · over cap</Badge> : row.outbound}</td>
                <td className={`${td} tabular-nums`}>{row.words.toLocaleString("en")}</td>
                <td className={`${td} tabular-nums`}>{row.cap}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No published articles in the database yet.</Empty>}
      </Section>

      {v1.length > 0 && (
        <details className="mb-8 text-sm"><summary className="cursor-pointer text-fg-muted">Related-article candidates from the recommendation rules ({v1.length})</summary>
          <ul className="mt-2 space-y-1 text-fg-muted">{v1.slice(0, 50).map((x) => <li key={x.id}>{x.sourceTitle} → {x.targetTitle} ({x.reason}, {x.score.toFixed(2)})</li>)}</ul>
        </details>
      )}
=======
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
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
    </>
  );
}
