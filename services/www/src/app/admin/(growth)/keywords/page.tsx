import { sql } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader, Card } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { Badge } from "@/components/seo/badges";
import { askGapClusters } from "@/lib/seo-agent/gaps";
import { KeywordTable } from "@/components/seo/KeywordTable";
import { FilterChips, SavedViews } from "@/components/seo/table-kit";
import { Empty, Pager, Section } from "@/components/seo/ui";
import { cannibalization, clusterSummary, contentGaps, INTENTS, keywordTable, parseKwParams, sparklines, VIEWS, type View } from "@/lib/seo-intel/keywords";

export const metadata = { title: "Keywords" };

const VIEW_LABEL: Record<View, [string, string]> = {
  all: ["All queries", "Every query with impressions in the period."],
  striking: ["Striking distance", "Positions 4–20, sorted by click gap: a modest improvement moves them onto page one or up it."],
  low_ctr: ["Low CTR", "Position ≤ 5 but CTR far below your site's curve: a title/meta job."],
  rising: ["Rising", "Impressions grew strongly against the previous period."],
  new: ["New", "Queries first seen in this period."],
  lost: ["Lost / declining", "Gone from results, or fell several positions."],
  cannibalization: ["Cannibalization", "One query, two or more of your pages getting impressions. Fix by consolidating, differentiating or linking — never by deleting."],
  gaps: ["Content gaps", "Query clusters with demand but no page that ranks well (best position > 15)."],
};
const CHIP: Record<string, (v: string) => string> = {
  posMin: (v) => `Position ≥ ${v}`, posMax: (v) => `Position ≤ ${v}`, imprMin: (v) => `Impressions ≥ ${v}`, intent: (v) => `Intent: ${v}`, cluster: (v) => `Cluster #${v}`,
  device: (v) => `Device: ${v}`, country: (v) => `Country: ${v.toUpperCase()}`, brand: (v) => (v === "brand" ? "Brand only" : v === "non_brand" ? "Non-brand" : "All"), q: (v) => `Contains “${v}”`, tracked: () => "Tracked only",
};

/** Chip text for the active filters, formatted here: FilterChips is a Client Component and can't receive functions. */
function chipLabels(sp: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(sp).flatMap(([k, v]) => (v && CHIP[k] ? [[k, CHIP[k](v)]] : [])));
}

export default async function KeywordsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const p = parseKwParams(sp);
  const db = await getDb();
  const [table, clusters, views] = await Promise.all([
    p.view === "cannibalization" || p.view === "gaps" ? null : keywordTable(p),
    clusterSummary(db),
    rowsOf<{ name: string; params: Record<string, string> }>(await db.execute(sql`select name, params from seo_saved_views where page = 'keywords' order by name`)),
  ]);
  const cannibal = p.view === "cannibalization" ? await cannibalization(p) : [];
  const gaps = p.view === "gaps" ? await contentGaps(p) : [];
  const asked = p.view === "gaps" ? await askGapClusters().catch(() => []) : [];
  const spark = table ? await sparklines(table.rows.map((r) => r.query), p.days === 90 ? 90 : 28) : new Map<string, number[]>();
  const base = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
  const link = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams(base);
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    q.delete("offset");
    return `?${q}`;
  };
  const input = "min-h-11 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg md:min-h-9";
  const siteBuckets = table?.curve ? table.curve.source.filter((x) => x === "site").length : 0;
  return (
    <>
      <AdminHeader
        title="Keyword opportunities"
        description="From your Search Console data only. There are no search-volume or difficulty columns because no licensed third-party source is configured; anonymised queries are not included, so totals are partial."
        actions={<Link href="/admin/keywords/tracked" className="inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 text-sm">Tracked keywords</Link>}
      />
      <nav aria-label="Opportunity views" className="-mx-1 mb-4 overflow-x-auto pb-1">
        <ul className="flex min-w-max gap-1 px-1">
          {VIEWS.map((v) => <li key={v}><Link href={link({ view: v, sort: undefined })} aria-current={p.view === v ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium md:min-h-9 ${p.view === v ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-surface-sunken hover:text-fg"}`}>{VIEW_LABEL[v][0]}</Link></li>)}
        </ul>
      </nav>
      <p className="mb-4 text-sm text-fg-muted">{VIEW_LABEL[p.view][1]}</p>

      <form method="get" aria-label="Filters" className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3">
        <input type="hidden" name="view" value={p.view} />
        <label className="grid gap-1 text-xs text-fg-subtle">Period<select name="days" defaultValue={String(p.days)} className={input}><option value="7">7 days</option><option value="28">28 days</option><option value="90">90 days</option></select></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Contains<input name="q" defaultValue={p.q ?? ""} className={`${input} w-40`} /></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Position<span className="flex gap-1"><input name="posMin" inputMode="decimal" defaultValue={p.posMin ?? ""} placeholder="min" className={`${input} w-16`} /><input name="posMax" inputMode="decimal" defaultValue={p.posMax ?? ""} placeholder="max" className={`${input} w-16`} /></span></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Impr. ≥<input name="imprMin" inputMode="numeric" defaultValue={p.imprMin ?? ""} className={`${input} w-20`} /></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Intent<select name="intent" defaultValue={p.intent ?? ""} className={input}><option value="">Any</option>{INTENTS.map((i) => <option key={i} value={i}>{i}</option>)}</select></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Cluster<select name="cluster" defaultValue={p.cluster ? String(p.cluster) : ""} className={`${input} max-w-48`}><option value="">Any</option>{clusters.slice(0, 100).map((c) => <option key={c.id} value={c.id}>{c.parent} ({c.n})</option>)}</select></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Device<select name="device" defaultValue={p.device ?? ""} className={input}><option value="">All</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option></select></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Country<input name="country" defaultValue={p.country ?? ""} placeholder="ind" maxLength={3} className={`${input} w-16`} /></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Brand<select name="brand" defaultValue={p.brand} className={input}><option value="all">All</option><option value="non_brand">Non-brand</option><option value="brand">Brand</option></select></label>
        <button className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-on-accent md:min-h-9">Apply</button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Suspense><SavedViews page="keywords" views={views} /></Suspense>
          <a href={`/api/admin/seo/keywords/export?${base}`} className="inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 text-sm">Export CSV</a>
        </div>
      </form>
      <Suspense><FilterChips labels={chipLabels(sp)} /></Suspense>

      {table && (
        <Section title={`${table.total.toLocaleString("en")} quer${table.total === 1 ? "y" : "ies"}`} description={table.period ? `${table.period.start} – ${table.period.end}, compared with ${table.period.prevStart} – ${table.period.prevEnd}. Expected CTR uses your site's curve for ${siteBuckets} of 30 positions (the rest use a conservative default).` : undefined}>
          {table.rows.length ? <Suspense><KeywordTable rows={table.rows.map((r) => ({ ...r, spark: spark.get(r.query) ?? [] }))} view={p.view} days={p.days} /></Suspense> : <Empty>{table.asOf ? "No queries match these filters." : "No Search Console data yet. Connect it under Integrations and run a sync."}</Empty>}
          <Pager total={table.total} limit={p.limit} offset={p.offset} base={base} />
        </Section>
      )}

      {p.view === "cannibalization" && (
        <Section title={`${cannibal.length} queries split across pages`}>
          {cannibal.length ? (
            <ul className="grid gap-3">
              {cannibal.map((c) => (
                <li key={c.query}>
                  <Card className="!p-4">
                    <div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-fg">{c.query}</p><Badge t={c.fix.action === "consolidate" ? "amber" : "blue"}>Suggested: {c.fix.action}</Badge><span className="text-xs text-fg-subtle">{c.total.toLocaleString("en")} impressions · top page changed on {Math.round(c.volatility * 100)}% of days</span></div>
                    <ul className="mt-2 space-y-1.5">
                      {c.pages.map((pg) => (
                        <li key={pg.page} className="text-sm">
                          <div className="flex justify-between gap-3"><span className="truncate text-fg-muted">{pg.page.replace(/^https?:\/\/[^/]+/, "")}</span><span className="shrink-0 tabular-nums text-fg">{Math.round(pg.share * 100)}% · pos {pg.position?.toFixed(1) ?? "—"}</span></div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken"><div className="h-full bg-accent" style={{ width: `${Math.round(pg.share * 100)}%` }} /></div>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-sm text-fg-muted">{c.fix.why}</p>
                  </Card>
                </li>
              ))}
            </ul>
          ) : <Empty>No query is split across several of your pages in this period.</Empty>}
        </Section>
      )}

      {p.view === "gaps" && (
        <Section title={`${gaps.length} content gaps`} description="Clusters are built from query wording (no embedding store); run the daily refresh after a sync to update them.">
          {gaps.length ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {gaps.map((g) => (
                <li key={g.clusterId}><Card className="!p-4">
                  <p className="text-xs text-fg-subtle">Parent topic</p>
                  <p className="font-semibold text-fg">{g.parentTopic}</p>
                  <p className="mt-1 text-sm tabular-nums text-fg-muted">{g.queries} queries · {g.impressions.toLocaleString("en")} impressions · best position {g.bestPosition?.toFixed(1) ?? "—"}</p>
                  <p className="mt-2 text-xs text-fg-subtle">{g.topQueries.join(" · ")}</p>
                  <Link className="mt-2 inline-block text-sm underline" href={link({ view: "all", cluster: String(g.clusterId) })}>See its queries</Link>
                </Card></li>
              ))}
            </ul>
          ) : <Empty>No content gaps: every cluster with demand has a page ranking in the top 15.</Empty>}
        </Section>
      )}

      {p.view === "gaps" && (
        <Section title={`${asked.length} asked on site`} description="Questions readers asked Ask the Blog that no article answered, clustered weekly. Source: Ask the Blog (not Search Console); counts are questions, not impressions.">
          {asked.length ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {asked.map((g) => (
                <li key={g.clusterId}><Card className="!p-4">
                  <div className="flex items-center justify-between gap-2">
                    <Badge t="violet" title="Source: Ask the Blog questions, not Search Console">Asked on site</Badge>
                    <span className="text-xs tabular-nums text-fg-subtle">asked {g.asked}× · last {g.lastSeen.slice(0, 10)}</span>
                  </div>
                  <p className="mt-2 font-semibold text-fg">{g.label}</p>
                  <ul className="mt-1 space-y-0.5 text-sm text-fg-muted">
                    {g.questions.slice(0, 3).map((q) => <li key={q.id}>“{q.question}”{q.asked > 1 ? ` (${q.asked}×)` : ""}</li>)}
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {g.status === "sent" ? (
                      <Link className="text-sm underline" href="/admin/calendar">On the editorial calendar</Link>
                    ) : (
                      <>
                        <ApiButton url={`/api/admin/seo/keywords/ask-gaps/${g.questions[0]!.id}`} body={{ action: "calendar" }} label="Send to editorial calendar" />
                        <ApiButton url={`/api/admin/seo/keywords/ask-gaps/${g.questions[0]!.id}`} body={{ action: "ignore" }} label="Ignore" variant="ghost" />
                      </>
                    )}
                  </div>
                </Card></li>
              ))}
            </ul>
          ) : <Empty>No unanswered reader questions{" "}(Ask the Blog is {process.env.ASK_BLOG_ENABLED === "true" ? "on" : "off"}).</Empty>}
        </Section>
      )}
    </>
  );
}
