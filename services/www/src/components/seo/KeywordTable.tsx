"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { KwRow, View } from "@/lib/seo-intel/keywords";
import { Badge, PositionBadge } from "./badges";
import { ColumnPicker, DensityToggle, SortHeader, Sparkline, useRowNav, useTablePrefs, type Col } from "./table-kit";

export type KwViewRow = KwRow & { spark: number[] };

const fmtInt = (v: number) => Intl.NumberFormat("en").format(Math.round(v));
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

export const KW_COLS: Col[] = [
  { key: "query", label: "Query" },
  { key: "page", label: "Best page", hiddenByDefault: false },
  { key: "position", label: "Position", numeric: true },
  { key: "change", label: "Change", numeric: true, title: "Positions gained (+) or lost (−) vs the previous period" },
  { key: "impressions", label: "Impr.", numeric: true },
  { key: "clicks", label: "Clicks", numeric: true },
  { key: "ctr", label: "CTR", numeric: true },
  { key: "expected_ctr", label: "Exp. CTR", numeric: true, title: "Expected CTR for this position on your site's own CTR curve" },
  { key: "gap", label: "Click gap", numeric: true, title: "Estimate, based on your site's CTR curve: impressions × (expected − actual CTR)" },
  { key: "trend", label: "Trend", hiddenByDefault: false },
  { key: "intent", label: "Intent" },
  { key: "parent_topic", label: "Parent topic", hiddenByDefault: true },
];
const SORTABLE = new Set(["query", "position", "change", "impressions", "clicks", "ctr", "expected_ctr", "gap", "intent", "parent_topic"]);

async function act(body: Record<string, unknown>) {
  const res = await fetch("/api/admin/seo/keywords/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const data = (await res?.json().catch(() => ({}))) as { error?: string; calendarItemId?: string };
  return { ok: Boolean(res?.ok), data };
}

function Actions({ r, view, days, onDone }: { r: KwViewRow; view: View; days: number; onDone: (msg: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: string, label: string) => {
    setBusy(action);
    const evidence = `position ${r.position?.toFixed(1) ?? "—"}, ${fmtInt(r.impressions)} impressions, ${fmtInt(r.clicks)} clicks, CTR ${fmtPct(r.ctr)} vs ${fmtPct(r.expectedCtr)} expected on the site's curve (click gap ≈ ${fmtInt(Math.max(0, r.gap))}), last ${days} days (Search Console)`;
    const { ok, data } = await act({ action, query: r.query, articleId: r.articleId ?? undefined, kind: view, evidence });
    setBusy(null);
    onDone(ok ? label : (data.error ?? "That did not work."));
    if (ok) router.refresh();
  };
  const btn = "min-h-8 whitespace-nowrap rounded-md border border-line-strong bg-surface px-2 text-xs font-medium text-fg hover:bg-surface-muted disabled:opacity-50";
  return (
    <div className="flex flex-wrap gap-1">
      {r.articleId && <button type="button" className={btn} disabled={Boolean(busy)} onClick={() => run("draft_optimization", `Queued a draft optimization for “${r.query}”. It appears in the review queue.`)}>Draft optimization</button>}
      <button type="button" className={btn} disabled={Boolean(busy)} onClick={() => run("draft_new_article", `Added “${r.query}” to the editorial calendar.`)}>Draft new article</button>
      <button type="button" className={btn} disabled={Boolean(busy)} aria-pressed={r.tracked} onClick={() => run(r.tracked ? "untrack" : "track", r.tracked ? `Stopped tracking “${r.query}”.` : `Tracking “${r.query}”.`)}>{r.tracked ? "Tracked ✓" : "Track"}</button>
      <button type="button" className={btn} disabled={Boolean(busy)} onClick={() => run("ignore", `Ignored “${r.query}”.`)}>Ignore</button>
    </div>
  );
}

export function KeywordTable({ rows, view, days }: { rows: KwViewRow[]; view: View; days: number }) {
  const prefs = useTablePrefs("seo-kw", KW_COLS);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLTableSectionElement>(null);
  useRowNav(ref);
  const show = (k: string) => prefs.visible.has(k);
  const pad = prefs.dense ? "py-1" : "py-2.5";
  const cols = KW_COLS.filter((c) => show(c.key));
  const cell = (r: KwViewRow, key: string) => {
    switch (key) {
      case "query":
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            {r.articleId ? <Link data-primary href={`/admin/seo/articles/${r.articleId}`} className="font-medium text-fg hover:underline [overflow-wrap:anywhere]">{r.query}</Link> : <span data-primary className="font-medium text-fg [overflow-wrap:anywhere]">{r.query}</span>}
            {r.brand && <Badge>Brand</Badge>}
            {r.tracked && <Badge t="blue">Tracked</Badge>}
          </span>
        );
      case "page":
        return <span className="block max-w-[16rem] truncate text-xs text-fg-subtle" title={r.page ?? ""}>{r.page?.replace(/^https?:\/\/[^/]+/, "") ?? "—"}</span>;
      case "position":
        return <PositionBadge position={r.position} />;
      case "change":
        return r.change === null ? <span className="text-fg-subtle">new</span> : <span className={r.change > 0.05 ? "text-emerald-800 dark:text-emerald-300" : r.change < -0.05 ? "text-red-800 dark:text-red-300" : "text-fg-subtle"}><span aria-hidden="true">{r.change > 0.05 ? "▲" : r.change < -0.05 ? "▼" : "■"} </span>{r.change > 0 ? "+" : ""}{r.change.toFixed(1)}</span>;
      case "impressions":
        return fmtInt(r.impressions);
      case "clicks":
        return fmtInt(r.clicks);
      case "ctr":
        return fmtPct(r.ctr);
      case "expected_ctr":
        return r.position === null ? "—" : fmtPct(r.expectedCtr);
      case "gap":
        return r.position === null ? "—" : <span className={r.gap > 0 ? "font-medium text-fg" : "text-fg-subtle"}>{r.gap > 0 ? `+${fmtInt(r.gap)}` : fmtInt(r.gap)}</span>;
      case "trend":
        return <Sparkline values={r.spark} label={`Impressions per day, last ${days} days`} />;
      case "intent":
        return r.intent ? <Badge>{r.intent}</Badge> : <span className="text-fg-subtle">—</span>;
      case "parent_topic":
        return <span className="text-xs text-fg-muted">{r.parentTopic ?? "—"}</span>;
    }
    return null;
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <DensityToggle dense={prefs.dense} setDense={prefs.setDense} />
        <ColumnPicker cols={KW_COLS} visible={prefs.visible} toggle={prefs.toggle} />
      </div>
      {msg && <p role="status" className="mb-3 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-fg">{msg}</p>}
      {/* Phones: cards */}
      <ul className="grid gap-3 md:hidden">
        {rows.map((r) => (
          <li key={r.query} className="rounded-xl border border-line bg-surface p-4">
            {cell(r, "query")}
            <p className="mt-1 truncate text-xs text-fg-subtle">{r.page?.replace(/^https?:\/\/[^/]+/, "") ?? "—"}</p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-fg-subtle">Position</dt><dd className="mt-0.5">{cell(r, "position")} {cell(r, "change")}</dd></div>
              <div><dt className="text-fg-subtle">Impr. / clicks</dt><dd className="mt-0.5 tabular-nums text-fg">{fmtInt(r.impressions)} / {fmtInt(r.clicks)}</dd></div>
              <div><dt className="text-fg-subtle">Click gap (est.)</dt><dd className="mt-0.5 tabular-nums">{cell(r, "gap")}</dd></div>
            </dl>
            <div className="mt-2">{cell(r, "trend")}</div>
            <div className="mt-3"><Actions r={r} view={view} days={days} onDone={setMsg} /></div>
          </li>
        ))}
      </ul>
      {/* Desktop: sticky header, hover/focus row actions, keyboard navigation */}
      <div className="hidden max-h-[70vh] overflow-auto rounded-xl border border-line bg-surface md:block">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-muted shadow-[0_1px_0_var(--color-line)]">
            <tr>
              {cols.map((c) => (SORTABLE.has(c.key) ? <SortHeader key={c.key} col={c} /> : <th key={c.key} scope="col" className="px-3 py-2.5 text-left text-xs font-semibold text-fg-subtle">{c.label}</th>))}
              <th scope="col" className="px-3 py-2.5 text-left text-xs font-semibold text-fg-subtle"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody ref={ref} className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.query} data-row tabIndex={0} className="group outline-none hover:bg-surface-muted focus:bg-accent-soft/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
                {cols.map((c) => <td key={c.key} className={`px-3 ${pad} align-middle text-fg-muted ${c.numeric ? "text-right tabular-nums" : ""}`}>{cell(r, c.key)}</td>)}
                <td className={`px-3 ${pad}`}><div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"><Actions r={r} view={view} days={days} onDone={setMsg} /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-fg-subtle">Click gap and expected CTR are estimates, based on your site&apos;s own position→CTR curve. ↑/↓ move between rows, Enter opens the article.</p>
    </div>
  );
}
