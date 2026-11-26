import type { ReactNode } from "react";

/** Words that read better in capitals in a label ("rag_api_url" → "RAG API URL"). */
const UPPER: Record<string, string> = { api: "API", gsc: "GSC", ga4: "GA4", id: "ID", ids: "IDs", llm: "LLM", mcp: "MCP", ml: "ML", rag: "RAG", seo: "SEO", url: "URL", urls: "URLs", usd: "USD", utc: "UTC" };
const LIST_MAX = 25;

/** A field name as a label: "performance_rows" → "Performance rows", "rag_api_url" → "RAG API URL". */
export function factLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean);
  const out = words.map((w, i) => UPPER[w.toLowerCase()] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()));
  return out.join(" ") || key;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);

function Value({ v }: { v: unknown }): ReactNode {
  if (v == null || v === "") return <span className="text-fg-subtle">—</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return <span className="tabular-nums">{v.toLocaleString("en")}</span>;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="text-fg-subtle">none</span>;
    if (v.every(scalar)) {
      const shown = v.slice(0, LIST_MAX).map((x) => (x == null ? "—" : typeof x === "number" ? x.toLocaleString("en") : String(x)));
      return `${shown.join(", ")}${v.length > LIST_MAX ? `, and ${(v.length - LIST_MAX).toLocaleString("en")} more` : ""}`;
    }
    return (
      <ol className="space-y-2">
        {v.slice(0, LIST_MAX).map((x, i) => (
          <li key={i} className="border-l-2 border-line pl-2">{isRecord(x) ? <Facts value={x} nested /> : <Value v={x} />}</li>
        ))}
        {v.length > LIST_MAX && <li className="text-fg-subtle">and {(v.length - LIST_MAX).toLocaleString("en")} more</li>}
      </ol>
    );
  }
  if (isRecord(v)) return Object.keys(v).length ? <Facts value={v} nested /> : <span className="text-fg-subtle">none</span>;
  return String(v);
}

/**
 * A run's inputs, outputs or a step's recorded detail as labelled values instead of JSON: field names become labels,
 * true/false become Yes/No, numbers get thousands separators, and nested objects become indented groups. Plain values
 * come first, groups after them. The text size is the parent's.
 */
export function Facts({ value, nested = false, empty = "Nothing" }: { value: Record<string, unknown>; nested?: boolean; empty?: string }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <p className="text-fg-subtle">{empty}</p>;
  const ordered = [...entries.filter(([, v]) => scalar(v)), ...entries.filter(([, v]) => !scalar(v))];
  return (
    <dl className={`grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 ${nested ? "" : "rounded-lg border border-line bg-surface p-3"}`}>
      {ordered.map(([k, v]) => {
        const group = !scalar(v) && !(Array.isArray(v) && v.every(scalar));
        return (
          <div key={k} className="contents">
            <dt className={`text-fg-muted ${group ? "col-span-2 mt-1 font-medium text-fg" : ""}`}>{factLabel(k)}</dt>
            <dd className={`min-w-0 text-fg [overflow-wrap:anywhere] ${group ? "col-span-2 border-l-2 border-line pl-3" : ""}`}>
              <Value v={v} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
