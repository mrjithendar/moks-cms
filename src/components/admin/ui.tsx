import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The top of an admin page: its name, one or two sentences on what it is for, and its main actions (beside the name
 * from `lg`, below it on tablets and phones, where the admin menu takes the room; they wrap onto more lines rather
 * than push the page sideways). `breadcrumbs`: the pages above this one (Settings / Users & access), drawn above the
 * name; they wrap, never widen the page.
 */
export function AdminHeader({ title, description, actions, breadcrumbs }: { title: string; description?: ReactNode; actions?: ReactNode; breadcrumbs?: { href: string; label: string }[] }) {
  return (
    <div className="mb-8 flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1.5">
            <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-fg-subtle">
              {breadcrumbs.map((b) => (
                <li key={b.href} className="flex min-w-0 items-center gap-1.5">
                  <Link href={b.href} className="font-medium hover:text-fg hover:underline">
                    {b.label}
                  </Link>
                  <span aria-hidden="true">/</span>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-fg [overflow-wrap:anywhere]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[0.9375rem] leading-6 text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap gap-2 lg:justify-end">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface p-5 shadow-sm sm:p-6 ${className}`}>{children}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card>
      <p className="text-sm text-fg-subtle">{label}</p>
      <p className="mt-1.5 text-3xl font-semibold tracking-tight text-fg tabular-nums">{value}</p>
      {hint && <p className="mt-2 text-sm text-fg-subtle">{hint}</p>}
    </Card>
  );
}

const statusTones: Record<string, string> = {
  published: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  review: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  draft: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  archived: "bg-slate-100 text-fg-subtle ring-slate-600/10 dark:bg-white/5",
  pending: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  rejected: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  sent: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  overdue: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  void: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  failed: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  spam: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  hidden: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  removed: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  deleted: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  reported: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  open: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  locked: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  closed: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  new: "bg-brand-50 text-accent-text ring-brand-600/20 dark:bg-brand-500/10",
  read: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  degraded: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  down: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  scheduled: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  trash: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  "not configured": "bg-surface-sunken text-fg-muted ring-slate-600/20",
  configured: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  tested: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  "test failed": "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  info: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  notice: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  warning: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  critical: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
};

/** A state as a small coloured label, in sentence case ("Not configured", "Test failed"). */
export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${statusTones[status] ?? statusTones.draft}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export const th = "whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold text-fg-subtle";
export const td = "px-4 py-3 align-top text-sm text-fg-muted";

/**
 * A table in its own frame: a table wider than the page scrolls sideways inside the frame, never the page. The frame is
 * `relative` so that what is positioned inside it (the `sr-only` label of an actions column) is placed in the frame:
 * without it, such a label is placed at its spot in the wide table relative to the page, and the whole page scrolled
 * sideways (Flows → Schedules on a phone, 2026-11-26).
 */
export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="relative overflow-x-auto rounded-xl border border-line bg-surface" tabIndex={0} role="region" aria-label="Table (scrolls sideways)">
      <table className="min-w-full divide-y divide-line">
        <thead className="bg-surface-muted">{head}</thead>
        <tbody className="divide-y divide-line [&>tr]:transition-colors [&>tr:hover]:bg-surface-muted">{children}</tbody>
      </table>
    </div>
  );
}
