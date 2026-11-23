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

/**
 * A share as a percentage, rounded to whole numbers except at the ends: it never says 100% while something failed
 * (661 of 663 is "99.7%", not "100%") and never 0% while something succeeded.
 */
export function percent(part: number, whole: number): string {
  if (!(whole > 0)) return "—";
  const p = (part / whole) * 100;
  const r = Math.round(p);
  if (r === 100 && part < whole) return `${Math.min(99.9, Math.round(p * 10) / 10)}%`;
  if (r === 0 && part > 0) return p < 0.1 ? "<0.1%" : `${Math.round(p * 10) / 10}%`;
  return `${r}%`;
}

/**
 * A flow's health over its finished runs of the last 7 days, the window of the console's Runs (7 d) column next to
 * it, so "2 failed" there is never beside a "100%" here. With no finished run in 7 days it falls back to the last ten.
 */
export function healthOf(f: { recent: string[]; succeeded7d: number; failed7d: number }): { ok: number; done: number; window: string } {
  if (f.succeeded7d + f.failed7d > 0) return { ok: f.succeeded7d, done: f.succeeded7d + f.failed7d, window: "in the last 7 days" };
  const done = f.recent.filter((s) => s === "succeeded" || s === "failed");
  return { ok: done.filter((s) => s === "succeeded").length, done: done.length, window: `of the last ${done.length}` };
}

/** A log line as plain text (the raw log download): "2026-11-18T10:04:11.123Z INFO  [draft] message". */
export function logLineText(l: { at: string; level: string; step: string | null; message: string }): string {
  return `${l.at} ${l.level.toUpperCase().padEnd(7)} ${l.step ? `[${l.step}] ` : ""}${l.message}`;
}
