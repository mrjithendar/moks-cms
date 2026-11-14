"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SearchIcon } from "@/components/icons";
import { inputClass } from "@/components/ui/form";
import { GUIDE_SECTIONS, guideArticlePath, searchGuide, type GuideEntry } from "@/lib/user-guide";
import type { SettingsGroup } from "@/lib/user-guide-settings";
import { GuideBody, GuidePageLink, SettingsTable } from "./parts";

export type GuideKind = "all" | "guide" | "faq" | "settings";
const KINDS: { id: GuideKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "guide", label: "Guides" },
  { id: "faq", label: "FAQ" },
  { id: "settings", label: "Settings" },
];

/** Settings areas belong to a guide section, so the area filter narrows them too. */
const SETTINGS_SECTION: Record<string, string> = {
  "Appearance & settings": "Site settings",
  Integrations: "Site settings",
  "Storage & email": "Site settings",
  "Advanced settings": "Site settings",
  "Automation & AI": "SEO agent, AI & ML",
  "MCP access": "SEO agent, AI & ML",
};

const noSubscribe = () => () => {};
const browserSearch = () => window.location.search;
const serverSearch = () => null;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

function filterSettings(groups: SettingsGroup[], query: string, section: string): SettingsGroup[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  return groups
    .filter((g) => !section || SETTINGS_SECTION[g.area] === section)
    .map((g) => {
      if (!words.length) return g;
      const head = norm(`${g.area} ${g.title} ${g.description ?? ""}`);
      if (words.every((w) => head.includes(w))) return g;
      const rows = g.rows.filter((r) => {
        const t = norm(`${head} ${r.name} ${r.key ?? ""} ${r.help ?? ""}`);
        return words.every((w) => t.includes(w));
      });
      return { ...g, rows };
    })
    .filter((g) => g.rows.length > 0);
}

/** A type-ahead match: an entry opens its own page; a settings group is on this page and is scrolled to. */
type Suggestion = { id: string; title: string; label: string; href?: string };

export function GuideBrowser({
  entries,
  settings,
  initial,
  base,
  readUrlOnMount = false,
  linkToAdmin,
}: {
  entries: GuideEntry[];
  settings: SettingsGroup[];
  initial: { q?: string; area?: string; kind?: string };
  /** Where this copy of the manual lives (GUIDE_ADMIN_BASE or GUIDE_PUBLIC_BASE): every entry has a page at <base>/<id>. */
  base: string;
  /** Public page: the server renders the whole manual (cacheable, crawlable); the browser then applies ?q=&area=&kind=. */
  readUrlOnMount?: boolean;
  /** In the admin, entries link to their pages; on the public guide the path is only named. */
  linkToAdmin: boolean;
}) {
  const validArea = (a?: string | null) => ((GUIDE_SECTIONS as readonly string[]).includes(a ?? "") ? a! : "");
  const validKind = (k?: string | null): GuideKind => (KINDS.some((x) => x.id === k) ? (k as GuideKind) : "all");
  const [q, setQ] = useState(initial.q ?? "");
  const [area, setArea] = useState(validArea(initial.area));
  const [kind, setKind] = useState<GuideKind>(validKind(initial.kind));
  // The query string as the browser has it (null while rendering on the server and during hydration).
  const search = useSyncExternalStore<string | null>(noSubscribe, browserSearch, serverSearch);
  const [synced, setSynced] = useState(!readUrlOnMount);
  if (!synced && search !== null) {
    // Adjusting state while rendering (once, right after hydration): React re-renders before painting.
    const sp = new URLSearchParams(search);
    setQ(sp.get("q") ?? "");
    setArea(validArea(sp.get("area")));
    setKind(validKind(sp.get("kind")));
    setSynced(true);
  }

  // Keep the view in the address bar so it can be bookmarked or shared (no navigation, no history spam).
  useEffect(() => {
    if (!synced) return;
    const url = new URL(window.location.href);
    for (const [k, v] of [["q", q.trim()], ["area", area], ["kind", kind === "all" ? "" : kind]] as const) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(window.history.state, "", url);
  }, [q, area, kind, synced]);

  const sections = useMemo(() => GUIDE_SECTIONS.filter((s) => entries.some((e) => e.section === s) || settings.some((g) => SETTINGS_SECTION[g.area] === s)), [entries, settings]);
  const found = useMemo(() => (kind === "settings" ? [] : searchGuide(entries, q, area || undefined, kind === "all" ? undefined : kind)), [entries, q, area, kind]);
  const guides = found.filter((e) => e.kind === "guide");
  const faqs = found.filter((e) => e.kind === "faq");
  const settingGroups = useMemo(() => (kind === "all" || kind === "settings" ? filterSettings(settings, q, area) : []), [settings, q, area, kind]);
  const settingRows = settingGroups.reduce((n, g) => n + g.rows.length, 0);
  const searching = q.trim().length > 0;
  const total = guides.length + faqs.length + settingRows;
  // Results per category for the current search and kind (whatever category is selected), shown on the chips.
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    const kindFilter = kind === "all" || kind === "settings" ? undefined : kind;
    if (kind !== "settings") for (const e of searchGuide(entries, q, undefined, kindFilter)) out[e.section] = (out[e.section] ?? 0) + 1;
    if (kind === "all" || kind === "settings") {
      for (const g of filterSettings(settings, q, "")) {
        const s = SETTINGS_SECTION[g.area];
        if (s) out[s] = (out[s] ?? 0) + g.rows.length;
      }
    }
    return out;
  }, [entries, settings, q, kind]);
  const allCount = Object.values(counts).reduce((a, b) => a + b, 0);

  // Type-ahead: the best matches across guides, FAQ and settings, to jump straight to one instead of reading the list.
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!q.trim()) return [];
    const items = searchGuide(entries, q).slice(0, 6).map((e) => ({ id: e.id, title: e.title, label: e.kind === "faq" ? "FAQ" : e.section, href: guideArticlePath(base, e.id) }));
    const groups = filterSettings(settings, q, "").slice(0, 3).map((g) => ({ id: g.id, title: g.title, label: `Settings · ${g.area}` }));
    return [...items, ...groups].slice(0, 8);
  }, [entries, settings, q, base]);
  const showSuggestions = open && suggestions.length > 0;

  /** Show everything that matches (so the target is rendered), then scroll to it and open it if it is collapsed. */
  const jump = (id: string) => {
    setOpen(false);
    setArea("");
    setKind("all");
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.focus({ preventScroll: true });
    });
  };

  const router = useRouter();
  /** Open a suggestion: an entry's own page, or (settings) the group further down this page. */
  const go = (s: Suggestion) => {
    if (s.href) {
      setOpen(false);
      router.push(s.href);
    } else jump(s.id);
  };

  // "/" focuses the search box from anywhere on the page (unless the reader is typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const chip = (active: boolean) =>
    `min-h-9 rounded-full border px-3 text-sm font-medium transition-colors ${active ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface text-fg-muted hover:text-fg"}`;

  return (
    <div>
      <div className="sticky top-header z-10 -mx-1 bg-surface-muted/95 px-1 pb-3 pt-1 backdrop-blur supports-[backdrop-filter]:bg-surface-muted/80">
        <label htmlFor="guide-search" className="sr-only">Search the guide</label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input
            ref={inputRef}
            id="guide-search"
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && suggestions[0]) { e.preventDefault(); go(suggestions[0]); }
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Type what you need: publish, backup, budget, MCP, sandbox…  (press / to search)"
            className={`${inputClass} pl-9`}
            autoComplete="off"
            role="combobox"
            aria-expanded={showSuggestions}
            aria-controls="guide-suggestions"
          />
          {showSuggestions && (
            <ul id="guide-suggestions" role="listbox" aria-label="Jump to" className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg">
              {suggestions.map((s, i) => (
                <li key={s.id} role="option" aria-selected={i === 0}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(s)} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-muted focus:bg-surface-muted">
                    <span className="text-fg">{s.title}</span>
                    <span className="shrink-0 text-xs text-fg-subtle">{s.label}</span>
                  </button>
                </li>
              ))}
              <li className="px-3 pb-1 pt-2 text-xs text-fg-subtle">Enter opens the first match · all matches are listed below</li>
            </ul>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Show">
          {KINDS.map((k) => (
            <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)} className={chip(kind === k.id)}>
              {k.label}
            </button>
          ))}
          {(searching || area || kind !== "all") && (
            <button type="button" onClick={() => { setQ(""); setArea(""); setKind("all"); }} className="min-h-9 px-2 text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline">
              Clear
            </button>
          )}
        </div>
        {/* Categories: one row, scrolls sideways on phones; each shows how many results it holds for the current search. */}
        <div className="-mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Category">
          <button type="button" aria-pressed={area === ""} onClick={() => setArea("")} className={`${chip(area === "")} shrink-0`}>
            All categories <span className="opacity-70">{allCount}</span>
          </button>
          {sections.map((s) => (
            <button key={s} type="button" aria-pressed={area === s} onClick={() => setArea(area === s ? "" : s)} disabled={!counts[s] && area !== s} className={`${chip(area === s)} shrink-0 whitespace-nowrap disabled:opacity-40`}>
              {s} <span className="opacity-70">{counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-fg-subtle" aria-live="polite">
          {total === 0 ? "Nothing matches. Try another word or clear the filters." : `${guides.length} guide${guides.length === 1 ? "" : "s"}, ${faqs.length} question${faqs.length === 1 ? "" : "s"}, ${settingRows} setting${settingRows === 1 ? "" : "s"}`}
        </p>
      </div>

      {guides.length > 0 && (
        <section aria-labelledby="guide-guides" className="mt-6">
          <h2 id="guide-guides" className="text-lg font-semibold text-fg">Guides</h2>
          {/* Searching: one list, best match first. Browsing: grouped by category, in the order of the contents. */}
          {(searching ? [{ section: "", items: guides }] : sections.map((sec) => ({ section: sec as string, items: guides.filter((e) => e.section === sec) })).filter((g) => g.items.length > 0)).map((g) => (
            <div key={g.section || "results"} className="mt-4">
              {g.section && <h3 className="text-sm font-semibold text-fg">{g.section}</h3>}
              <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                {g.items.map((e) => (
                  <li key={e.id} id={e.id} className="scroll-mt-40">
                    <Link href={guideArticlePath(base, e.id)} className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:border-line-strong">
                      {!g.section && <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{e.section}</span>}
                      <span className="text-base font-semibold text-fg">{e.title}</span>
                      <span className="mt-1 text-sm text-fg-muted">{e.summary}</span>
                      <span className="link mt-3 text-sm font-medium">Read the guide →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {faqs.length > 0 && (
        <section aria-labelledby="guide-faq" className="mt-8">
          <h2 id="guide-faq" className="text-lg font-semibold text-fg">Frequently asked questions</h2>
          <div className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {faqs.map((e) => (
              <details key={e.id} id={e.id} tabIndex={-1} open={searching} className="group scroll-mt-40 px-5 py-3">
                <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-fg">
                  <span>{e.title}</span>
                  <span className="text-xs font-normal text-fg-subtle">{e.section}</span>
                </summary>
                <GuideBody lines={e.body} />
                <GuidePageLink href={e.href} linkToAdmin={linkToAdmin} />
                <p className="mt-2 text-xs"><Link href={guideArticlePath(base, e.id)} className="link">Open this answer as its own page</Link></p>
              </details>
            ))}
          </div>
        </section>
      )}

      {settingGroups.length > 0 && (
        <section aria-labelledby="guide-settings" className="mt-8">
          <h2 id="guide-settings" className="text-lg font-semibold text-fg">Settings reference</h2>
          <p className="mt-1 text-sm text-fg-muted">Every setting and option, what it does and its default. Defaults only: this reference never shows the values saved on this site.</p>
          <div className="mt-3 space-y-3">
            {settingGroups.map((g) => (
              <details key={g.id} id={g.id} tabIndex={-1} open={searching || kind === "settings"} className="scroll-mt-40 rounded-xl border border-line bg-surface">
                <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <span className="text-sm font-semibold text-fg">{g.title}</span>
                  <span className="text-xs text-fg-subtle">{g.area} · {g.rows.length}</span>
                </summary>
                <div className="border-t border-line px-5 pb-4 pt-3">
                  {g.description && <p className="text-sm text-fg-muted">{g.description}</p>}
                  <SettingsTable group={g} />
                  <GuidePageLink href={g.href} linkToAdmin={linkToAdmin} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
