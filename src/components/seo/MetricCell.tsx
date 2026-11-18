"use client";

import Link from "next/link";
import { useState } from "react";
import type { IssueDetail, Metric } from "@/lib/seo-intel/issue-details";
import { SeverityBadge } from "./badges";
import { Popover } from "./Popover";

type Details = { run: string; total: number; items: IssueDetail[]; score?: { formula: string; weights: { input: string; weight: number }[]; rows: { check: string; severity: string; message: string; points: number }[]; deducted: number; score: number } };

/** Per audit run (content hash) and metric: a re-audited article gets a new key, so stale details are never shown. */
const cache = new Map<string, Promise<Details>>();
function load(articleId: string, metric: Metric, run: string): Promise<Details> {
  const key = `${run}:${articleId}:${metric}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      fetch(`/api/admin/seo/content/${articleId}/details?metric=${metric}&run=${run}`).then(async (r) => {
        if (!r.ok) {
          cache.delete(key);
          throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Could not load details.");
        }
        return r.json() as Promise<Details>;
      }),
    );
  }
  return cache.get(key)!;
}

const LABEL: Record<Metric, string> = { errors: "errors", warnings: "warnings", notices: "notices", broken_links: "broken links", missing_alt: "images without alt text", heading_issues: "heading issues", score: "audit score" };

export function MetricCell({ articleId, metric, value, run, title }: { articleId: string; metric: Metric; value: number; run: string; title: string }) {
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  if (metric !== "score" && value === 0) return <span className="tabular-nums text-fg-subtle" aria-label={`0 ${LABEL[metric]}`}>0</span>;

  async function fix(items: IssueDetail[]) {
    const fixable = items.filter((i) => i.fixCategory);
    if (!fixable.length) return;
    setFixing(fixable[0]!.check);
    const res = await fetch("/api/admin/seo/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleId, extra: fixable.slice(0, 20).map((i) => ({ id: `issue:${i.check}:${i.line ?? 0}`, category: i.fixCategory, problem: `${i.message} (${i.location})`.slice(0, 500) })) }),
    }).catch(() => null);
    setFixing(null);
    setQueued(res?.ok ? "Queued: Claude is adding these fixes to this article's draft. Review them in the queue; nothing is published until you approve." : (((await res?.json().catch(() => ({}))) as { error?: string })?.error ?? "Could not queue the fix."));
  }

  return (
    <Popover
      label={`${metric === "score" ? `Audit score ${value}` : `${value} ${LABEL[metric]}`} for ${title}: details`}
      trigger={<span>{value}</span>}
      onOpen={() => {
        if (data || error) return;
        load(articleId, metric, run).then(setData, (e: Error) => setError(e.message));
      }}
    >
      {() => (
        <div>
          <p className="font-semibold text-fg">{metric === "score" ? `Audit score ${value}` : `${value} ${LABEL[metric]}`}</p>
          {error && <p role="alert" className="mt-1 text-red-700 dark:text-red-300">{error}</p>}
          {!data && !error && <p className="mt-1 text-fg-subtle">Loading…</p>}
          {data?.score && (
            <div className="mt-2">
              <p className="text-xs text-fg-muted">{data.score.formula}</p>
              <div className="overflow-x-auto"><table className="mt-2 w-full text-xs">
                <thead><tr className="text-left text-fg-subtle"><th className="font-medium">Input</th><th className="text-right font-medium">Weight</th></tr></thead>
                <tbody>{data.score.weights.map((w) => <tr key={w.input}><td>{w.input}</td><td className="text-right tabular-nums">−{w.weight}</td></tr>)}</tbody>
              </table></div>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {data.score.rows.map((r, i) => <li key={i} className="flex gap-2"><span className="w-8 shrink-0 text-right tabular-nums text-fg-subtle">−{r.points}</span><span className="text-fg-muted">{r.message}</span></li>)}
              </ul>
              <p className="mt-2 text-xs font-medium text-fg">100 − {data.score.deducted} = {data.score.score}</p>
            </div>
          )}
          {data && metric !== "score" && (
            <>
              <ul className="mt-2 space-y-3">
                {data.items.slice(0, 5).map((i, k) => (
                  <li key={k}>
                    <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={i.severity} /><span className="font-medium text-fg">{i.check.replace(/_/g, " ")}</span></div>
                    <p className="mt-1 text-xs text-fg-subtle">
                      {i.line ? <Link className="underline" href={`/admin/posts/${articleId}/insights?line=${i.line}#L${i.line}`}>{i.location}</Link> : i.location}
                    </p>
                    <p className="mt-1 text-xs text-fg-muted"><span className="font-medium text-fg">Why:</span> {i.why}</p>
                    <p className="text-xs text-fg-muted"><span className="font-medium text-fg">Fix:</span> {i.fix}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {data.total > 5 && <Link className="text-xs font-medium underline" href={`/admin/posts/${articleId}/insights#issues`}>View all {data.total}</Link>}
                {data.items.some((i) => i.fixCategory) && (
                  <button type="button" onClick={() => fix(data.items)} disabled={Boolean(fixing)} className="min-h-9 rounded-md bg-accent px-3 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">
                    {fixing ? "Queuing…" : "Fix with Claude"}
                  </button>
                )}
              </div>
              {queued && <p role="status" className="mt-2 text-xs text-fg-muted">{queued}</p>}
            </>
          )}
        </div>
      )}
    </Popover>
  );
}
