"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "@/components/icons";

const PHASE_TONE: Record<string, string> = {
  unscheduled: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  scheduled: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  published: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
};
const DRAFT_TONE: Record<string, string> = {
  none: "bg-surface text-fg-subtle ring-slate-600/20",
  outline: "bg-surface text-fg-muted ring-slate-600/20",
  writing: "bg-violet-50 text-violet-800 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300",
  failed: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  ready: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  scheduled: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  published: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
};
export const DRAFT_LABEL: Record<string, string> = {
  none: "No draft",
  outline: "Outline only",
  writing: "Writing…",
  failed: "Draft failed",
  ready: "Draft ready",
  scheduled: "Post scheduled",
  published: "Published",
};

const pill = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset";

/**
 * One editorial calendar item: a header that is always visible (expand/collapse button before the title, phase, draft
 * state, source, date) and the details below it, shown when expanded.
 */
export function CalendarItemCard({ title, phase, draft, meta, when, children, defaultOpen = false }: { title: string; phase: string; draft: string; meta: string; when: string | null; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useId();
  return (
    <article className="rounded-xl border border-line bg-surface shadow-sm">
      <header className="flex items-start gap-2 p-4 sm:p-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={body}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-fg-muted transition-colors hover:border-line-strong hover:bg-surface-sunken hover:text-fg"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-left text-base font-semibold text-fg [overflow-wrap:anywhere] hover:underline">
            {title}
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span className={`${pill} capitalize ${PHASE_TONE[phase] ?? PHASE_TONE.unscheduled}`}>{phase}</span>
            <span className={`${pill} ${DRAFT_TONE[draft] ?? DRAFT_TONE.none}`}>{DRAFT_LABEL[draft] ?? draft}</span>
            <span className="text-fg-subtle">{meta}</span>
            {when && <span className="font-medium text-fg-muted tabular-nums">{when}</span>}
          </div>
        </div>
      </header>
      <div id={body} hidden={!open} className="border-t border-line px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
        {children}
      </div>
    </article>
  );
}
