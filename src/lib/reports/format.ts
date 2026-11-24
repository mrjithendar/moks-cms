import type { Format } from "./types";

/**
 * Values as the report shows them, and as the AI analysis must copy them (the agent's number check compares at the
 * precision written: "92.5%", "$4.25", "1,234"). The PDF (moks-seo-agent app/reports_site_pdf.py fmt) formats the same way.
 */
export function fmt(v: number | string | null | undefined, f: Format | undefined): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v === "string" && (!f || f === "text")) return v;
  const x = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(x)) return String(v);
  const n = (d: number) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  switch (f) {
    case "pct":
      return `${(x * 100).toFixed(1)}%`;
    case "usd":
      return x !== 0 && Math.abs(x) < 0.01 ? `$${x.toFixed(4)}` : `$${n(2)}`;
    case "ms":
      return x >= 10_000 ? `${(x / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s` : `${n(0)} ms`;
    case "s":
      return `${n(1)} s`;
    case "bytes":
      return x >= 1_048_576 ? `${(x / 1_048_576).toFixed(1)} MB` : `${Math.round(x / 1024).toLocaleString("en-US")} KB`;
    case "float":
      return n(2);
    default:
      return n(0);
  }
}

/** A relative change ("+20.0%"), null without a previous value or when it was 0. */
export function change(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

export const signedPct = (c: number | null) => (c === null ? "–" : `${c > 0 ? "+" : ""}${(c * 100).toFixed(1)}%`);
