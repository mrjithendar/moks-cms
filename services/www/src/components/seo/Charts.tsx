/**
 * Dependency-free charts for the search/analytics admin pages (server-rendered SVG/HTML, same approach as components/practice/Charts.tsx).
 * One series per chart, in the site accent: no dual axes (clicks and impressions are separate charts), no legend
 * needed (the heading names the series). Every mark has a hover tooltip (<title>) with a hit target larger than
 * the mark, and every chart has a table equivalent, so nothing depends on colour or hover alone.
 */

export type Point = { date: string; value: number | null };

const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v) : Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(v));

/** Line over time, 2 px stroke, recessive grid, vertical hover columns per day. `invert` for "lower is better" (position). */
export function TrendLine({ data, label, unit = "", invert = false, height = 160 }: { data: Point[]; label: string; unit?: string; invert?: boolean; height?: number }) {
  const pts = data.filter((d) => d.value !== null) as { date: string; value: number }[];
  if (pts.length < 2) return <p className="text-sm text-fg-subtle">Not enough data for a trend yet.</p>;
  const w = 640;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const vals = pts.map((p) => p.value);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (!invert) min = Math.min(0, min);
  if (max === min) max = min + 1;
  const x = (i: number) => pad.l + (i / (data.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => {
    const t = (v - min) / (max - min);
    return pad.t + (invert ? t : 1 - t) * (height - pad.t - pad.b);
  };
  let d = "";
  data.forEach((p, i) => {
    if (p.value === null) return;
    d += `${d && data[i - 1]?.value !== null ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
  });
  const ticks = [min, (min + max) / 2, max];
  const colW = (w - pad.l - pad.r) / Math.max(1, data.length - 1);
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${height}`} className="h-auto w-full" role="img" aria-label={`${label}: ${pts.length} days from ${data[0]!.date} to ${data.at(-1)!.date}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-fg-subtle)">
              {fmtNum(t)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={height - 4} fontSize={11} fill="var(--color-fg-subtle)">{data[0]!.date}</text>
        <text x={w - pad.r} y={height - 4} fontSize={11} textAnchor="end" fill="var(--color-fg-subtle)">{data.at(-1)!.date}</text>
        <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((p, i) => (
          <g key={p.date} className="group">
            {/* Hit target: the whole day column. */}
            <rect x={x(i) - colW / 2} y={pad.t} width={colW} height={height - pad.t - pad.b} fill="transparent">
              <title>{`${p.date}: ${p.value === null ? "no data" : `${fmtNum(p.value)}${unit}`}`}</title>
            </rect>
            {p.value !== null && <circle cx={x(i)} cy={y(p.value)} r={4} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} className="opacity-0 group-hover:opacity-100" pointerEvents="none" />}
          </g>
        ))}
      </svg>
      <details className="mt-1 text-xs text-fg-subtle">
        <summary className="cursor-pointer">Table: {label}</summary>
        <div className="max-h-48 overflow-y-auto">
          <table className="mt-1 w-full text-left tabular-nums">
            <thead>
              <tr><th className="pr-4 font-medium">Date</th><th className="font-medium">{label}</th></tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.date}><td className="pr-4">{p.date}</td><td>{p.value === null ? "—" : `${fmtNum(p.value)}${unit}`}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** Horizontal bars for a ranked breakdown (devices, countries, channels). Values are printed, so colour is not needed to read them. */
export function BarList({ items, label, format = fmtNum }: { items: { key: string; value: number; hint?: string }[]; label: string; format?: (v: number) => string }) {
  if (!items.length) return <p className="text-sm text-fg-subtle">No data for this period.</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2" aria-label={label}>
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm" title={`${i.key}: ${format(i.value)}${i.hint ? ` (${i.hint})` : ""}`}>
          <span className="truncate text-fg-muted">{i.key}</span>
          <span className="h-2.5 rounded-full bg-surface-sunken" aria-hidden="true">
            <span className="block h-2.5 rounded-full bg-accent" style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }} />
          </span>
          <span className="tabular-nums text-fg">{format(i.value)}</span>
        </li>
      ))}
    </ul>
  );
}
