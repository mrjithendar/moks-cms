/**
 * One colour scale per meaning, used everywhere on the search/analytics admin pages. Every badge carries its text (and a glyph where it
 * helps), so meaning never depends on colour alone. Contrast: 700/800 text on 50/100 fills (light), 200/300 text
 * on 10–15 % fills (dark) — WCAG AA for small text.
 */
const base = "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
const tone = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-200 dark:ring-emerald-400/25",
  blue: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-200 dark:ring-sky-400/25",
  amber: "bg-amber-50 text-amber-900 ring-amber-600/25 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/25",
  red: "bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-400/10 dark:text-red-200 dark:ring-red-400/25",
  violet: "bg-violet-50 text-violet-800 ring-violet-600/20 dark:bg-violet-400/10 dark:text-violet-200 dark:ring-violet-400/25",
  gray: "bg-surface-muted text-fg-muted ring-line-strong",
} as const;
export type Tone = keyof typeof tone;

export function Badge({ t = "gray", children, title }: { t?: Tone; children: React.ReactNode; title?: string }) {
  return <span className={`${base} ${tone[t]}`} title={title}>{children}</span>;
}

const STATUS: Record<string, [Tone, string]> = {
  generating: ["blue", "Generating"],
  ready_for_review: ["violet", "Ready for review"],
  generation_failed: ["red", "Generation failed"],
  scheduled: ["blue", "Scheduled"],
  publishing: ["blue", "Publishing"],
  published: ["green", "Published"],
  rejected: ["gray", "Rejected"],
  superseded: ["gray", "Superseded"],
  rolled_back: ["amber", "Rolled back"],
};
export function StatusBadge({ status }: { status: string }) {
  const [t, label] = STATUS[status] ?? ["gray", status.replace(/_/g, " ")];
  return <Badge t={t}>{label}</Badge>;
}

export function PriorityBadge({ band }: { band: string }) {
  const t: Tone = band === "high" ? "red" : band === "medium" ? "amber" : "gray";
  return <Badge t={t}><span aria-hidden="true">{band === "high" ? "▲" : band === "medium" ? "◆" : "▽"}</span>{band.charAt(0).toUpperCase() + band.slice(1)} priority</Badge>;
}

export function SeverityBadge({ severity }: { severity: "error" | "warning" | "notice" | "info" }) {
  const s = severity === "info" ? "notice" : severity;
  const t: Tone = s === "error" ? "red" : s === "warning" ? "amber" : "blue";
  return <Badge t={t}><span aria-hidden="true">{s === "error" ? "✕" : s === "warning" ? "!" : "i"}</span>{s.charAt(0).toUpperCase() + s.slice(1)}</Badge>;
}

/** Position buckets 1–3 / 4–10 / 11–20 / 21+. */
export function positionBucket(p: number | null): { label: string; t: Tone } {
  if (p === null) return { label: "—", t: "gray" };
  if (p <= 3.5) return { label: "1–3", t: "green" };
  if (p <= 10.5) return { label: "4–10", t: "blue" };
  if (p <= 20.5) return { label: "11–20", t: "amber" };
  return { label: "21+", t: "gray" };
}
export function PositionBadge({ position }: { position: number | null }) {
  const b = positionBucket(position);
  return <Badge t={b.t} title={`Position bucket ${b.label}`}><span className="tabular-nums">{position === null ? "—" : position.toFixed(1)}</span></Badge>;
}
