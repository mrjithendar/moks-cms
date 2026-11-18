import Link from "next/link";
import { AdminHeader, StatusPill } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { RecommendationItem } from "@/components/seo/RecommendationItem";
import { TrendChart } from "@/components/seo/TrendChart";
import { Empty, Pager } from "@/components/seo/ui";
import { listRecommendations, recommendationStatusCounts } from "@/lib/seo-intel/recommendations";

export const metadata = { title: "Recommendations" };

const CATEGORIES = ["low_ctr", "striking_distance", "content_decay", "content_gap", "internal_links", "outdated_tech", "quality"];
const label = (c: string) => c.replace(/_/g, " ");
const fmtVal = (metric: string, v: number | null) => (v === null ? "—" : /ctr|change|overlap/.test(metric) && Math.abs(v) <= 1 ? `${(v * 100).toFixed(1)}%` : Number.isInteger(v) ? Intl.NumberFormat("en").format(v) : v.toFixed(2));

export default async function RecommendationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const [d, counts] = await Promise.all([listRecommendations(sp), recommendationStatusCounts()]);
  const base = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
  const filterLink = (k: string, v: string) => { const p = new URLSearchParams(base); if (v) p.set(k, v); else p.delete(k); p.delete("offset"); return `?${p}`; };
  const status = sp.status ?? "pending";
  return (
    <>
      <AdminHeader
        title="Recommendations"
        description="Rule-based, evidence-backed suggestions. Scores are priorities, not forecasts. Approving records your decision; nothing is changed on the site. AI explanations (when enabled) are labelled and must be verified."
        actions={<ApiButton url="/api/admin/seo/recommendations/generate" label="Generate now" variant="primary" />}
      />
      <nav aria-label="Filter recommendations" className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <span className="text-fg-subtle">Status:</span>
        {["pending", "approved", "rejected", "all"].map((s) => <Link key={s} href={filterLink("status", s)} aria-current={status === s ? "true" : undefined} className={status === s ? "font-semibold text-fg" : "underline"}>{s} <span className="tabular-nums text-fg-subtle">({counts[s as keyof typeof counts] ?? 0})</span></Link>)}
        <span className="text-fg-subtle">Category:</span>
        <Link href={filterLink("category", "")} className={!sp.category ? "font-semibold text-fg" : "underline"}>all</Link>
        {CATEGORIES.map((c) => <Link key={c} href={filterLink("category", c)} aria-current={sp.category === c ? "true" : undefined} className={sp.category === c ? "font-semibold text-fg" : "underline"}>{label(c)}</Link>)}
      </nav>
      {d.rows.length === 0 ? <Empty>No recommendations here. Run &ldquo;Generate now&rdquo; after Search Console has synced (content rules also work without Google data).</Empty> : (
        <ol className="space-y-4">
          {d.rows.map((r) => {
            const si = r.scoreInputs as { used?: string[]; missing?: string[]; renormalized?: boolean };
            return (
              <RecommendationItem key={r.id} id={r.id} filter={status} reviewStatus={r.reviewStatus as "pending" | "approved" | "rejected"} implementationStatus={r.implementationStatus as "not_started" | "in_progress" | "implemented" | "dismissed"}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <StatusPill status={r.priorityBand === "high" ? "critical" : r.priorityBand === "medium" ? "warning" : "info"} />
                    <span className="font-semibold text-fg">{r.priorityBand} priority · {(r.priorityScore * 100).toFixed(0)}/100</span>
                    <span className="text-fg-subtle">· {label(r.category)} · confidence {r.confidence} · analysed {r.analysisDate}</span>
                    <StatusPill status={r.reviewStatus} />
                  </div>
                  <h2 className="mt-2 font-semibold text-fg [overflow-wrap:anywhere]">
                    {r.articleId ? <Link className="underline" href={`/admin/posts/${r.articleId}/insights`}>{r.articleTitle}</Link> : r.url ? new URL(r.url).pathname : "Site-wide"}
                    {r.query && <span className="font-normal text-fg-muted"> · &ldquo;{r.query}&rdquo;</span>}
                  </h2>
                  <p className="mt-1 text-sm text-fg">{r.problem}</p>
                  {(() => {
                    const method = r.evidence.find((e) => e.metric === "decay_method")?.valueText;
                    const chart = r.evidence.find((e) => e.metric === "trend_vs_actual")?.detail as { dates?: string[]; actual?: number[]; trend?: number[] } | undefined;
                    return (
                      <>
                        {method && <p className="mt-1 text-xs text-fg-subtle">Decided by: <strong className="text-fg-muted">{method}</strong></p>}
                        {chart?.dates && chart.actual && chart.trend && <TrendChart dates={chart.dates} actual={chart.actual} trend={chart.trend} />}
                      </>
                    );
                  })()}
                  <p className="mt-2 text-sm"><strong>Proposed action:</strong> {r.proposedAction}</p>
                  <p className="mt-1 text-sm text-fg-muted"><strong>Expected impact (qualitative):</strong> {r.expectedImpact}</p>
                  {r.aiExplanation && (
                    <div className="mt-3 rounded-lg border border-line bg-surface-muted p-3 text-sm">
                      <p className="text-xs font-semibold text-fg-subtle">AI explanation (generated, verify before acting; prompt {r.aiPromptVersion})</p>
                      <p className="mt-1 whitespace-pre-line">{r.aiExplanation}</p>
                    </div>
                  )}
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-fg-muted">Evidence ({r.evidence.length}) and score inputs</summary>
                    <div className="overflow-x-auto"><table className="mt-2 w-full text-left text-xs tabular-nums">
                      <thead><tr className="text-fg-subtle"><th className="py-1 pr-3">Metric</th><th className="pr-3">Period</th><th className="pr-3">Value</th><th>Source</th></tr></thead>
                      <tbody>{r.evidence.map((e, i) => <tr key={i}><td className="py-0.5 pr-3">{e.metric}</td><td className="pr-3">{e.period}</td><td className="pr-3 [overflow-wrap:anywhere]">{e.valueText ?? fmtVal(e.metric, e.value)}</td><td>{e.source}</td></tr>)}</tbody>
                    </table></div>
                    <p className="mt-2 text-xs text-fg-subtle">Inputs used: {si.used?.join(", ") || "none"}{si.missing?.length ? `; missing (excluded, weights renormalised): ${si.missing.join(", ")}` : ""}.</p>
                  </details>
                  {r.baseline != null && <p className="mt-2 text-xs text-fg-subtle">Baseline (28 days before): {JSON.stringify(r.baseline)}{r.after28 != null ? ` · +28 days: ${JSON.stringify(r.after28)}` : ""}{r.after56 != null ? ` · +56 days: ${JSON.stringify(r.after56)}` : ""}</p>}
              </RecommendationItem>
            );
          })}
        </ol>
      )}
      <Pager total={d.total} limit={25} offset={Number(sp.offset) || 0} base={base} />
    </>
  );
}
