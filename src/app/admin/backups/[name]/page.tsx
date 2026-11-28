import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { LocalTime } from "@/components/LocalTime";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { buttonClass } from "@/components/ui/form";
import { getDb, schema } from "@/db";
import { TYPE_LABEL, formatBytes, parseArchiveName } from "@/lib/backup/format";
import { activeOperation, listBackups, readSidecar } from "@/lib/backup/service";
import { requireRole } from "@/lib/session";
import { deleteBackupAction, verifyBackupAction } from "../actions";
import { ConfirmSubmit } from "../ConfirmSubmit";

export const metadata = { title: "Backup details" };
export const dynamic = "force-dynamic";

const dl = "grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]";
const dt = "font-medium text-fg-subtle";
const dd = "min-w-0 text-fg [overflow-wrap:anywhere]";

export default async function BackupDetails({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: FlashParams }) {
  const me = await requireRole("admin");
  const [{ name: raw }, sp] = await Promise.all([params, searchParams]);
  const name = decodeURIComponent(raw);
  const parsed = parseArchiveName(name);
  if (!parsed) notFound();
  const [{ items }, sidecar, active] = await Promise.all([listBackups(), readSidecar(name).catch(() => null), activeOperation()]);
  const item = items.find((i) => i.name === name);
  if (!item) notFound();
  const db = await getDb();
  const runs = await db.select().from(schema.backupRun).where(eq(schema.backupRun.filename, name)).orderBy(desc(schema.backupRun.startedAt)).limit(20);
  const m = sidecar?.manifest;
  const checks = runs.filter((r) => r.operation === "verify" || (r.operation === "backup" && r.status === "completed"));
  const restores = runs.filter((r) => r.operation === "restore");
  const enc = encodeURIComponent(name);

  return (
    <>
      <AdminHeader
        title={name}
        breadcrumbs={[{ href: "/admin/backups", label: "Backups" }]}
        description={`${TYPE_LABEL[item.type]} backup made ${parsed.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC · ${formatBytes(item.size)}`}
        actions={
          !me.demo && (
            <>
              <a className={buttonClass("secondary")} href={`/api/admin/backup?file=${enc}`} download>Download</a>
              {!item.legacy && (
                <form action={verifyBackupAction}>
                  <input type="hidden" name="name" value={name} />
                  <button type="submit" className={buttonClass("secondary")} disabled={Boolean(active)}>Verify</button>
                </form>
              )}
              <Link className={buttonClass("danger")} href={`/admin/backups/${enc}/restore`}>Restore…</Link>
            </>
          )
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="space-y-6">
        <Card>
          <h2 className="mb-4 font-semibold text-fg">Archive</h2>
          <dl className={dl}>
            <dt className={dt}>Type</dt>
            <dd className={dd}>{TYPE_LABEL[item.type]}</dd>
            <dt className={dt}>Holds</dt>
            <dd className={dd}>{item.legacy ? "12 content tables (posts, pages, categories, comments, messages, media records, redirects, Appearance, accounts); no files" : (m?.components ?? item.components).join(", ")}</dd>
            <dt className={dt}>Size</dt>
            <dd className={dd}>{formatBytes(item.size)}</dd>
            <dt className={dt}>Made</dt>
            <dd className={dd}><LocalTime iso={item.createdAt} />{item.made?.triggeredBy ? ` by ${item.made.triggeredBy}` : ""}{item.made?.trigger ? ` (${item.made.trigger})` : ""}</dd>
            <dt className={dt}>Stored at</dt>
            <dd className={`${dd} font-mono text-xs`}>{sidecar ? `${sidecar.archive.bucket}/${sidecar.archive.key}` : `jithendar/backups/${name}`}</dd>
            {sidecar && (
              <>
                <dt className={dt}>SHA-256</dt>
                <dd className={`${dd} font-mono text-xs`}>{sidecar.archive.sha256}</dd>
              </>
            )}
            <dt className={dt}>Verification</dt>
            <dd className={dd}>{item.legacy ? "Old format: no checksums to verify" : item.verified ? <><StatusPill status={item.verified.ok ? "verified" : "verification failed"} /> <LocalTime iso={item.verified.at} /></> : "Not verified yet"}</dd>
            {m && (
              <>
                <dt className={dt}>Encryption</dt>
                <dd className={dd}>{m.encryption.encrypted ? `${m.encryption.method}; key ${m.encryption.key}` : "Not encrypted in storage"}</dd>
                <dt className={dt}>Site version</dt>
                <dd className={dd}>moks-cms {m.application.gitSha.slice(0, 12)}, schema {m.application.schemaVersion ?? "—"} ({m.application.migrations} migrations)</dd>
              </>
            )}
          </dl>
          {!sidecar && !item.legacy && <p className="mt-4 text-sm text-fg-muted">This backup has no manifest summary in the bucket (its {name}.json is missing). Verify reads and checks the archive itself.</p>}
        </Card>

        {m?.warnings?.length ? (
          <Card>
            <h2 className="mb-2 font-semibold text-fg">Warnings when it was made</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted [overflow-wrap:anywhere]">{m.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </Card>
        ) : null}

        {m?.database && (
          <Card>
            <h2 className="font-semibold text-fg">Database</h2>
            <p className="mt-1 text-sm text-fg-muted">
              PostgreSQL {m.database.serverVersion.split(" ")[0]} · {m.database.tables} tables · {m.database.rows.toLocaleString("en")} rows · snapshot <LocalTime iso={m.database.snapshotAt} /> · {m.database.secretsRedacted} stored credential(s) replaced by a placeholder
            </p>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold text-fg">Tables and row counts</summary>
              <ul className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 xl:grid-cols-3">
                {m.database.perTable.map((t) => (
                  <li key={t.name} className="flex min-w-0 justify-between gap-3 border-b border-line py-1">
                    <span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{t.name}{t.policy !== "replace" ? ` (${t.policy})` : ""}</span>
                    <span className="shrink-0 tabular-nums text-fg-muted">{t.rows.toLocaleString("en")}</span>
                  </li>
                ))}
              </ul>
            </details>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-semibold text-fg">Not in any backup, on purpose ({m.database.excludedTables.length})</summary>
              <ul className="mt-3 space-y-1 text-sm text-fg-muted">
                {m.database.excludedTables.map((t) => (
                  <li key={t.name} className="[overflow-wrap:anywhere]"><span className="font-mono text-xs text-fg">{t.name}</span>: {t.reason}</li>
                ))}
              </ul>
            </details>
          </Card>
        )}

        {m?.uploads && (
          <Card>
            <h2 className="font-semibold text-fg">Files</h2>
            <p className="mt-1 text-sm text-fg-muted [overflow-wrap:anywhere]">
              {m.uploads.files.toLocaleString("en")} files, {formatBytes(m.uploads.bytes)}: everything under <code className="text-xs">{m.uploads.root}</code> in the media bucket except {m.uploads.excludedPrefixes.map((p) => <code key={p} className="text-xs">{p} </code>)}
              {m.uploads.referencedMissing ? ` · ${m.uploads.referencedMissing} file(s) the database points at were not in the bucket` : ""}
            </p>
          </Card>
        )}

        <Card>
          <h2 className="mb-3 font-semibold text-fg">Checks and restores</h2>
          {checks.length + restores.length === 0 ? (
            <p className="text-sm text-fg-muted">None recorded on this deployment.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {[...checks, ...restores].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).map((r) => {
                const problems = ((r.detail as { report?: { problems?: string[] } }).report?.problems ?? []).slice(0, 5);
                return (
                  <li key={r.id} className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={r.status} />
                      <span className="text-fg">{r.operation === "backup" ? "Verified when it was made" : r.operation === "verify" ? "Verification" : "Restore"}</span>
                      <span className="text-fg-subtle"><LocalTime iso={r.startedAt.toISOString()} />{r.triggeredBy ? ` · ${r.triggeredBy}` : ""}</span>
                    </div>
                    {r.error && <p className="mt-1 text-xs text-red-700 [overflow-wrap:anywhere] dark:text-red-400">{r.error}</p>}
                    {problems.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-fg-muted [overflow-wrap:anywhere]">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {!me.demo && !item.inUse && (
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4 text-sm">
            <ConfirmSubmit action={deleteBackupAction} fields={{ name }} question={`Delete ${name}? It is removed from the bucket for good.`}>
              Delete this backup
            </ConfirmSubmit>
          </div>
        )}
      </div>
    </>
  );
}
