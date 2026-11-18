/**
 * Trend vs actual (v5 decay evidence): daily clicks as a light line, the STL trend (seasonality removed) as a solid
 * one. Pure SVG, server-rendered, theme colours via currentColor; a short text summary is the accessible name.
 */
export function TrendChart({ dates, actual, trend, width = 360, height = 96 }: { dates: string[]; actual: number[]; trend: number[]; width?: number; height?: number }) {
  const n = Math.min(dates.length, actual.length, trend.length);
  if (n < 2) return null;
  const max = Math.max(1, ...actual.slice(0, n), ...trend.slice(0, n));
  const x = (i: number) => (i / (n - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 14 - (v / max) * (height - 20);
  const path = (vs: number[]) => vs.slice(0, n).map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const first = trend[0]!;
  const last = trend[n - 1]!;
  const summary = `Click trend from ${dates[0]} to ${dates[n - 1]}: ${first.toFixed(1)} to ${last.toFixed(1)} clicks a day (seasonality removed).`;
  return (
    <figure className="mt-2">
      <svg role="img" aria-label={summary} viewBox={`0 0 ${width} ${height}`} className="h-auto w-full max-w-md text-accent">
        <path d={path(actual)} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={1} />
        <path d={path(trend)} fill="none" stroke="currentColor" strokeWidth={2} />
        <text x={2} y={height - 2} className="fill-current text-fg-subtle" fontSize={9}>{dates[0]}</text>
        <text x={width - 2} y={height - 2} textAnchor="end" className="fill-current text-fg-subtle" fontSize={9}>{dates[n - 1]}</text>
      </svg>
      <figcaption className="text-xs text-fg-subtle">Daily clicks (light) and trend with weekly seasonality removed (solid). {summary}</figcaption>
    </figure>
  );
}
