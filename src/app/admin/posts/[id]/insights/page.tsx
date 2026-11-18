import { LocalTime } from "@/components/LocalTime";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader, Card, StatusPill, Table, td, th } from "@/components/admin/ui";
import { buttonClass } from "@/components/ui/form";
import { ApiButton } from "@/components/seo/ApiButton";
import { TrendLine } from "@/components/seo/Charts";
import { SideBySide } from "@/components/seo/Diff";
import { Empty, fmtInt, fmtPct, fmtPos, Section } from "@/components/seo/ui";
import { getDb } from "@/db";
import { articlePanel } from "@/lib/seo-intel/article-panel";
import { openDraft } from "@/lib/seo-intel/drafts";
import { UUID } from "@/lib/seo-intel/http";
import { listSubmissions, timelineSummary } from "@/lib/seo-intel/submission";
import { issuesFor } from "@/lib/seo-intel/issue-details";
import { SeverityBadge } from "@/components/seo/badges";
import { requireRole } from "@/lib/session";

export const metadata = { title: "Post insights" };

export default async function ArticleSeoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ line?: string }> }) {
  await requireRole("admin");
  const { id } = await params;
  const focusLine = Number((await searchParams)?.line) || null;
  if (!UUID.test(id)) notFound();
  const p = await articlePanel(id);
  if (!p) notFound();
  const db = await getDb();
  const [submissions, draft] = await Promise.all([listSubmissions(db, { articleId: id }), openDraft(db, id)]);
  const tl = timelineSummary(submissions);
  const a = p.article;
  const proposals = p.optimizations.filter((o) => o.status === "proposed");
  const decided = p.optimizations.filter((o) => o.status !== "proposed");
  return (
    <>
      <AdminHeader
        title={a.title}
        description={<>SEO panel for <code>{a.path}</code> ({a.status}). Proposals never change the article: accepting one puts it into your editor working copy, and you save or publish from the editor as usual.</>}
        actions={<><Link href={`/admin/posts/${a.id}`} className={buttonClass("secondary", "sm")}>Open in editor</Link><ApiButton url={`/api/admin/seo/articles/${a.id}/optimize`} label="Generate proposals" variant="secondary" />{a.status === "published" && <ApiButton url="/api/admin/seo/drafts" body={{ articleId: a.id }} label="Draft with Claude" variant="primary" />}</>}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="!p-4"><p className="text-sm text-fg-subtle">Clicks (GSC, 28 d)</p><p className="mt-1 text-2xl font-semibold tabular-nums">{fmtInt(p.gsc?.clicks ?? null)}</p><p className="text-xs text-fg-subtle">{p.period.start} – {p.period.end}</p></Card>
        <Card className="!p-4"><p className="text-sm text-fg-subtle">Impressions · position (GSC)</p><p className="mt-1 text-2xl font-semibold tabular-nums">{fmtInt(p.gsc?.impressions ?? null)} · {fmtPos(p.gsc?.position ?? null)}</p></Card>
        <Card className="!p-4"><p className="text-sm text-fg-subtle">Sessions (GA4, landing)</p><p className="mt-1 text-2xl font-semibold tabular-nums">{fmtInt(p.ga4.sessions)}</p><p className="text-xs text-fg-subtle">{fmtInt(p.ga4.organic)} from organic search</p></Card>
        <Card className="!p-4"><p className="text-sm text-fg-subtle">Engagement (GA4)</p><p className="mt-1 text-2xl font-semibold tabular-nums">{fmtPct(p.ga4.engagementRate)}</p><p className="text-xs text-fg-subtle">{p.ga4.avgEngagementSeconds === null ? "—" : `${Math.round(p.ga4.avgEngagementSeconds)} s per session`}</p></Card>
      </div>
      <Section title="Search engines" description="Submitting is a crawl hint, not an indexing guarantee. Google's state comes from the URL Inspection API (its last-known state, not live).">
        <Card>
          <ol className="grid gap-3 text-sm sm:grid-cols-3" aria-label="Submission timeline">
            <li><p className="text-xs text-fg-subtle">1 · Submitted</p><p className="font-medium text-fg"><LocalTime iso={tl.submittedAt} fallback="not yet" /></p></li>
            <li><p className="text-xs text-fg-subtle">2 · Crawled (Google)</p><p className="font-medium text-fg">{tl.crawledAt ? <LocalTime iso={tl.crawledAt} /> : tl.pendingInspection ? "check scheduled" : "unknown"}</p></li>
            <li><p className="text-xs text-fg-subtle">3 · Index status (Google&apos;s last-known state)</p><p className="font-medium text-fg">{tl.indexState ?? (tl.pendingInspection ? "check scheduled" : "unknown")}</p></li>
          </ol>
          {submissions.length > 0 && (
            <details className="mt-3 text-sm"><summary className="cursor-pointer text-fg-muted">All {submissions.length} submission events</summary>
              <ul className="mt-2 space-y-1 text-fg-muted">{submissions.map((s, i) => <li key={i}><LocalTime iso={s.requestedAt} /> · <span className="font-medium text-fg">{s.engine}</span> {s.kind} · {s.status}{s.responseCode ? ` (HTTP ${s.responseCode})` : ""}{s.error ? ` — ${s.error}` : ""}</li>)}</ul>
            </details>
          )}
          {draft && <p className="mt-3 text-sm"><Link className="underline" href={`/admin/review/${draft.id}`}>Open draft ({draft.status.replace(/_/g, " ")}, {draft.changes.length} changes)</Link></p>}
        </Card>
      </Section>
      <Section title="Clicks per day (90 days)"><Card><TrendLine label="Clicks" data={p.gscTrend.map((t) => ({ date: t.date, value: t.clicks }))} /></Card></Section>

      <Section title={`Proposals (${proposals.length})`} description="Each shows the current value next to the proposal. Accept → your working copy; Reject → dismissed. AI proposals are labelled and must be checked for accuracy.">
        {proposals.length ? (
          <ol className="space-y-4">
            {proposals.map((o) => (
              <li key={o.id}>
                <Card>
                  <p className="text-sm font-semibold text-fg">{o.field === "seoTitle" ? "Search title" : o.field === "seoDescription" ? "Meta description" : "Body"} <span className="font-normal text-fg-subtle">· {o.source === "llm" ? `AI-generated (${o.promptVersion})` : "rule-based"}</span></p>
                  <p className="mt-1 text-sm text-fg-muted">{o.rationale}</p>
                  <div className="mt-3"><SideBySide current={o.current} proposed={o.proposed} field={o.field} /></div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ApiButton url={`/api/admin/seo/optimizations/${o.id}`} method="PATCH" body={{ action: "accept" }} label="Accept into my draft" variant="primary" />
                    <ApiButton url={`/api/admin/seo/optimizations/${o.id}`} method="PATCH" body={{ action: "reject" }} label="Reject" />
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        ) : <Empty>No open proposals. &ldquo;Generate proposals&rdquo; creates them from the audit, recommendations and (if enabled) the LLM.</Empty>}
      </Section>
      {decided.length > 0 && (
        <Section title="Decided proposals">
          <Table head={<tr><th className={th}>Field</th><th className={th}>Proposed</th><th className={th}>Status</th><th className={th}>By</th><th className={th}></th></tr>}>
            {decided.map((o) => (
              <tr key={o.id}>
                <td className={td}>{o.field}</td>
                <td className={`${td} max-w-md min-w-48 [overflow-wrap:anywhere]`}>{o.field === "body" ? "(body change)" : o.proposed}</td>
                <td className={td}><StatusPill status={o.status === "accepted" ? "approved" : o.status === "rejected" ? "rejected" : "draft"} /> <span className="text-xs">{o.status.replace("_", " ")}</span></td>
                <td className={`${td} text-xs`}>{o.decidedBy}<span className="block">{o.decidedAt?.slice(0, 16).replace("T", " ")}</span></td>
                <td className={td}>{o.status === "accepted" && <ApiButton url={`/api/admin/seo/optimizations/${o.id}`} method="PATCH" body={{ action: "rollback" }} label="Roll back" confirm="Restore your previous working copy for this field? Saved revisions are not changed." />}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Current metadata">
          <Card>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-fg-subtle">Search title</dt><dd className="[overflow-wrap:anywhere]">{a.seoTitle || <em>{a.title} (title)</em>}</dd>
              <dt className="text-fg-subtle">Meta description</dt><dd className="[overflow-wrap:anywhere]">{a.seoDescription || <em>{a.description} (description)</em>}</dd>
              <dt className="text-fg-subtle">Category · tags</dt><dd>{a.category} · {a.tags.join(", ") || "—"}</dd>
              <dt className="text-fg-subtle">Published · updated</dt><dd>{a.publishedAt?.slice(0, 10) ?? "—"} · {a.updatedAt?.slice(0, 10) ?? "—"}</dd>
              <dt className="text-fg-subtle">Indexing</dt><dd>{a.noindex ? "noindex" : "indexable"}{a.canonicalUrl ? ` · canonical ${a.canonicalUrl}` : ""}</dd>
            </dl>
          </Card>
        </Section>
        <Section title="Structured data inputs (BlogPosting)" description="What the site's JSON-LD is built from.">
          <Card><ul className="space-y-1 text-sm">{p.structuredData.map((c) => <li key={c.check}><span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> <span className={c.ok ? "" : "font-semibold text-red-700 dark:text-red-300"}>{c.check}</span><span className="sr-only">{c.ok ? " passes" : " fails"}</span></li>)}</ul></Card>
        </Section>
      </div>

      <Section title={`Audit findings (score ${Math.round(p.audit.score * 100)})`} description="Structure, accessibility, links, freshness, possibly outdated versions, intent. Word count and keyword density are not scored.">
        {p.audit.findings.length ? (
          <ul className="space-y-2">{p.audit.findings.map((f, i) => (
            <li key={i} className="flex gap-2 text-sm"><StatusPill status={f.severity === "error" ? "critical" : f.severity === "warning" ? "warning" : "info"} /><span>{f.message}{f.source && <> (<a className="underline" href={f.source} rel="noreferrer noopener" target="_blank">source</a>)</>}{Array.isArray(f.detail?.links) && <span className="block text-xs text-fg-subtle">{(f.detail!.links as string[]).join(", ")}</span>}{Array.isArray(f.detail?.images) && <span className="block text-xs text-fg-subtle">{(f.detail!.images as string[]).join(", ")}</span>}</span></li>
          ))}</ul>
        ) : <Empty>No findings.</Empty>}
      </Section>
      <Section id="issues" title="All located issues" description="Each issue with where it is. Line links jump to the body below and highlight the line.">
        {(() => {
          const issues = issuesFor("errors", p.audit, a.body).concat(issuesFor("warnings", p.audit, a.body), issuesFor("notices", p.audit, a.body));
          return issues.length ? (
            <ul className="space-y-2 text-sm">{issues.map((i, k) => <li key={k} className="flex flex-wrap items-start gap-2"><SeverityBadge severity={i.severity} /><span className="min-w-0 flex-1"><span className="font-medium text-fg">{i.check.replace(/_/g, " ")}</span> — {i.line ? <a className="underline" href={`?line=${i.line}#L${i.line}`}>{i.location}</a> : i.location}<span className="block text-xs text-fg-subtle">{i.fix}</span></span></li>)}</ul>
          ) : <Empty>No issues.</Empty>;
        })()}
      </Section>
      <Section id="body" title="Body (line numbers)" description="Read-only. The highlighted line is the one the issue refers to; edit it in the editor or with a draft.">
        <details open={Boolean(focusLine)} className="rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-2 text-sm text-fg-muted">Show {a.body.split("\n").length} lines</summary>
          <ol className="max-h-[32rem] overflow-auto border-t border-line py-2 font-mono text-xs leading-5">
            {a.body.split("\n").map((l, i) => (
              <li key={i} id={`L${i + 1}`} className={`scroll-mt-24 whitespace-pre-wrap px-4 [overflow-wrap:anywhere] target:bg-amber-100 dark:target:bg-amber-500/20 ${focusLine === i + 1 ? "bg-amber-100 ring-2 ring-amber-400 dark:bg-amber-500/20" : ""}`}><span aria-hidden="true" className="mr-3 inline-block w-8 select-none text-right text-fg-subtle">{i + 1}</span>{l || " "}</li>
            ))}
          </ol>
        </details>
      </Section>
      <Section title="Heading outline">
        {p.audit.headings.length ? <ol className="space-y-0.5 text-sm">{p.audit.headings.map((h, i) => <li key={i} style={{ paddingLeft: `${(h.level - 1) * 1}rem` }}><span className="text-fg-subtle">H{h.level}</span> {h.text}</li>)}</ol> : <Empty>No headings.</Empty>}
      </Section>
      <Section title="Ranking queries (GSC, 28 d)" description="Partial coverage: anonymised queries are not included.">
        {p.queries.length ? (
          <Table head={<tr><th className={th}>Query</th><th className={th}>Clicks</th><th className={th}>Impr.</th><th className={th}>CTR</th><th className={th}>Pos.</th></tr>}>
            {p.queries.map((q) => <tr key={q.query}><td className={`${td} min-w-48 [overflow-wrap:anywhere]`}>{q.query}</td><td className={`${td} tabular-nums`}>{fmtInt(q.clicks)}</td><td className={`${td} tabular-nums`}>{fmtInt(q.impressions)}</td><td className={`${td} tabular-nums`}>{fmtPct(q.ctr)}</td><td className={`${td} tabular-nums`}>{fmtPos(q.position)}</td></tr>)}
          </Table>
        ) : <Empty>No query data for this URL yet.</Empty>}
      </Section>
      <Section title="Internal link suggestions">
        {p.links.length ? <ul className="space-y-1 text-sm">{p.links.map((l) => <li key={l.id}><strong>{l.title}</strong> <code className="text-xs">{l.path}</code> <span className="text-fg-subtle">— {l.reason}</span></li>)}</ul> : <Empty>None.</Empty>}
      </Section>
      <Section title="Recommendations for this article">
        {p.recommendations.length ? <ul className="space-y-2 text-sm">{p.recommendations.map((r) => <li key={r.id}><StatusPill status={r.reviewStatus} /> <strong>{r.category.replace(/_/g, " ")}</strong> ({r.priorityBand}): {r.problem}{r.aiExplanation && <span className="mt-1 block text-xs text-fg-subtle">AI explanation (verify): {r.aiExplanation}</span>}</li>)}</ul> : <Empty>None. See Recommendations → Generate now.</Empty>}
      </Section>
    </>
  );
}
