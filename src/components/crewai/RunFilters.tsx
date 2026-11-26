"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type Option = { value: string; label: string };

/**
 * Filters for the runs list, kept in the URL (shareable, back button works). Selects apply at once; the search box
 * applies on Enter or after a pause. Works without JavaScript too: it is a GET form.
 */
export function RunFilters({ flows, statuses, triggers, categories = [], crews = [], flowParam = "flow" }: { flows: { group: string; options: Option[] }[]; statuses: Option[]; triggers: Option[]; categories?: Option[]; crews?: Option[]; flowParam?: "flow" | "item" }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  const apply = (key: string, value: string) => {
    const p = new URLSearchParams(params.toString());
    if (value) p.set(key, value);
    else p.delete(key);
    p.delete("before");
    router.push(`${path}${p.size ? `?${p}` : ""}`);
  };

  useEffect(() => {
    if (q === (params.get("q") ?? "")) return;
    const t = window.setTimeout(() => apply("q", q.trim()), 500);
    return () => window.clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = "min-h-9 max-w-full rounded-md border border-line bg-surface px-2 text-sm text-fg";
  const any = ["flow", "item", "status", "trigger", "q", "category", "crew", "from", "to"].some((k) => params.get(k));
  return (
    <form method="get" role="search" aria-label="Filter runs" className="mb-4 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); apply("q", q.trim()); }}>
      <label className="min-w-0 flex-1 basis-56">
        <span className="sr-only">Search runs</span>
        <input name="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: #12, run ID, target, actor, error" className="min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm" />
      </label>
      <label>
        <span className="sr-only">Flow</span>
        <select name={flowParam} className={select} value={params.get(flowParam) ?? ""} onChange={(e) => apply(flowParam, e.target.value)}>
          <option value="">All flows</option>
          {flows.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">Status</span>
        <select name="status" className={select} value={params.get("status") ?? ""} onChange={(e) => apply("status", e.target.value)}>
          <option value="">Any status</option>
          {statuses.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label>
        <span className="sr-only">Trigger</span>
        <select name="trigger" className={select} value={params.get("trigger") ?? ""} onChange={(e) => apply("trigger", e.target.value)}>
          <option value="">Any trigger</option>
          {triggers.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {categories.length > 0 && (
        <label>
          <span className="sr-only">Category</span>
          <select name="category" className={select} value={params.get("category") ?? ""} onChange={(e) => apply("category", e.target.value)}>
            <option value="">Any category</option>
            {categories.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
      {crews.length > 0 && (
        <label>
          <span className="sr-only">Crew</span>
          <select name="crew" className={select} value={params.get("crew") ?? ""} onChange={(e) => apply("crew", e.target.value)}>
            <option value="">Any crew</option>
            {crews.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
      <label className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <span>From</span>
        <input type="date" name="from" className={select} value={params.get("from") ?? ""} onChange={(e) => apply("from", e.target.value)} />
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <span>to</span>
        <input type="date" name="to" className={select} value={params.get("to") ?? ""} onChange={(e) => apply("to", e.target.value)} />
      </label>
      <noscript><button type="submit" className="min-h-9 rounded-md border border-line px-3 text-sm">Apply</button></noscript>
      {any && <button type="button" onClick={() => { setQ(""); router.push(path); }} className="min-h-9 rounded-md px-2 text-sm text-fg-muted hover:bg-surface-sunken hover:text-fg">Clear filters</button>}
    </form>
  );
}
