import { lineDiff } from "@/lib/seo-intel/optimize";

/** Side-by-side current vs proposed. Short fields: two columns. Body: changed lines with 2 lines of context, as <del>/<ins>. */
export function SideBySide({ current, proposed, field }: { current: string | null; proposed: string; field: string }) {
  if (field !== "body") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line p-3">
          <p className="text-xs font-semibold text-fg-subtle">Current</p>
          <p className="mt-1 text-sm [overflow-wrap:anywhere]">{current ?? <em className="text-fg-subtle">empty (falls back to the title/description)</em>}</p>
          {current && <p className="mt-1 text-xs text-fg-subtle">{current.length} characters</p>}
        </div>
        <div className="rounded-lg border border-emerald-300 p-3 dark:border-emerald-500/40">
          <p className="text-xs font-semibold text-fg-subtle">Proposed</p>
          <p className="mt-1 text-sm [overflow-wrap:anywhere]">{proposed}</p>
          <p className="mt-1 text-xs text-fg-subtle">{proposed.length} characters</p>
        </div>
      </div>
    );
  }
  const d = lineDiff(current ?? "", proposed);
  const keep = new Set<number>();
  d.forEach((l, i) => {
    if (l.type !== "same") for (let k = Math.max(0, i - 2); k <= Math.min(d.length - 1, i + 2); k++) keep.add(k);
  });
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-surface-muted p-3 text-xs leading-5" aria-label="Changes to the article body">
      {d.map((l, i) => {
        if (!keep.has(i)) return keep.has(i - 1) ? <span key={i} className="block text-fg-subtle">⋯</span> : null;
        if (l.type === "del") return <del key={i} className="block bg-red-50 text-red-800 no-underline dark:bg-red-500/10 dark:text-red-300"><span aria-hidden="true">− </span>{l.text}</del>;
        if (l.type === "add") return <ins key={i} className="block bg-emerald-50 text-emerald-800 no-underline dark:bg-emerald-500/10 dark:text-emerald-300"><span aria-hidden="true">+ </span>{l.text}</ins>;
        return <span key={i} className="block text-fg-muted">  {l.text}</span>;
      })}
    </pre>
  );
}
