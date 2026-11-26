"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SEO_GROUPS, type SectionIcon } from "./sections";

/**
 * SEO pages are ordinary CMS admin pages (navigation is the main admin sidebar). This keeps the ⌘K / Ctrl+K command
 * palette (sections, settings, articles, keywords) and the Dashboard's Search & traffic view controls (date range +
 * comparison toggle as URL params, Search Console property, sync-status pill).
 */
export type SyncPill = { state: "ok" | "stale" | "error" | "disconnected" | "never_synced"; label: string; detail: string };

const ICON: Record<SectionIcon, string> = {
  home: "M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  chart: "M4 19V5M4 19h16M8 15l3-4 3 2 5-6",
  users: "M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1a3 3 0 0 0-2-2.8M4 19v-1a3 3 0 0 1 2-2.8",
  file: "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6",
  inbox: "M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.5.4.5 1 .5 1.6h6c0-.6 0-1.2.5-1.6A6 6 0 0 0 12 3",
  key: "M14 10a4 4 0 1 1-4 4M14 10l7-7M18 6l2 2M10 14l-6 6",
  doc: "M7 4h10v16H7zM10 8h4M10 12h4M10 16h2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  wrench: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  report: "M5 3h14v18H5zM9 15v3M12 11v7M15 8v10",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5",
  sync: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4",
  cog: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1",
};
export function SeoIcon({ name, className = "h-4 w-4" }: { name: SectionIcon; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[name]} />
    </svg>
  );
}

const PILL: Record<SyncPill["state"], string> = {
  ok: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-200",
  stale: "bg-amber-50 text-amber-900 ring-amber-600/25 dark:bg-amber-400/10 dark:text-amber-200",
  error: "bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-400/10 dark:text-red-200",
  disconnected: "bg-surface-muted text-fg-muted ring-line-strong",
  never_synced: "bg-surface-muted text-fg-muted ring-line-strong",
};

type PaletteItem = { label: string; hint: string; href: string; group: string };

function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<PaletteItem[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const local = useMemo<PaletteItem[]>(
    () => [
      ...SEO_GROUPS.flatMap((g) => g.items.map((i) => ({ label: i.label, hint: i.hint, href: i.href, group: "Sections" }))),
      ...([["Drafts & Claude budget", "/admin/settings/ai?section=ai"], ["Internal linking limits", "/admin/settings/seo?section=content"], ["Submission", "/admin/settings/seo?section=content"], ["Keywords", "/admin/settings/seo?section=content"], ["Schedules", "/admin/settings/seo?section=schedules"], ["Thresholds", "/admin/settings/seo?section=scoring"]] as const).map(([l, href]) => ({ label: `Settings: ${l}`, hint: "Settings", href, group: "Settings" })),
    ],
    [],
  );
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      opener.current?.focus?.();
    };
  }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/admin/seo/palette?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: PaletteItem[]) => setRemote(rows))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, open]);
  if (!open) return null;
  const needle = q.trim().toLowerCase();
  const items = [...local.filter((i) => !needle || `${i.label} ${i.hint}`.toLowerCase().includes(needle)), ...(needle.length >= 2 ? remote : [])].slice(0, 30);
  const go = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    router.push(i.href);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="seo-palette-list"
          aria-activedescendant={items[active] ? `seo-pal-${active}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setActive((a) => Math.min(items.length - 1, a + 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
            else if (e.key === "Enter") go(items[active]);
            else return;
            e.preventDefault();
          }}
          placeholder="Jump to a section, setting, article or keyword…"
          className="min-h-12 w-full border-b border-line bg-surface px-4 text-base text-fg outline-none"
        />
        <ul id="seo-palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {items.map((i, k) => (
            <li key={`${i.group}-${i.href}-${i.label}`} id={`seo-pal-${k}`} role="option" aria-selected={k === active} onMouseEnter={() => setActive(k)} onClick={() => go(i)} className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${k === active ? "bg-accent-soft text-accent-text" : "text-fg"}`}>
              <span className="min-w-0 truncate">{i.label}</span>
              <span className="shrink-0 text-xs text-fg-subtle">{i.group}</span>
            </li>
          ))}
          {!items.length && <li className="px-3 py-6 text-center text-sm text-fg-subtle">No matches.</li>}
        </ul>
        <p className="border-t border-line px-4 py-2 text-xs text-fg-subtle">↑ ↓ to move · Enter to open · Esc to close</p>
      </div>
    </div>
  );
}

/** The ⌘K / Ctrl+K "Jump to…" palette on SEO pages. Section navigation is the main admin sidebar. */
export function SeoShell({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="min-w-0">
      {children}
      <Palette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

/** Period / compare / property / sync bar above Search & traffic on the admin Dashboard (URL params, shareable). */
export function SeoViewControls({ property, sync }: { property: string | null; sync: SyncPill }) {
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const [palette, setPalette] = useState(false);
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(sp);
    if (v) p.set(k, v);
    else p.delete(k);
    if (k === "range" && v !== "custom") {
      p.delete("start");
      p.delete("end");
    }
    router.push(`${pathname}?${p}`, { scroll: false });
  };
  const range = sp.get("range") ?? "28";
  return (
    <>
      <div role="toolbar" aria-label="Search and traffic view" className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <label className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <span className="max-sm:sr-only">Period</span>
          <select value={range} onChange={(e) => setParam("range", e.target.value)} className="min-h-11 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg sm:min-h-9">
            <option value="7">Last 7 days</option>
            <option value="28">Last 28 days</option>
            <option value="90">Last 90 days</option>
            {range === "custom" && <option value="custom">Custom</option>}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-1.5 text-sm text-fg sm:min-h-9">
          <input type="checkbox" checked={sp.get("compare") === "1"} onChange={(e) => setParam("compare", e.target.checked ? "1" : null)} className="h-4 w-4" />
          Compare to previous
        </label>
        <span className="hidden items-center gap-1 text-xs text-fg-subtle md:flex" title="Search Console property (Settings)">
          <span aria-hidden="true">◎</span> {property ? <Link href="/admin/settings/seo?section=data" className="max-w-[14rem] truncate hover:underline">{property}</Link> : <Link href="/admin/settings/seo?section=data" className="underline">No property set</Link>}
        </span>
        <Link href="/admin/sync" title={sync.detail} className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset ${PILL[sync.state]}`}>
          <span aria-hidden="true">{sync.state === "ok" ? "●" : sync.state === "error" ? "✕" : sync.state === "stale" ? "◐" : "○"}</span>{sync.label}
        </Link>
        <button type="button" onClick={() => setPalette(true)} className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-sm text-fg-muted hover:text-fg sm:min-h-9">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></svg>
          <span className="max-sm:sr-only">Jump to…</span>
          <kbd className="hidden rounded border border-line px-1 text-[0.7rem] text-fg-subtle sm:inline">⌘K</kbd>
        </button>
      </div>
      <Palette open={palette} onClose={() => setPalette(false)} />
    </>
  );
}
