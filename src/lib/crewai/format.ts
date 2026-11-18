/** Formatting for the CrewAI console (pure, client-safe). */

/** 860 → "0.9s", 12_300 → "12s", 252_000 → "4m 12s", 3_780_000 → "1h 3m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A run's duration: finished − started, or until `now` while it is still going. */
export function runDurationMs(startedAt: string | Date | null | undefined, finishedAt: string | Date | null | undefined, now: number = Date.now()): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function formatUsd(usd: number | null | undefined): string {
  const v = Number(usd ?? 0);
  if (!v) return "$0";
  if (v < 0.01) return "<$0.01";
  return `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`;
}

export function formatTokens(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

/** A log line as plain text (the raw log download): "2026-11-18T10:04:11.123Z INFO  [draft] message". */
export function logLineText(l: { at: string; level: string; step: string | null; message: string }): string {
  return `${l.at} ${l.level.toUpperCase().padEnd(7)} ${l.step ? `[${l.step}] ` : ""}${l.message}`;
}
