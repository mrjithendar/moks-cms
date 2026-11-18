"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ChevronDown, CloseIcon, MenuIcon, SearchIcon } from "@/components/icons";
import { arrangeMenu, currentOf, filterMenu, MAX_PINS, NAV_PREFS_COOKIE, writeNavPrefs, type MenuEntry, type MenuGroup, type NavItem, type NavPrefs } from "@/lib/admin-menu";
import { MenuGlyph } from "./menu-icons";

export type { NavItem };

/** Which groups are open, remembered per browser (a convenience: the menu works the same without it). */
export const NAV_STORE_KEY = "admin-nav-open-v2";
const PINNED = "pinned";

function readSaved(): string[] | null {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(NAV_STORE_KEY) ?? "null") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function saveOpen(open: Set<string>) {
  try {
    globalThis.localStorage?.setItem(NAV_STORE_KEY, JSON.stringify([...open]));
  } catch {
    /* private mode or storage blocked: the choice lasts until the page reloads */
  }
}

function savePrefs(prefs: NavPrefs) {
  try {
    document.cookie = `${NAV_PREFS_COOKIE}=${writeNavPrefs(prefs)}; path=/admin; max-age=31536000; samesite=lax${window.location.protocol === "https:" ? "; secure" : ""}`;
  } catch {
    /* cookies blocked: the choice lasts until the page reloads */
  }
}

/** Whether the sidebar is beside the page (tablets and larger) rather than behind the "Menu" button. */
const LARGE = "(min-width: 768px)";
/** How long a hovered submenu stays open after the pointer leaves it (crossing the gap to the panel). */
const HOVER_CLOSE_MS = 200;
const beside = () => typeof window.matchMedia === "function" && window.matchMedia(LARGE).matches;
const onResize = (changed: () => void) => {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(LARGE) : null;
  media?.addEventListener?.("change", changed);
  return () => media?.removeEventListener?.("change", changed);
};

/** A row of the menu, without its `display`: rows are `flex`, and the ones for large screens only `hidden md:flex`. */
const ROW = "min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors";
const IDLE = "text-fg-muted hover:bg-surface-sunken hover:text-fg";
const ACTIVE = "bg-accent-soft text-accent-text";

function Badge({ n, what, className = "" }: { n: number; what: string; className?: string }) {
  if (n <= 0) return null;
  return (
    <span className={`rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent ${className}`}>
      {n}
      <span className="sr-only"> {what}</span>
    </span>
  );
}

/**
 * The admin sidebar: the menu, grouped the way lib/admin-menu.ts arranges it.
 *
 * - Every group opens a submenu. On tablets and larger screens (sidebar beside the page) the submenu is a panel beside
 *   the sidebar, opened by hovering or clicking the group, one at a time; nothing expands inside the sidebar. On a
 *   phone (behind the "Menu" button) groups expand and collapse in place; the current page's group is open, and which
 *   groups a person opened is remembered in their browser. A group shows the total of its badges (pending reviews,
 *   unread messages…) while its pages are not shown, so nothing that needs attention is hidden.
 * - "Filter menu" finds a page by name across all groups; Enter opens the first match.
 * - Pages can be pinned (the star beside them): pinned pages are listed first.
 * - "Collapse menu" narrows the sidebar to icons beside the page.
 *   Pins and the narrow menu are kept in a cookie (`prefs` is what the server read from it), so the menu is drawn the
 *   way it was left, without jumping after the page loads.
 * - Below `lg` a "Menu" button (showing the current page) toggles the same list, with `account` (who is signed in,
 *   Sign out) at its end.
 */
export function AdminSidebar({ items, role, account, prefs }: { items: NavItem[]; role?: string; account?: ReactNode; prefs?: NavPrefs }) {
  const pathname = usePathname();
  const query = useSearchParams();
  const router = useRouter();
  const menu = arrangeMenu(items);
  const all = menu.groups.flatMap((g) => g.items);
  const current = currentOf(menu.help ? [...all, menu.help] : all, pathname, query);
  const here = menu.groups.find((g) => g.items.some((i) => i === current))?.id;

  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState(prefs?.rail ?? false);
  const [pins, setPins] = useState<string[]>(prefs?.pins ?? []);
  const [text, setText] = useState("");
  const [flyout, setFlyout] = useState<{ id: string; top: number; left: number } | null>(null);
  const nav = useRef<HTMLElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // False on the server and on the first browser render: the narrow menu only changes how groups open once this is known.
  const wide = useSyncExternalStore(onResize, beside, () => false);
  // Same on the server and in the browser (no hydration mismatch); saved choices are applied after mounting.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([PINNED, here].filter((s): s is string => !!s)));
  useEffect(() => {
    const saved = readSaved();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only preference, read once after hydration
    if (saved) setExpanded(new Set([...saved, ...(here ? [here] : [])]));
    // Only on mount: later navigation is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After navigating: close what was opened to get there and open the new page's group (React's "adjust state on
  // prop change"). The current page is part of the key because one address can hold several menu pages (?section=…).
  const address = `${pathname} ${current?.href ?? ""}`;
  const [lastAddress, setLastAddress] = useState(address);
  if (address !== lastAddress) {
    setLastAddress(address);
    setOpen(false);
    setFlyout(null);
    setText("");
    if (here && !expanded.has(here)) setExpanded(new Set([...expanded, here]));
  }
  // An open flyout closes on a click elsewhere and on Escape.
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: MouseEvent) => {
      if (!nav.current?.contains(e.target as Node)) setFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFlyout(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [flyout]);

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
    saveOpen(next);
  };
  const cancelClose = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => cancelClose, []);
  const showFlyout = (g: MenuGroup, button: HTMLElement) => {
    // Beside the sidebar, level with the group; moved up when the panel would not fit below (its height is estimated
    // from its rows, since it is not drawn yet), but never above the sidebar's own top edge.
    const r = button.getBoundingClientRect();
    const aside = button.closest("aside")?.getBoundingClientRect();
    const height = Math.min(window.innerHeight * 0.8, 44 + g.items.length * 38 + g.items.filter((i) => i.heading).length * 26);
    const ceiling = (aside?.top ?? 0) + 8;
    const top = Math.max(ceiling, Math.min(Math.round(r.top), Math.round(window.innerHeight - 8 - height)));
    setFlyout({ id: g.id, top, left: Math.round(aside?.right ?? r.right) + 4 });
  };
  // Pinned pages are a shortcut list: beside the page (full width) they stay listed, not behind a panel.
  const listed = (g: MenuGroup) => g.id === PINNED && wide && !rail;
  const onGroup = (g: MenuGroup, button: HTMLElement) => {
    if (listed(g)) return;
    if (!wide) {
      toggle(g.id);
      return;
    }
    cancelClose();
    if (flyout?.id === g.id) setFlyout(null);
    else showFlyout(g, button);
  };
  const onHover = (g: MenuGroup, li: HTMLElement) => {
    if (!wide || listed(g)) return;
    cancelClose();
    const button = li.querySelector("button");
    if (button && flyout?.id !== g.id) showFlyout(g, button);
  };
  const onLeave = () => {
    if (!wide) return;
    cancelClose();
    hoverTimer.current = setTimeout(() => setFlyout(null), HOVER_CLOSE_MS);
  };
  const toggleRail = () => {
    setRail(!rail);
    setFlyout(null);
    savePrefs({ rail: !rail, pins });
  };
  const togglePin = (href: string) => {
    const next = pins.includes(href) ? pins.filter((p) => p !== href) : [...pins, href].slice(-MAX_PINS);
    setPins(next);
    savePrefs({ rail, pins: next });
  };

  const pinned = pins.map((href) => all.find((i) => i.href === href)).filter((i): i is MenuEntry => !!i);
  const groups: MenuGroup[] = pinned.length > 0 ? [{ id: PINNED, label: "Pinned", icon: "pin", items: pinned, badge: 0 }, ...menu.groups] : menu.groups;
  const matches = text.trim() ? filterMenu(menu, text) : null;
  const pending = all.reduce((n, i) => n + (i.badge ?? 0), 0);
  const onFilter = (e: FormEvent) => {
    e.preventDefault();
    const first = matches?.[0];
    if (first) router.push(first.entry.href);
  };
  // In the narrow menu a label is for screen readers only, and the row centres its icon.
  const label = rail ? "md:sr-only" : "";
  const row = rail ? `flex ${ROW} md:justify-center md:px-0` : `flex ${ROW}`;

  return (
    <aside
      data-rail={rail ? "" : undefined}
      onScroll={() => {
        if (flyout) setFlyout(null);
      }}
      // Above the page beside it (a group's panel in the narrow menu overlaps the page), below the site header and dialogs.
      className={`border-b border-line bg-canvas md:sticky md:top-header md:z-30 md:h-[calc(100dvh-var(--spacing-header))] md:overflow-y-auto md:border-b-0 md:border-r ${rail ? "md:w-16" : "md:w-64"}`}
    >
      <div className={`flex flex-col gap-3 px-4 py-3 sm:px-6 md:min-h-full md:gap-4 md:py-5 ${rail ? "md:px-2" : "md:px-3"}`}>
        <Link href="/admin" className={`hidden items-center gap-2 px-3 ${rail ? "" : "md:flex"}`}>
          <span className="text-sm font-semibold text-fg">Admin</span>
          {role && <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium capitalize text-fg-muted">{role}</span>}
        </Link>
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="admin-nav"
            className="flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-fg md:hidden"
          >
            <span className="flex min-w-0 items-center gap-2">
              {open ? <CloseIcon className="h-4 w-4 shrink-0" /> : <MenuIcon className="h-4 w-4 shrink-0" />}
              <span className="truncate">Menu{current ? ` · ${current.label}` : ""}</span>
            </span>
            <Badge n={pending} what="items need attention" />
          </button>
          <nav ref={nav} id="admin-nav" aria-label="Admin" className={`${open ? "mt-1 block" : "hidden"} rounded-lg border border-line bg-surface p-3 md:mt-0 md:block md:border-0 md:bg-transparent md:p-0`}>
            <form role="search" onSubmit={onFilter} className={`relative mb-2 ${rail ? "md:hidden" : ""}`}>
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <input
                type="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setText("");
                }}
                placeholder="Filter menu"
                aria-label="Filter the menu"
                autoComplete="off"
                className="block min-h-10 w-full rounded-md border border-line bg-surface py-1.5 pl-9 pr-3 text-base text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none md:text-sm"
              />
            </form>

            {matches ? (
              <div data-results>
                {matches.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-fg-subtle">No page matches “{text.trim()}”.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {matches.map(({ entry, group }) => (
                      <li key={entry.href}>
                        <Link href={entry.href} aria-current={entry === current ? "page" : undefined} className={`flex min-h-10 items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${entry === current ? ACTIVE : IDLE}`}>
                          <span className="min-w-0 truncate">{entry.label}</span>
                          <span className="shrink-0 text-xs font-normal text-fg-subtle">{group}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <ul className="grid gap-1 sm:grid-cols-2 sm:gap-x-4 md:grid-cols-1">
                {groups.map((g) => {
                  const id = `admin-nav-${g.id}`;
                  // Beside the page: a group opens as a panel next to the sidebar, one at a time. On a phone: in place.
                  const floating = wide && !listed(g) && flyout?.id === g.id;
                  const isOpen = listed(g) || (wide ? floating : expanded.has(g.id));
                  const holdsCurrent = g.id === here || (g.id === PINNED && g.items.some((i) => i === current));
                  return (
                    <li key={g.id} data-group={g.id} className="relative" onMouseEnter={(e) => onHover(g, e.currentTarget)} onMouseLeave={onLeave}>
                      <button type="button" onClick={(e) => onGroup(g, e.currentTarget)} aria-expanded={isOpen} aria-controls={id} title={rail ? g.label : undefined} className={`${row} ${holdsCurrent ? "text-fg hover:bg-surface-sunken md:bg-accent-soft md:text-accent-text" : IDLE}`}>
                        <MenuGlyph name={g.icon} className="h-5 w-5 shrink-0" />
                        <span className={`min-w-0 flex-1 truncate ${label}`}>{g.label}</span>
                        {!isOpen && <Badge n={g.badge} what="need attention" className={rail ? "md:hidden" : ""} />}
                        {!listed(g) && <ChevronDown className={`h-4 w-4 shrink-0 text-fg-subtle transition-transform ${isOpen ? "rotate-180" : ""} md:-rotate-90 ${rail ? "md:hidden" : ""}`} />}
                      </button>
                      {rail && g.badge > 0 && <span className="pointer-events-none absolute right-2 top-1.5 hidden h-2 w-2 rounded-full bg-accent md:block" />}
                      <ul
                        id={id}
                        hidden={!isOpen}
                        style={floating && flyout ? { top: flyout.top, left: flyout.left } : undefined}
                        className={`mb-1 mt-0.5 space-y-0.5 ${floating ? "md:fixed md:z-40 md:m-0 md:max-h-[80dvh] md:w-64 md:overflow-y-auto md:rounded-lg md:border md:border-line-strong md:bg-surface md:p-2 md:shadow-xl" : ""}`}
                      >
                        {floating && <li className="hidden px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle md:block">{g.label}</li>}
                        {g.items.map((item) => {
                          const active = item === current;
                          const isPinned = pins.includes(item.href);
                          const name = g.id === PINNED ? item.label : item.title;
                          return (
                            <li key={item.href} className="group">
                              {item.heading && g.id !== PINNED && <p className={`pb-0.5 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle ${floating ? "pl-11 md:pl-3" : "pl-11"}`}>{item.heading}</p>}
                              <div className="flex items-center gap-1">
                                <Link
                                  href={item.href}
                                  aria-current={active ? "page" : undefined}
                                  className={`flex min-h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-md py-1.5 pr-2 text-sm font-medium transition-colors ${floating ? "pl-11 md:pl-3" : "pl-11"} ${active ? ACTIVE : IDLE}`}
                                >
                                  <span className="min-w-0 truncate">{name}</span>
                                  <Badge n={item.badge ?? 0} what="pending" />
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => togglePin(item.href)}
                                  aria-pressed={isPinned}
                                  aria-label={isPinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
                                  title={isPinned ? "Unpin" : "Pin to the top of the menu"}
                                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-opacity hover:bg-surface-sunken ${isPinned ? "text-accent-text" : "text-fg-subtle md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"}`}
                                >
                                  <MenuGlyph name="pin" filled={isPinned} className="h-4 w-4" />
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-3 space-y-1 border-t border-line pt-3">
              {menu.help && (
                <Link href={menu.help.href} aria-current={menu.help === current ? "page" : undefined} title={rail ? "Help: user manual" : menu.help.label} className={`${row} ${menu.help === current ? ACTIVE : IDLE}`}>
                  <MenuGlyph name="help" className="h-5 w-5 shrink-0" />
                  <span className={`min-w-0 flex-1 truncate ${label}`}>Help</span>
                </Link>
              )}
              <button type="button" onClick={toggleRail} aria-pressed={rail} title={rail ? "Expand menu" : undefined} className={`hidden md:flex ${ROW} ${rail ? "md:justify-center md:px-0" : ""} ${IDLE}`}>
                <ChevronDown className={`h-5 w-5 shrink-0 ${rail ? "-rotate-90" : "rotate-90"}`} />
                <span className={`min-w-0 flex-1 truncate ${label}`}>{rail ? "Expand menu" : "Collapse menu"}</span>
              </button>
            </div>
            {account && <div className="mt-4 border-t border-line px-3 pt-4 text-sm md:hidden">{account}</div>}
          </nav>
        </div>
        {account && <div className={`mt-auto hidden border-t border-line px-3 pt-4 text-sm ${rail ? "" : "md:block"}`}>{account}</div>}
      </div>
    </aside>
  );
}
