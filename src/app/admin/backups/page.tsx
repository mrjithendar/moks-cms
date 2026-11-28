import Link from "next/link";
import { LocalTime } from "@/components/LocalTime";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { SettingsElsewhere } from "@/components/admin/SettingsParts";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { Alert, Button, Select } from "@/components/ui/form";
import { TYPE_LABEL, formatBytes, type Component } from "@/lib/backup/format";
import { backupOverview, describeRun, listBackups, recentOperations, type BackupItem } from "@/lib/backup/service";
import { requireRole } from "@/lib/session";
import { settingsHref } from "@/lib/settings-areas";
import { cancelOperationAction, createBackupAction, deleteBackupAction, verifyBackupAction } from "./actions";
import { BackupActivity } from "./BackupActivity";
import { operationView } from "./view";
import { ConfirmSubmit } from "./ConfirmSubmit";

export const metadata = { title: "Backups" };
export const dynamic = "force-dynamic";

const COMPONENT_LABEL: Record<Component, string> = { database: "Database", uploads: "Files", application: "Configuration", deployment: "Deployment notes" };

function verification(b: BackupItem) {
  if (b.legacy) return <StatusPill status="not verified" />;
  if (!b.verified) return <StatusPill status="not verified" />;
  return <StatusPill status={b.verified.ok ? "verified" : "verification failed"} />;
}

function scheduleText(o: Awaited<ReturnType<typeof backupOverview>>) {
  const flows = o.flowSchedules.filter((f) => f.enabled);
  if (flows.length) return `CrewAI schedule ${flows.map((f) => `${f.name} (${f.cron}, ${f.timezone})`).join(", ")}`;
  const c = o.config;
  if (c.schedule === "off") return "Off: manual backups only";
  return `${c.schedule === "daily" ? "Daily" : "Weekly"} at ${String(c.hourUtc).padStart(2, "0")}:00 UTC, ${c.scheduleType === "full" ? "full site" : "database only"}`;
}

export default async function BackupsPage({ searchParams }: { searchParams: FlashParams }) {
  const me = await requireRole("admin");
  const [overview, list, ops, sp] = await Promise.all([backupOverview(), listBackups().catch((e: Error) => ({ items: [] as BackupItem[], totalBytes: 0, configured: true, error: e.message })), recentOperations(15), searchParams]);
  const listError = "error" in list ? (list.error as string) : null;
  const { config: c, active } = overview;
  const ready = Boolean(c.r2?.enabled);
  const latest = list.items[0];
  const last = overview.lastSuccessful;
  return (
    <>
      <AdminHeader
        title="Backups"
        description="Complete backups of the site: every database table, every file in the storage bucket, configuration, a manifest and checksums, in one zip. Made, verified and restored in the background."
        actions={
          <form action={createBackupAction} className="flex flex-wrap items-center gap-2">
            <label htmlFor="backup-type" className="sr-only">What to back up</label>
            <div className="w-full min-w-0 sm:w-64">
              <Select id="backup-type" name="type" defaultValue="full" disabled={!ready || Boolean(active) || me.demo}>
                <option value="full">Full site</option>
                <option value="database">Database only</option>
              </Select>
            </div>
            <Button type="submit" disabled={!ready || Boolean(active) || me.demo}>Back up now</Button>
          </form>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="space-y-6">
        {!ready && (
          <Alert tone="info">
            Backups need a storage bucket. Turn on the destination in <Link href={settingsHref("backups")} className="font-semibold underline">Settings → System → Backups</Link>.
          </Alert>
        )}
        {active && <BackupActivity key={active.id} initial={operationView(active)} cancel={cancelOperationAction} />}

        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
          <Card>
            <p className="text-sm text-fg-subtle">Latest backup</p>
            <p className="mt-1.5 text-lg font-semibold text-fg">{latest ? <LocalTime iso={latest.createdAt} /> : "None yet"}</p>
            {latest && <p className="mt-1 text-sm text-fg-subtle">{latest.label} · {formatBytes(latest.size)}</p>}
          </Card>
          <Card>
            <p className="text-sm text-fg-subtle">Last successful backup</p>
            <p className="mt-1.5 text-lg font-semibold text-fg">{last ? <LocalTime iso={last.finishedAt ?? last.startedAt} /> : "Never"}</p>
            {last && <p className="mt-1 text-sm text-fg-subtle [overflow-wrap:anywhere]">{describeRun(last).replace(/^./, (x) => x.toUpperCase())}</p>}
          </Card>
          <Card>
            <p className="text-sm text-fg-subtle">Stored backups</p>
            <p className="mt-1.5 text-lg font-semibold text-fg tabular-nums">{list.items.length}</p>
            <p className="mt-1 text-sm text-fg-subtle">{formatBytes(list.totalBytes)} in {c.r2?.bucket ? `bucket ${c.r2.bucket}` : "the media bucket"}</p>
          </Card>
          <Card>
            <p className="text-sm text-fg-subtle">Schedule</p>
            <p className="mt-1.5 text-sm font-semibold text-fg [overflow-wrap:anywhere]">{scheduleText(overview)}</p>
            <p className="mt-1 text-sm text-fg-subtle">Keep the newest {c.retention} of each type{c.maxAgeDays ? `, none older than ${c.maxAgeDays} days` : ""}</p>
          </Card>
        </div>

        <section aria-labelledby="stored-title">
          <h2 id="stored-title" className="font-semibold text-fg">Stored backups</h2>
          <p className="mb-3 mt-1 text-sm text-fg-muted">
            Newest first. Download gives a decrypted copy: keep it private, it holds accounts, comments and messages. Restore verifies the archive and backs up the current database before it changes anything.
          </p>
          {listError && <Alert tone="error">The backup bucket could not be listed: {listError}</Alert>}
          {list.items.length === 0 && !listError ? (
            <Card><p className="text-sm text-fg-muted">No backups yet{ready ? ": use Back up now." : "."}</p></Card>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {list.items.map((b) => (
                <li key={b.name} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <Link href={`/admin/backups/${encodeURIComponent(b.name)}`} className="font-mono text-sm font-medium text-fg hover:underline [overflow-wrap:anywhere]">
                      {b.name}
                    </Link>
                    <p className="mt-1 text-sm text-fg-muted">
                      <LocalTime iso={b.createdAt} /> · {formatBytes(b.size)} · {TYPE_LABEL[b.type]}
                      {b.made?.trigger === "scheduled" ? " · scheduled" : b.made?.trigger === "flow" ? " · CrewAI flow" : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {verification(b)}
                      {b.components.map((x) => (
                        <span key={x} className="rounded-md bg-surface-sunken px-2 py-0.5 text-xs text-fg-muted">{b.legacy && x === "database" ? "12 content tables" : COMPONENT_LABEL[x]}</span>
                      ))}
                      {b.inUse && <StatusPill status="running" />}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <Link className="link" href={`/admin/backups/${encodeURIComponent(b.name)}`}>Details</Link>
                    {!me.demo && <a className="link" href={`/api/admin/backup?file=${encodeURIComponent(b.name)}`} download>Download</a>}
                    {!b.legacy && !me.demo && (
                      <form action={verifyBackupAction}>
                        <input type="hidden" name="name" value={b.name} />
                        <button type="submit" className="link" disabled={Boolean(active)}>Verify</button>
                      </form>
                    )}
                    {!me.demo && <Link className="font-semibold text-red-700 underline dark:text-red-400" href={`/admin/backups/${encodeURIComponent(b.name)}/restore`}>Restore…</Link>}
                    {!me.demo && !b.inUse && (
                      <ConfirmSubmit action={deleteBackupAction} fields={{ name: b.name }} question={`Delete ${b.name}? It is removed from the bucket for good.`}>
                        Delete
                      </ConfirmSubmit>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="activity-title">
          <h2 id="activity-title" className="mb-3 font-semibold text-fg">Recent activity</h2>
          {ops.length === 0 ? (
            <Card><p className="text-sm text-fg-muted">Nothing yet.</p></Card>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {ops.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">
                      {describeRun(r).replace(/^./, (x) => x.toUpperCase())}
                      {r.triggeredBy ? <span className="font-normal text-fg-subtle"> · {r.triggeredBy}</span> : null}
                    </p>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      <LocalTime iso={r.startedAt.toISOString()} />
                      {r.finishedAt ? ` · ${Math.max(1, Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000))} s` : ""}
                      {r.sizeBytes ? ` · ${formatBytes(r.sizeBytes)}` : ""}
                      {r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}
                    </p>
                    {r.filename && r.operation === "backup" && <p className="mt-0.5 font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">{r.filename}</p>}
                    {r.error && <p className={`mt-1 text-xs [overflow-wrap:anywhere] ${r.status === "failed" ? "text-red-700 dark:text-red-400" : "text-fg-muted"}`}>{r.error}</p>}
                  </div>
                  <div className="shrink-0"><StatusPill status={r.status} /></div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <SettingsElsewhere href={settingsHref("backups")}>
        schedule, what a scheduled backup holds, retention, a size limit, encryption and the bucket. Change them in Settings → System → Backups.
      </SettingsElsewhere>
    </>
  );
}
