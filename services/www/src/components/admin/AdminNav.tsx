"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, CloseIcon, MenuIcon } from "@/components/icons";

export type NavItem = { href: string; label: string; badge?: number; section: string; exact?: boolean };

const matches = (item: NavItem, pathname: string) => (item.exact || item.href === "/admin" ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));
/** The one current item: the longest matching href (so /admin/automation/mcp does not also light up Automation). */
export const currentOf = (items: NavItem[], pathname: string) => items.filter((i) => matches(i, pathname)).sort((a, b) => b.href.length - a.href.length)[0];

/** Which categories are open, remembered per browser (a convenience: the menu works the same without it). */
export const NAV_STORE_KEY = "admin-nav-open-v1";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function readSaved(): string[] | null {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(NAV_STORE_KEY) ?? "null") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function save(open: Set<string>) {
  try {
    globalThis.localStorage?.setItem(NAV_STORE_KEY, JSON.stringify([...open]));
  } catch {
    /* private mode or storage blocked: the choice lasts until the page reloads */
  }
}

/**
 * The admin menu, grouped by category; each category expands and collapses. The category of the current page is
 * always open; the first category (Overview) and the current one are open by default, and the reader's choices are
 * remembered in this browser. A collapsed category shows the total of its badges (pending reviews, unread messages…),
 * so nothing that needs attention is hidden. Sidebar on large screens; below `lg` a "Menu" button (showing the current
 * page) toggles the same list, with `account` (signed-in user, Sign out) at its end.
 */
export function AdminNav({ items, account }: { items: NavItem[]; account?: ReactNode }) {
  const pathname = usePathname();
  const sections = [...new Set(items.map((i) => i.section))];
  const current = currentOf(items, pathname);
  const here = current?.section;
  const [open, setOpen] = useState(false);
  // Same on the server and in the browser (no hydration mismatch); saved choices are applied after mounting.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([sections[0], here].filter((s): s is string => !!s)));
  useEffect(() => {
    const saved = readSaved();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only preference, read once after hydration
    if (saved) setExpanded(new Set([...saved.filter((s) => sections.includes(s)), ...(here ? [here] : [])]));
    // Only on mount: later navigation is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After navigating: close the mobile menu and open the new page's category (React's "adjust state on prop change").
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
    if (here && !expanded.has(here)) setExpanded(new Set([...expanded, here]));
  }

  const update = (next: Set<string>) => {
    setExpanded(next);
    save(next);
  };
  const toggle = (section: string) => {
    const next = new Set(expanded);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    update(next);
  };
  const allOpen = sections.every((s) => expanded.has(s));
  const pending = items.reduce((n, i) => n + (i.badge ?? 0), 0);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="admin-nav"
        className="flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-fg lg:hidden"
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? <CloseIcon className="h-4 w-4 shrink-0" /> : <MenuIcon className="h-4 w-4 shrink-0" />}
          <span className="truncate">Menu{current ? ` · ${current.label}` : ""}</span>
        </span>
        {pending > 0 && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">{pending}<span className="sr-only"> items need attention</span></span>}
      </button>
      <nav id="admin-nav" aria-label="Admin" className={`${open ? "mt-1 block" : "hidden"} rounded-lg border border-line bg-surface p-3 lg:mt-0 lg:block lg:border-0 lg:bg-transparent lg:p-0`}>
        {sections.length > 2 && (
          <div className="mb-2 flex justify-end px-1">
            <button
              type="button"
              onClick={() => update(allOpen ? new Set([sections[0], here].filter((s): s is string => !!s)) : new Set(sections))}
              className="rounded px-2 py-1 text-xs font-medium text-fg-subtle hover:bg-surface-sunken hover:text-fg"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}
        <div className="grid gap-1 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-1">
          {sections.map((section) => {
            const list = items.filter((i) => i.section === section);
            const isOpen = expanded.has(section);
            const id = `admin-nav-${slug(section)}`;
            const badges = list.reduce((n, i) => n + (i.badge ?? 0), 0);
            return (
              <div key={section} data-section={section}>
                <button
                  type="button"
                  onClick={() => toggle(section)}
                  aria-expanded={isOpen}
                  aria-controls={id}
                  className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide transition-colors hover:bg-surface-sunken hover:text-fg ${section === here ? "text-fg" : "text-fg-subtle"}`}
                >
                  <span>{section}</span>
                  <span className="flex items-center gap-2">
                    {!isOpen && badges > 0 && (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold normal-case tracking-normal text-on-accent">
                        {badges}
                        <span className="sr-only"> need attention</span>
                      </span>
                    )}
                    {!isOpen && badges === 0 && <span className="text-xs font-normal normal-case tracking-normal text-fg-subtle">{list.length}</span>}
                    <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                  </span>
                </button>
                <ul id={id} hidden={!isOpen} className="mb-2 mt-0.5 space-y-0.5">
                  {list.map((item) => {
                    const active = item === current;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={`flex min-h-9 items-center justify-between rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                            active ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-surface-sunken hover:text-fg"
                          }`}
                        >
                          {item.label}
                          {item.badge ? <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">{item.badge}<span className="sr-only"> pending</span></span> : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        {account && <div className="mt-4 border-t border-line px-3 pt-4 lg:hidden">{account}</div>}
      </nav>
    </div>
  );
}
