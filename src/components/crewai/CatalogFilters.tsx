"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterQuery, RECENT, RUN_STATES, SORTS, STATUSES, type CatalogFilter, type CatalogKind, type Category, type Facet } from "@/lib/crewai/catalog-shared";

const STORE = (kind: CatalogKind) => `crewai:${kind}:filter`;
const control = "min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-fg";

/**
 * The filter bar of AI & SEO → Crews and → Flows: the same bar, the same query string and the same behaviour for both
 * (lib/crewai/catalog-shared.ts). Everything is filtered, sorted and paged on the server; this bar only writes the
 * address. Search by name, description, key or tag; categories and tags are searchable multi-selects (any one matches);
 * each active filter is a removable chip; "Clear all" resets. The last filter of each list is remembered in this tab
 * (sessionStorage), so leaving a crew's page and coming back to the list keeps it.
 */
export function CatalogFilters({ kind, filter, categories, facets, total }: { kind: CatalogKind; filter: CatalogFilter; categories: Category[]; facets: { categories: Facet[]; tags: Facet[] }; total: number }) {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState(filter.q ?? "");
  const current = filterQuery(filter);
  const go = (patch: Partial<CatalogFilter>) => {
    const next = filterQuery(filter, { page: 1, ...patch });
    router.replace(`${path}${next ? `?${next}` : ""}`, { scroll: false });
  };

  // Remember this list's filter; coming back to the bare list address restores it.
  useEffect(() => {
    try {
      if (current) sessionStorage.setItem(STORE(kind), current);
      else if (!window.location.search) {
        const saved = sessionStorage.getItem(STORE(kind));
        if (saved && !sessionStorage.getItem(`${STORE(kind)}:cleared`)) router.replace(`${path}?${saved}`, { scroll: false });
      }
      sessionStorage.removeItem(`${STORE(kind)}:cleared`);
    } catch {
      /* storage blocked: the address still carries the filter */
    }
  }, [current, kind, path, router]);

  useEffect(() => {
    if (q === (filter.q ?? "")) return;
    const t = window.setTimeout(() => go({ q: q.trim() || undefined }), 350);
    return () => window.clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const labelOf = useMemo(() => new Map(categories.map((c) => [c.slug, c.label])), [categories]);
  const catOptions = categories.map((c) => ({ value: c.slug, label: c.label, n: facets.categories.find((f) => f.value === c.slug)?.n ?? 0 }));
  const tagOptions = [...new Set([...facets.tags.map((t) => t.value), ...(filter.tags ?? [])])].map((t) => ({ value: t, label: t, n: facets.tags.find((f) => f.value === t)?.n ?? 0 }));

  const chips: { key: string; label: string; remove: () => void }[] = [
    ...(filter.q ? [{ key: "q", label: `“${filter.q}”`, remove: () => { setQ(""); go({ q: undefined }); } }] : []),
    ...(filter.categories ?? []).map((c) => ({ key: `c-${c}`, label: labelOf.get(c) ?? c, remove: () => go({ categories: filter.categories?.filter((x) => x !== c) }) })),
    ...(filter.tags ?? []).map((t) => ({ key: `t-${t}`, label: `#${t}`, remove: () => go({ tags: filter.tags?.filter((x) => x !== t) }) })),
    ...(filter.status && filter.status !== "active" ? [{ key: "s", label: STATUSES.find((s) => s.id === filter.status)?.label ?? "All", remove: () => go({ status: "active" }) }] : []),
    ...(filter.recent ? [{ key: "r", label: RECENT.find((s) => s.id === filter.recent)!.label, remove: () => go({ recent: undefined }) }] : []),
    ...(filter.run ? [{ key: "run", label: RUN_STATES.find((s) => s.id === filter.run)!.label, remove: () => go({ run: undefined }) }] : []),
  ];
  const one = kind === "crew" ? "crew" : "flow";

  return (
    <div className="mb-4 space-y-3">
      <form role="search" aria-label={`Filter ${one}s`} className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); go({ q: q.trim() || undefined }); }}>
        <label className="min-w-0 flex-1 basis-60">
          <span className="sr-only">Search {one}s</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${one}s by name, description or tag`} className="min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm" />
        </label>
        <MultiSelect label="Categories" options={catOptions} selected={filter.categories ?? []} onChange={(v) => go({ categories: v })} empty="No categories yet." />
        <MultiSelect label="Tags" options={tagOptions} selected={filter.tags ?? []} onChange={(v) => go({ tags: v })} empty="Nothing is tagged yet." />
        <label>
          <span className="sr-only">Status</span>
          <select className={control} value={filter.status ?? "active"} onChange={(e) => go({ status: e.target.value as CatalogFilter["status"] })}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.id === "active" ? "Any status" : s.label}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Created or changed</span>
          <select className={control} value={filter.recent ?? ""} onChange={(e) => go({ recent: (e.target.value || undefined) as CatalogFilter["recent"] })}>
            <option value="">Any time</option>
            {RECENT.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Last run</span>
          <select className={control} value={filter.run ?? ""} onChange={(e) => go({ run: (e.target.value || undefined) as CatalogFilter["run"] })}>
            <option value="">Any last run</option>
            {RUN_STATES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1">
          <span className="text-xs text-fg-muted">Sort</span>
          <select className={control} value={filter.sort ?? "name"} onChange={(e) => go({ sort: e.target.value as CatalogFilter["sort"], dir: undefined })}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className={control}
          aria-label={`Sort ${(filter.dir ?? ((filter.sort ?? "name") === "name" ? "asc" : "desc")) === "asc" ? "descending" : "ascending"} instead`}
          title="Reverse the order"
          onClick={() => go({ dir: (filter.dir ?? ((filter.sort ?? "name") === "name" ? "asc" : "desc")) === "asc" ? "desc" : "asc", page: filter.page })}
        >
          {(filter.dir ?? ((filter.sort ?? "name") === "name" ? "asc" : "desc")) === "asc" ? "↑" : "↓"}
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <p className="text-fg-muted" role="status" aria-live="polite">
          <strong className="tabular-nums text-fg">{total}</strong> {one}{total === 1 ? "" : "s"}
        </p>
        {chips.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted py-0.5 pl-2.5 pr-1 text-xs text-fg">
            {c.label}
            <button type="button" onClick={c.remove} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-fg-muted hover:bg-surface-sunken hover:text-fg" aria-label={`Remove filter ${c.label}`}>×</button>
          </span>
        ))}
        {chips.length > 0 && (
          <button
            type="button"
            className="text-xs font-medium text-accent-text hover:underline"
            onClick={() => {
              setQ("");
              try {
                sessionStorage.removeItem(STORE(kind));
                sessionStorage.setItem(`${STORE(kind)}:cleared`, "1");
              } catch {
                /* ignore */
              }
              router.replace(path, { scroll: false });
            }}
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

type Option = { value: string; label: string; n: number };

/** A searchable multi-select in a popover: type to narrow, Space/Enter to tick, Escape to close. */
function MultiSelect({ label, options, selected, onChange, empty }: { label: string; options: Option[]; selected: string[]; onChange: (v: string[]) => void; empty: string }) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const [picked, setPicked] = useState(selected);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) {
        setOpen(false);
        if (picked.join() !== selected.join()) onChange(picked);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open, picked, selected, onChange]);
  const shown = options.filter((o) => o.label.toLowerCase().includes(find.trim().toLowerCase()));
  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} aria-controls={`${id}-list`} className={`${control} inline-flex items-center gap-1`} onClick={() => { setPicked(selected); setOpen((v) => !v); }}>
        {label}
        {selected.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-xs font-semibold text-accent-text">{selected.length}</span>}
        <span aria-hidden="true" className="text-fg-subtle">▾</span>
      </button>
      {open && (
        <div id={`${id}-list`} className="absolute left-0 z-20 mt-1 w-64 rounded-lg border border-line bg-surface p-2 shadow-lg">
          <label className="block">
            <span className="sr-only">Find {label.toLowerCase()}</span>
            <input autoFocus type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder={`Find ${label.toLowerCase()}`} className="mb-2 min-h-9 w-full rounded-md border border-line bg-surface px-2 text-sm" />
          </label>
          {shown.length === 0 ? (
            <p className="px-1 py-2 text-xs text-fg-subtle">{options.length ? "Nothing matches." : empty}</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto" aria-label={label}>
              {shown.map((o) => (
                <li key={o.value}>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-surface-muted">
                    <input type="checkbox" checked={picked.includes(o.value)} onChange={(e) => setPicked(e.target.checked ? [...picked, o.value] : picked.filter((x) => x !== o.value))} />
                    <span className="flex-1 truncate">{o.label}</span>
                    <span className="tabular-nums text-xs text-fg-subtle">{o.n}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex justify-between gap-2 border-t border-line pt-2">
            <button type="button" className="text-xs text-fg-muted hover:underline" onClick={() => setPicked([])}>None</button>
            <button type="button" className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-on-accent" onClick={() => { setOpen(false); onChange(picked); }}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
