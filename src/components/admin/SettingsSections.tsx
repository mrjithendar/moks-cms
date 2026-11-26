"use client";

import { useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { inputClass } from "@/components/ui/form";

/**
 * The sectioned layout of the Appearance editor: a list of sections on the left on a wide screen, a select above the
 * panel on a narrow one. Every section is kept in the browser (one shared draft); the open one is state, and
 * `useSettingsSection` keeps it and the address's `?section=<id>` in step so it can be bookmarked and linked from the
 * menu. The Settings area (components/admin/SettingsHub.tsx), where each section is its own server render, has its
 * own two-level list and shares the unsaved-changes guard below.
 *
 * A form inside a section calls `useUnsavedChanges(dirty)`. While any form has unsaved changes, leaving the section
 * asks first, and so does closing the tab.
 */
export type SettingsSection = {
  id: string;
  label: string;
  /** Problems to fix in this section, shown as a count. */
  problems?: number;
  /** A heading the section is listed under (an optgroup in the phone's select). Sections of one group are next to each other. */
  group?: string;
};

/** The sections in runs of the same group, in their order: `[{ group: "SEO", sections: [...] }, ...]`; no group = "". */
export function groupSections<T extends { group?: string }>(sections: readonly T[]): { group: string; sections: T[] }[] {
  const runs: { group: string; sections: T[] }[] = [];
  for (const s of sections) {
    const g = s.group ?? "";
    const last = runs.at(-1);
    if (last && last.group === g) last.sections.push(s);
    else runs.push({ group: g, sections: [s] });
  }
  return runs;
}

type Unsaved = { report: (id: symbol, dirty: boolean) => void; dirty: () => boolean };
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

/** Whether the person may leave the open section now: true without unsaved changes, else their answer to LEAVE_QUESTION. */
export function useMayLeave(): () => boolean {
  const ctx = useContext(UnsavedContext);
  return useCallback(() => !ctx || !ctx.dirty() || window.confirm(LEAVE_QUESTION), [ctx]);
}

/**
 * The unsaved-changes guard of a settings page (this layout and the Settings area, components/admin/SettingsHub):
 * forms inside report with `useUnsavedChanges`; closing the tab with unsaved changes asks first; and a link to one field
 * (…?section=ml#field-id) scrolls to it and puts the cursor in it whenever `current` (the open section) changes.
 */
export function UnsavedChangesBoundary({ current, children }: { current: string; children: ReactNode }) {
  const dirtyForms = useRef(new Set<symbol>());
  const [dirty, setDirty] = useState(false);
  const unsaved = useMemo<Unsaved>(
    () => ({
      report: (id, isDirty) => {
        if (isDirty) dirtyForms.current.add(id);
        else dirtyForms.current.delete(id);
        setDirty(dirtyForms.current.size > 0);
      },
      dirty: () => dirtyForms.current.size > 0,
    }),
    [],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement) el.focus({ preventScroll: true });
  }, [current]);

  return <UnsavedContext.Provider value={unsaved}>{children}</UnsavedContext.Provider>;
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
  label = "Settings sections",
  children,
}: {
  sections: readonly SettingsSection[];
  current: string;
  /** Called with the chosen section. */
  onSelect: (id: string) => void;
  label?: string;
  children: ReactNode;
}) {
  return (
    <UnsavedChangesBoundary current={current}>
      <SectionList sections={sections} current={current} onSelect={onSelect} label={label}>
        {children}
      </SectionList>
    </UnsavedChangesBoundary>
  );
}

function SectionList({ sections, current, onSelect, label, children }: { sections: readonly SettingsSection[]; current: string; onSelect: (id: string) => void; label: string; children: ReactNode }) {
  const mayLeave = useMayLeave();
  const go = (id: string) => {
    if (id === current || !mayLeave()) return;
    onSelect(id);
  };
  const count = (n: number | undefined) =>
    n ? (
      <span className="shrink-0 rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-800 dark:bg-red-500/20 dark:text-red-200">
        {n}
        <span className="sr-only"> problems</span>
      </span>
    ) : null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label={label} className={settingsNavClass}>
        <label className="block xl:hidden">
          <span className="sr-only">Section</span>
          <select value={current} onChange={(e) => go(e.target.value)} className={inputClass}>
            {groupSections(sections).map(({ group, sections: run }) => {
              const options = run.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.problems ? ` (${s.problems} to fix)` : ""}
                </option>
              ));
              return group ? (
                <optgroup key={group} label={group}>
                  {options}
                </optgroup>
              ) : (
                options
              );
            })}
          </select>
        </label>
        <div className="hidden xl:block">
          {groupSections(sections).map(({ group, sections: run }, i) => (
            <div key={group || i} className={i > 0 ? "mt-4" : undefined}>
              {group && <p aria-hidden="true" className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{group}</p>}
              <ul aria-label={group || undefined} className="space-y-0.5">
                {run.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => go(s.id)} aria-current={s.id === current ? "page" : undefined} className={settingsNavItemClass(s.id === current)}>
                      <span className="min-w-0">{s.label}</span>
                      {count(s.problems)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}

/**
 * The list of sections beside a settings form from `xl` up: it stays in view below the site header while the form
 * scrolls, and scrolls on its own only when it is taller than the window. Below `xl` it is a select above the form.
 */
export const settingsNavClass =
  "min-w-0 xl:sticky xl:top-[calc(var(--spacing-chrome)+1.5rem)] xl:max-h-[calc(100dvh-var(--spacing-chrome)-3rem)] xl:self-start xl:overflow-y-auto xl:overscroll-contain";

/** One entry of a settings list (drawn from `xl` up, with a pointer): the open one is marked. Long names wrap; they never widen the list. */
export const settingsNavItemClass = (active: boolean) =>
  `flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-3 py-1 text-left text-sm font-medium transition-colors ${active ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-surface-sunken hover:text-fg"}`;
