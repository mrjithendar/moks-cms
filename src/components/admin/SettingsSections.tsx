"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { inputClass } from "@/components/ui/form";

/**
 * The sectioned settings layout: a list of sections on the left on a wide screen, a select above the panel on a
 * narrow one, and the open section in the address as `?section=<id>` so it can be bookmarked and linked from the
 * menu. Taken out of Admin → Appearance & site settings (which draws exactly this) so every settings page can use it.
 *
 * Two ways to change section:
 * - `onSelect`: the page keeps every section in the browser (Appearance: one shared draft). The section is state;
 *   `useSettingsSection` keeps it and the address in step.
 * - `basePath`: each section is its own server render at `<basePath>?section=<id>` (AI & SEO settings: each section
 *   loads its own data and saves on its own). The list is links and the select navigates. An old `#tab-<id>` link
 *   to such a page (its sections were tabs once) is sent on to `?section=<id>`.
 *
 * A form inside a section calls `useUnsavedChanges(dirty)`. While any form has unsaved changes, leaving the section
 * asks first, and so does closing the tab.
 */
export type SettingsSection = { id: string; label: string; /** Problems to fix in this section, shown as a count. */ problems?: number };

type Unsaved = { report: (id: symbol, dirty: boolean) => void };
const UnsavedContext = createContext<Unsaved | null>(null);

export const LEAVE_QUESTION = "This section has changes that are not saved. Leave it without saving?";

/** Tell the surrounding settings page that this form has unsaved changes (or no longer has). Safe outside one. */
export function useUnsavedChanges(dirty: boolean): void {
  const ctx = useContext(UnsavedContext);
  const id = useRef(Symbol("form"));
  useEffect(() => {
    const key = id.current;
    ctx?.report(key, dirty);
    return () => ctx?.report(key, false);
  }, [ctx, dirty]);
}

/**
 * The open section as browser state, in step with `?section=` both ways: a menu link to another section of the same
 * page changes the address without loading the page again, so the section follows the address when it changes; and
 * choosing a section writes it to the address for bookmarks.
 */
export function useSettingsSection<Id extends string>(sections: readonly { id: Id }[], initial: string | undefined, fallback: Id): [Id, (id: Id) => void] {
  const known = useCallback((id: string | null | undefined): id is Id => sections.some((s) => s.id === id), [sections]);
  const [section, setSection] = useState<Id>(known(initial) ? initial : fallback);
  const inAddress = useSearchParams().get("section");
  const [lastInAddress, setLastInAddress] = useState(inAddress);
  if (inAddress !== lastInAddress) {
    setLastInAddress(inAddress);
    if (inAddress !== section && known(inAddress)) setSection(inAddress);
  }
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("section", section);
    window.history.replaceState(null, "", url);
  }, [section]);
  return [section, setSection];
}

export function SettingsSections({
  sections,
  current,
  onSelect,
  basePath,
  label = "Settings sections",
  children,
}: {
  sections: readonly SettingsSection[];
  current: string;
  /** Sections kept in the browser: called with the chosen section. */
  onSelect?: (id: string) => void;
  /** Sections rendered by the server: the page's path; each section is at `<basePath>?section=<id>`. */
  basePath?: string;
  label?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const href = useMemo(() => (basePath ? (id: string) => `${basePath}?section=${encodeURIComponent(id)}` : undefined), [basePath]);
  const dirtyForms = useRef(new Set<symbol>());
  const [dirty, setDirty] = useState(false);
  const unsaved = useMemo<Unsaved>(
    () => ({
      report: (id, isDirty) => {
        if (isDirty) dirtyForms.current.add(id);
        else dirtyForms.current.delete(id);
        setDirty(dirtyForms.current.size > 0);
      },
    }),
    [],
  );

  // Closing the tab or loading another page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // A link to one field (…?section=ml#field-id) scrolls to it and puts the cursor in it.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement) el.focus({ preventScroll: true });
  }, [current]);

  // A bookmark from when these sections were tabs (#tab-runs) opens the section it meant.
  useEffect(() => {
    const old = /^#tab-([a-z0-9-]+)$/.exec(window.location.hash)?.[1];
    if (href && old && old !== current && sections.some((s) => s.id === old)) router.replace(href(old));
  }, [href, current, sections, router]);

  const mayLeave = () => dirtyForms.current.size === 0 || window.confirm(LEAVE_QUESTION);
  const go = (id: string) => {
    if (id === current || !mayLeave()) return;
    if (onSelect) onSelect(id);
    else if (href) router.push(href(id));
  };
  const item = (active: boolean) => `flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-3 text-left text-sm font-medium transition-colors ${active ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-surface-sunken hover:text-fg"}`;
  const count = (n: number | undefined) =>
    n ? (
      <span className="rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-800 dark:bg-red-500/20 dark:text-red-200">
        {n}
        <span className="sr-only"> problems</span>
      </span>
    ) : null;

  return (
    <UnsavedContext.Provider value={unsaved}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label={label} className="xl:sticky xl:top-[calc(var(--spacing-chrome)+6rem)] xl:self-start">
          <label className="block xl:hidden">
            <span className="sr-only">Section</span>
            <select value={current} onChange={(e) => go(e.target.value)} className={inputClass}>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.problems ? ` (${s.problems} to fix)` : ""}
                </option>
              ))}
            </select>
          </label>
          <ul className="hidden space-y-0.5 xl:block">
            {sections.map((s) => (
              <li key={s.id}>
                {onSelect || !href ? (
                  <button type="button" onClick={() => go(s.id)} aria-current={s.id === current ? "page" : undefined} className={item(s.id === current)}>
                    {s.label}
                    {count(s.problems)}
                  </button>
                ) : (
                  <Link
                    href={href(s.id)}
                    aria-current={s.id === current ? "page" : undefined}
                    className={item(s.id === current)}
                    onClick={(e) => {
                      if (s.id !== current && !mayLeave()) e.preventDefault();
                    }}
                  >
                    {s.label}
                    {count(s.problems)}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </UnsavedContext.Provider>
  );
}
