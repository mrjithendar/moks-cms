"use client";

import { useState } from "react";

/**
 * Line/area charts that share one cursor: hovering (or arrowing through) any chart shows the same day's values in
 * every chart on the page. The previous period is drawn dashed when comparison is on; "article updated" annotations
 * (from the audit log) are vertical markers. Dependency-free SVG; each chart has a table equivalent.
 */
export type SeriesChart = { key: string; label: string; cur: (number | null)[]; prev?: (number | null)[]; format: "int" | "pct" | "pos"; invert?: boolean };

const fmt = (v: number | null, f: SeriesChart["format"]) => (v === null || !Number.isFinite(v) ? "—" : f === "pct" ? `${(v * 100).toFixed(1)}%` : f === "pos" ? v.toFixed(1) : Intl.NumberFormat("en", { notation: v >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(v));

function Chart({ c, dates, hover, setHover, notes, compare }: { c: SeriesChart; dates: string[]; hover: number | null; setHover: (i: number | null) => void; notes: Map<number, string>; compare: boolean }) {
  const W = 640;
  const H = 150;
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const vals = [...c.cur, ...(compare && c.prev ? c.prev : [])].filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return <p className="text-sm text-fg-subtle">Not enough data for {c.label.toLowerCase()} yet.</p>;
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (!c.invert) min = Math.min(0, min);
  if (max === min) max = min + 1;
  const n = dates.length;
  const x = (i: number) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => {
    const t = (v - min) / (max - min);
    return pad.t + (c.invert ? t : 1 - t) * (H - pad.t - pad.b);
  };
  const path = (s: (number | null)[]) => {
    let d = "";
    s.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      d += `${d && s[i - 1] !== null && s[i - 1] !== undefined ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  };
  const line = path(c.cur);
  const area = !c.invert && line ? `${line}L${x(n - 1).toFixed(1)},${y(min).toFixed(1)}L${x(0).toFixed(1)},${y(min).toFixed(1)}Z` : "";
  const ticks = [min, (min + max) / 2, max];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover(Math.min(n - 1, (hover ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover(Math.max(0, (hover ?? n) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };
  const h = hover !== null && hover < n ? hover : null;
  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold text-fg">{c.label}{c.invert ? <span className="ml-1 text-xs font-normal text-fg-subtle">(lower is better)</span> : null}</span>
        <span className="tabular-nums text-fg-muted" aria-live="polite">
          {h !== null ? <>{dates[h]}: <strong className="text-fg">{fmt(c.cur[h] ?? null, c.format)}</strong>{compare && c.prev ? <> · prev {fmt(c.prev[h] ?? null, c.format)}</> : null}{notes.get(h) ? <> · <span className="text-violet-800 dark:text-violet-300">{notes.get(h)}</span></> : null}</> : <span className="text-xs text-fg-subtle">Hover or focus and use ← →</span>}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-pan-y text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
        role="img"
        aria-label={`${c.label}, ${dates[0]} to ${dates[n - 1]}: from ${fmt(c.cur.find((v) => v !== null) ?? null, c.format)} to ${fmt([...c.cur].reverse().find((v) => v !== null) ?? null, c.format)}`}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1)))));
        }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="stroke-line" strokeWidth="1" />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="fill-fg-subtle text-[10px]">{fmt(t, c.format)}</text>
          </g>
        ))}
        <text x={pad.l} y={H - 6} className="fill-fg-subtle text-[10px]">{dates[0]}</text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" className="fill-fg-subtle text-[10px]">{dates[n - 1]}</text>
        {[...notes.keys()].map((i) => (
          <g key={`a${i}`}>
            <line x1={x(i)} x2={x(i)} y1={pad.t} y2={H - pad.b} className="stroke-violet-500/60" strokeWidth="1" strokeDasharray="2 3" />
            <circle cx={x(i)} cy={pad.t + 2} r="3" className="fill-violet-500" />
          </g>
        ))}
        {area && <path d={area} className="fill-current opacity-10" />}
        {compare && c.prev && <path d={path(c.prev)} fill="none" className="stroke-fg-subtle" strokeWidth="1.5" strokeDasharray="5 4" />}
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {h !== null && (
          <g>
            <line x1={x(h)} x2={x(h)} y1={pad.t} y2={H - pad.b} className="stroke-fg-subtle" strokeWidth="1" />
            {c.cur[h] !== null && c.cur[h] !== undefined && <circle cx={x(h)} cy={y(c.cur[h]!)} r="3.5" fill="currentColor" />}
          </g>
        )}
      </svg>
    </figure>
  );
}

export function SyncedCharts({ dates, charts, annotations, compare }: { dates: string[]; charts: SeriesChart[]; annotations: { date: string; label: string }[]; compare: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const notes = new Map(annotations.map((a) => [dates.indexOf(a.date), a.label]).filter(([i]) => (i as number) >= 0) as [number, string][]);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {charts.map((c) => (
        <div key={c.key} className="rounded-xl border border-line bg-surface p-4">
          <Chart c={c} dates={dates} hover={hover} setHover={setHover} notes={notes} compare={compare} />
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-fg-subtle">Data table</summary>
            <div className="mt-2 max-h-48 overflow-auto">
              <table className="w-full tabular-nums">
                <thead><tr className="text-left text-fg-subtle"><th className="font-medium">Date</th><th className="text-right font-medium">{c.label}</th>{compare && c.prev && <th className="text-right font-medium">Previous</th>}</tr></thead>
                <tbody>{dates.map((d, i) => <tr key={d}><td>{d}</td><td className="text-right">{fmt(c.cur[i] ?? null, c.format)}</td>{compare && c.prev && <td className="text-right">{fmt(c.prev[i] ?? null, c.format)}</td>}</tr>)}</tbody>
              </table>
            </div>
          </details>
        </div>
      ))}
      {notes.size > 0 && <p className="text-xs text-fg-subtle lg:col-span-2"><span aria-hidden="true" className="text-violet-600">●</span> markers: {annotations.map((a) => `${a.date} ${a.label}`).join(" · ")}</p>}
    </div>
  );
}
