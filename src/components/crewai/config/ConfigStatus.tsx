import Link from "next/link";
import { Ago } from "@/components/crewai/Ago";
import type { SyncRecord, SyncStatus } from "@/lib/crewai/bundle/sync";

/**
 * The configuration at a glance (console Overview and AI & SEO → Configuration): what runs (counts read from the
 * configuration itself), its version, the Git revision it came from, the last import and whether it changed here since.
 */

const COUNTS: { kind: keyof SyncStatus["counts"]; label: string; href: string }[] = [
  { kind: "crews", label: "Crews", href: "/admin/crewai/crews" },
  { kind: "flows", label: "Flows", href: "/admin/crewai/flows" },
  { kind: "skills", label: "Skills", href: "/admin/crewai/config?tab=repository&group=skills" },
  { kind: "agents", label: "Agents", href: "/admin/crewai/config?tab=repository&group=agents" },
  { kind: "tasks", label: "Tasks", href: "/admin/crewai/config?tab=repository&group=tasks" },
  { kind: "tools", label: "Tools", href: "/admin/crewai/config?tab=repository&group=tools" },
  { kind: "schedules", label: "Schedules", href: "/admin/crewai/schedules" },
];

const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : "—");

export function syncLabel(r: SyncRecord | null): string {
  if (!r) return "never";
  const what = r.direction === "export" ? "written to Git" : r.mode === "dry_run" ? "planned" : r.status === "unchanged" ? "imported (no change)" : r.status;
  return `${what} · ${r.source}`;
}

export function DriftBadge({ status }: { status: SyncStatus }) {
  const d = status.drift;
  const [label, tone] = !status.ready
    ? ["needs migration 0042", "bg-surface-sunken text-fg-muted"]
    : !d || d.state === "never_synced"
      ? ["never synced with Git", "bg-surface-sunken text-fg-muted"]
      : d.state === "in_sync"
        ? ["in step with the last sync", "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200"]
        : [`${d.changed.length + d.added.length + d.removed.length} changed here since`, "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

export function ConfigStatus({ status, repoUrl, compact = false }: { status: SyncStatus; repoUrl?: string | null; compact?: boolean }) {
  const rev = status.lastImport?.revision ?? status.baseline?.revision ?? null;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {COUNTS.map((c) => (
          <div key={c.kind} className="rounded-lg border border-line bg-surface p-3">
            <dt className="text-xs text-fg-subtle"><Link href={c.href} className="hover:underline">{c.label}</Link></dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-fg">{status.counts[c.kind]}</dd>
          </div>
        ))}
      </dl>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
        <div><dt className="text-xs text-fg-subtle">Configuration version</dt><dd className="font-mono text-fg" title={status.version}>{short(status.version)}{!status.complete && <span className="ml-2 font-sans text-xs text-amber-700 dark:text-amber-300">(partial: the SEO agent did not answer)</span>}</dd></div>
        <div><dt className="text-xs text-fg-subtle">Git revision</dt><dd className="font-mono text-fg">{rev ? (repoUrl ? <a className="underline" href={repoUrl.replace(/\/tree\/[^/]+\//, `/tree/${rev}/`)} target="_blank" rel="noreferrer">{rev.slice(0, 12)}</a> : rev.slice(0, 12)) : "—"}</dd></div>
        <div><dt className="text-xs text-fg-subtle">Drift</dt><dd><DriftBadge status={status} /></dd></div>
        <div><dt className="text-xs text-fg-subtle">Last sync</dt><dd className="text-fg">{status.lastSync ? <>{syncLabel(status.lastSync)} · <Ago iso={status.lastSync.createdAt} /></> : "never"}</dd></div>
        <div><dt className="text-xs text-fg-subtle">Last import</dt><dd className={status.lastImport?.status === "failed" || status.lastImport?.status === "refused" ? "text-red-700 dark:text-red-300" : "text-fg"}>{status.lastImport ? <>{status.lastImport.status} · {status.lastImport.source} · <Ago iso={status.lastImport.createdAt} /></> : "never"}</dd></div>
        <div><dt className="text-xs text-fg-subtle">SEO agent</dt><dd className="text-fg">{status.report.agent.reachable ? `online${status.report.agent.version ? ` · ${status.report.agent.version.slice(0, 12)}` : ""}` : "off"}</dd></div>
      </dl>
      {!compact && status.drift && status.drift.state === "drifted" && (
        <details className="rounded-lg border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium text-fg">What changed here since the last sync</summary>
          <ul className="mt-2 font-mono text-xs leading-6 text-fg-muted">
            {status.drift.changed.map((r) => <li key={r}>~ {r}</li>)}
            {status.drift.added.map((r) => <li key={r}>+ {r}</li>)}
            {status.drift.removed.map((r) => <li key={r}>- {r}</li>)}
          </ul>
          <p className="mt-2 text-xs text-fg-subtle">Changes made on the admin pages since the last import or write to Git. A deployment keeps them (they are conflicts for its import) until they are written to Git or overwritten.</p>
        </details>
      )}
    </div>
  );
}
