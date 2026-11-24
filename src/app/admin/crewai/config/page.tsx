import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { BundleTransfer } from "@/components/crewai/config/BundleTransfer";
import { ConfigStatus, syncLabel } from "@/components/crewai/config/ConfigStatus";
import { RepoBrowser } from "@/components/crewai/config/RepoBrowser";
import { RepoSettingsForm } from "@/components/crewai/config/RepoSettingsForm";
import { RepoSync } from "@/components/crewai/config/RepoSync";
import { RollbackButton } from "@/components/crewai/config/RollbackButton";
import { repoSummary } from "@/lib/crewai/bundle/repo";
import { hasSyncTable, listSyncs, syncStatus, type SyncRecord, type SyncStatus } from "@/lib/crewai/bundle/sync";

export const metadata = { title: "Configuration" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "repository", label: "Repository" },
  { id: "transfer", label: "Import / export" },
  { id: "history", label: "History" },
  { id: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * AI & SEO → Configuration (D-101): the CrewAI configuration as files in the site's repository (crewconfig/). Overview:
 * what runs, its version, Git revision, drift, and the two directions between the site and Git. Repository: browse,
 * edit, validate, history, compare, revert. Import / export: a bundle as a file. History: every import and export, with
 * rollback. Settings: the repository and its token.
 */
export default async function CrewaiConfigPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as Tab) : "overview";
  const ready = await hasSyncTable().catch(() => false);
  const summary = await repoSummary();
  const status = tab === "overview" ? await syncStatus() : null;
  const syncs = tab === "history" && ready ? await listSyncs(100) : [];
  return (
    <>
      <AdminHeader
        title="Configuration"
        description="Every crew, agent, task, flow, skill, schedule and content source as reviewable files in the site's repository: edited here or in Git, imported after every deployment, with history, drift and rollback."
        actions={summary.webUrl ? <a className="text-sm text-fg-muted underline" href={summary.webUrl} target="_blank" rel="noreferrer">{summary.repo}/{summary.path}</a> : null}
      />
      {!ready && <Card className="mb-6"><p className="text-sm text-fg-muted">Import and export work once database migration 0042 is applied (the web app applies it when it starts).</p></Card>}
      <nav aria-label="Configuration" className="-mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1 border-b border-line">
          {TABS.map((t) => (
            <li key={t.id}>
              <Link href={t.id === "overview" ? "/admin/crewai/config" : `/admin/crewai/config?tab=${t.id}`} aria-current={tab === t.id ? "page" : undefined} className={`inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${tab === t.id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>{t.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      {status && <Overview status={status} configured={summary.configured} mode={summary.mode} webUrl={summary.webUrl} ready={ready} />}
      {tab === "repository" && (summary.configured ? <RepoBrowser webUrl={summary.webUrl} /> : <Card><p className="text-sm text-fg-muted">Set up the repository first (Settings).</p></Card>)}
      {tab === "transfer" && <BundleTransfer disabled={!ready} />}
      {tab === "history" && <History ready={ready} items={syncs} />}
      {tab === "settings" && (
        <Card>
          <h2 className="mb-1 text-base font-semibold text-fg">Repository</h2>
          <p className="mb-4 text-sm text-fg-muted">The site repository whose folder holds the configuration. The token stays on the server, sealed with SETTINGS_ENCRYPTION_KEY, and is never shown again; the deployment can give it instead as CREWAI_CONFIG_GITHUB_TOKEN from a Kubernetes Secret.</p>
          <RepoSettingsForm summary={summary} />
        </Card>
      )}
    </>
  );
}

function Overview({ status, configured, mode, webUrl, ready }: { status: SyncStatus; configured: boolean; mode: "commit" | "pull_request"; webUrl: string | null; ready: boolean }) {
  return (
    <div className="space-y-6">
      <Card><ConfigStatus status={status} repoUrl={webUrl} /></Card>
      {(status.report.unsupported.length > 0 || status.report.skipped.length > 0 || status.report.redacted.length > 0) && (
        <Card>
          <h2 className="mb-2 text-base font-semibold text-fg">Not in the bundle, and why</h2>
          <ul className="space-y-1 text-sm text-fg-muted">
            {status.report.unsupported.map((u) => <li key={u.component}><span className="font-medium text-fg">{u.component}</span>: {u.reason}</li>)}
            {status.report.skipped.map((s) => <li key={`${s.kind}:${s.id}`}><span className="font-mono text-xs text-fg">{s.kind}:{s.id}</span>: {s.reason}</li>)}
            {status.report.redacted.map((r, i) => <li key={i} className="text-amber-800 dark:text-amber-200"><span className="font-mono text-xs">{r.item}</span> {r.path}: looked like a {r.pattern}, exported as [redacted]</li>)}
          </ul>
        </Card>
      )}
      <Card>
        <h2 className="mb-1 text-base font-semibold text-fg">The site and Git</h2>
        <p className="mb-4 text-sm text-fg-muted">A deployment imports crewconfig/ on its own (the site repository&apos;s deploy workflow); a change made here is kept until it is written to Git. {mode === "commit" ? "Changes are committed to the branch." : "Changes open a pull request."}</p>
        {ready ? <RepoSync configured={configured} mode={mode} /> : <p className="text-sm text-fg-muted">Needs migration 0042.</p>}
      </Card>
    </div>
  );
}

function History({ ready, items }: { ready: boolean; items: SyncRecord[] }) {
  if (!ready) return <Card><p className="text-sm text-fg-muted">Needs migration 0042.</p></Card>;
  if (!items.length) return <Card><p className="text-sm text-fg-muted">No import or export yet.</p></Card>;
  return (
    <Table head={<tr><th className={th}>When</th><th className={th}>What</th><th className={th}>Revision</th><th className={th}>Result</th><th className={th}>By</th><th className={th}><span className="sr-only">Actions</span></th></tr>}>
      {items.map((s) => {
        const counts = (s.summary.counts ?? {}) as Record<string, number>;
        const applied = (s.summary.applied ?? {}) as Record<string, number>;
        return (
          <tr key={s.id}>
            <td className={td}><Ago iso={s.createdAt} /></td>
            <td className={td}>{syncLabel(s)}{s.policy && <span className="block text-xs text-fg-subtle">conflicts: {s.policy}</span>}</td>
            <td className={`${td} font-mono text-xs`}>{s.revision ? (s.url ? <a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.revision.slice(0, 12)}</a> : s.revision.slice(0, 12)) : "—"}</td>
            <td className={`${td} text-xs`}>
              {s.error ? <span className="text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{s.error.split("\n").slice(0, 3).join(" · ")}</span> : Object.keys(applied).length ? Object.entries(applied).map(([k, n]) => `${n} ${k}`).join(", ") : ["create", "update", "conflict", "error"].filter((a) => counts[a]).map((a) => `${counts[a]} ${a}`).join(", ") || "no change"}
            </td>
            <td className={`${td} text-xs`}>{s.actor ?? "—"}</td>
            <td className={td}>{s.hasSnapshot && s.status === "applied" && <RollbackButton id={s.id} when={new Date(s.createdAt).toLocaleString()} />}</td>
          </tr>
        );
      })}
    </Table>
  );
}
