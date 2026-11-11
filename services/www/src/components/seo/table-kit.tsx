"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/form";

/**
 * Data-table building blocks for the search/analytics admin pages (keywords, review, content, links): column picker and density (remembered
 * per viewer in localStorage — a convenience only; the page works without it), multi-column sort headers driven by the
 * URL (server-side sorting), removable filter chips, roving keyboard navigation between rows, saved views.
 */
export type Col = { key: string; label: string; numeric?: boolean; hiddenByDefault?: boolean; sortKey?: string; title?: string };

const read = (k: string) => {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* private mode / blocked storage: preferences just are not remembered */
  }
};

export function useTablePrefs(storageKey: string, cols: Col[]) {
  const defaults = cols.filter((c) => !c.hiddenByDefault).map((c) => c.key);
  const [visible, setVisible] = useState<string[]>(defaults);
  const [dense, setDense] = useState(false);
  useEffect(() => {
    const v = read(`${storageKey}:cols`);
    const d = read(`${storageKey}:dense`);
    // Restore after hydration (the server renders the defaults).
    const t = setTimeout(() => {
      if (v) setVisible(JSON.parse(v) as string[]);
      if (d) setDense(d === "1");
    }, 0);
    return () => clearTimeout(t);
  }, [storageKey]);
  return {
    visible: new Set(visible),
    dense,
    toggle: (key: string) => setVisible((cur) => {
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      write(`${storageKey}:cols`, JSON.stringify(next));
      return next;
    }),
    setDense: (v: boolean) => {
      setDense(v);
      write(`${storageKey}:dense`, v ? "1" : "0");
    },
  };
}

export function ColumnPicker({ cols, visible, toggle }: { cols: Col[]; visible: Set<string>; toggle: (k: string) => void }) {
  return (
    <details className="relative">
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center rounded-md border border-line-strong px-3 text-sm text-fg [&::-webkit-details-marker]:hidden">Columns</summary>
      <fieldset className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-line bg-surface p-3 shadow-lg">
        <legend className="sr-only">Visible columns</legend>
        {cols.map((c) => (
          <label key={c.key} className="flex min-h-8 items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={visible.has(c.key)} onChange={() => toggle(c.key)} /> {c.label}
          </label>
        ))}
      </fieldset>
    </details>
  );
}

export function DensityToggle({ dense, setDense }: { dense: boolean; setDense: (v: boolean) => void }) {
  return (
    <div role="group" aria-label="Row density" className="flex overflow-hidden rounded-md border border-line-strong text-xs">
      {([false, true] as const).map((d) => (
        <button key={String(d)} type="button" aria-pressed={dense === d} onClick={() => setDense(d)} className={`min-h-9 px-2.5 ${dense === d ? "bg-accent-soft font-semibold text-accent-text" : "text-fg-muted"}`}>{d ? "Compact" : "Comfortable"}</button>
      ))}
    </div>
  );
}

/** "gap:desc,impressions:asc" parsing. Click = sort by this column (toggle direction); Shift+click = add as next key. */
export function parseSort(s: string | null): [string, "asc" | "desc"][] {
  return (s ?? "").split(",").filter(Boolean).map((p) => {
    const [k, d] = p.split(":");
    return [k!, d === "asc" ? "asc" : "desc"];
  });
}
export function nextSort(current: string | null, key: string, add: boolean): string {
  const cur = parseSort(current);
  const i = cur.findIndex(([k]) => k === key);
  if (add) {
    if (i >= 0) cur[i] = [key, cur[i]![1] === "desc" ? "asc" : "desc"];
    else cur.push([key, "desc"]);
    return cur.slice(0, 3).map(([k, d]) => `${k}:${d}`).join(",");
  }
  const dir = i === 0 && cur[0]![1] === "desc" ? "asc" : "desc";
  return `${key}:${dir}`;
}

export function SortHeader({ col, className = "" }: { col: Col; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const key = col.sortKey ?? col.key;
  const sorts = parseSort(sp.get("sort"));
  const idx = sorts.findIndex(([k]) => k === key);
  const dir = idx >= 0 ? sorts[idx]![1] : null;
  return (
    <th scope="col" aria-sort={idx === 0 ? (dir === "asc" ? "ascending" : "descending") : undefined} className={`whitespace-nowrap px-3 py-2.5 text-xs font-semibold text-fg-subtle ${col.numeric ? "text-right" : "text-left"} ${className}`}>
      <button
        type="button"
        title={col.title ?? "Sort (Shift+click to add a secondary sort)"}
        onClick={(e) => {
          const p = new URLSearchParams(sp);
          p.set("sort", nextSort(sp.get("sort"), key, e.shiftKey));
          p.delete("offset");
          router.push(`${pathname}?${p}`);
        }}
        className="inline-flex min-h-8 items-center gap-1 rounded hover:text-fg"
      >
        {col.label}
        {dir && <span aria-hidden="true">{dir === "asc" ? "↑" : "↓"}{sorts.length > 1 ? <sup>{idx + 1}</sup> : null}</span>}
        <span className="sr-only">{dir ? `, sorted ${dir === "asc" ? "ascending" : "descending"}${sorts.length > 1 ? `, priority ${idx + 1}` : ""}` : ", sortable"}</span>
      </button>
    </th>
  );
}

/**
 * Removable chips for the active filters (each is a link without that parameter). `labels` maps a search parameter to
 * its chip text, already formatted by the server page: functions can't be passed to a Client Component.
 */
export function FilterChips({ labels }: { labels: Record<string, string> }) {
  const sp = useSearchParams();
  const pathname = usePathname();
  const active = [...sp.entries()].filter(([k, v]) => labels[k] && v);
  if (!active.length) return null;
  const without = (key: string) => {
    const p = new URLSearchParams(sp);
    p.delete(key);
    p.delete("offset");
    return `${pathname}?${p}`;
  };
  return (
    <ul aria-label="Active filters" className="mb-3 flex flex-wrap gap-2">
      {active.map(([k]) => (
        <li key={k}>
          <Link href={without(k)} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-surface-muted px-3 text-xs text-fg hover:border-line-strong">
            {labels[k]} <span aria-hidden="true">✕</span><span className="sr-only"> remove filter</span>
          </Link>
        </li>
      ))}
      <li><Link href={pathname + (sp.get("view") ? `?view=${sp.get("view")}` : "")} className="inline-flex min-h-8 items-center px-2 text-xs text-fg-muted underline">Clear all</Link></li>
    </ul>
  );
}

/** ↑/↓/Home/End move between rows (each row is focusable); Enter follows the row's primary link. */
export function useRowNav(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
      if (!row || (e.target as HTMLElement) !== row) return;
      const rows = [...el.querySelectorAll<HTMLElement>("[data-row]")].filter((r) => r.offsetParent !== null || r.getClientRects().length);
      const i = rows.indexOf(row);
      const go = (n: number) => rows[Math.max(0, Math.min(rows.length - 1, n))]?.focus();
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(rows.length - 1);
      else if (e.key === "Enter") row.querySelector<HTMLAnchorElement>("a[data-primary]")?.click();
      else return;
      e.preventDefault();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [ref]);
}

export function SavedViews({ page, views }: { page: string; views: { name: string; params: Record<string, string> }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const params = Object.fromEntries([...sp.entries()].filter(([k]) => k !== "offset"));
    await fetch("/api/admin/seo/views", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page, name: name.trim(), params }) }).catch(() => null);
    setBusy(false);
    setName("");
    router.refresh();
  };
  const remove = async (n: string) => {
    await fetch(`/api/admin/seo/views?page=${page}&name=${encodeURIComponent(n)}`, { method: "DELETE" }).catch(() => null);
    router.refresh();
  };
  return (
    <details className="relative">
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center rounded-md border border-line-strong px-3 text-sm text-fg [&::-webkit-details-marker]:hidden">Saved views{views.length ? ` (${views.length})` : ""}</summary>
      <div className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg">
        {views.length > 0 && (
          <ul className="mb-3 space-y-1">
            {views.map((v) => (
              <li key={v.name} className="flex items-center justify-between gap-2 text-sm">
                <Link href={`${pathname}?${new URLSearchParams(v.params)}`} className="truncate underline">{v.name}</Link>
                <button type="button" onClick={() => remove(v.name)} className="text-xs text-fg-subtle hover:text-red-700" aria-label={`Delete view ${v.name}`}>Delete</button>
              </li>
            ))}
          </ul>
        )}
        <label className="grid gap-1 text-xs text-fg-subtle">Save current filters, sort and view as
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg" placeholder="e.g. Striking, non-brand" />
        </label>
        <Button size="sm" className="mt-2" loading={busy} onClick={save}>Save view</Button>
      </div>
    </details>
  );
}

/** Tiny trend line (inline SVG, no JS needed to render). Values may contain NaN gaps. */
export function Sparkline({ values, label, invert = false, width = 96, height = 24 }: { values: number[]; label: string; invert?: boolean; width?: number; height?: number }): ReactNode {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return <span className="text-xs text-fg-subtle">—</span>;
  const min = Math.min(...finite);
  const max = Math.max(...finite) === min ? min + 1 : Math.max(...finite);
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => {
    const t = (v - min) / (max - min);
    return (invert ? t : 1 - t) * (height - 4) + 2;
  };
  let d = "";
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    d += `${d && Number.isFinite(values[i - 1]!) ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const first = finite[0]!;
  const last = finite[finite.length - 1]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: from ${Math.round(first)} to ${Math.round(last)}`} className="text-accent">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
