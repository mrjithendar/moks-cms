import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import { TYPE_LABEL, formatBytes, parseArchiveName } from "@/lib/backup/format";
import { compatibility } from "@/lib/backup/restore";
import { RESTORE_WORD, activeOperation, describeRun, listBackups } from "@/lib/backup/service";
import { backupStore } from "@/lib/backup/store";
import { verifyArchive } from "@/lib/backup/verify";
import { backupPasswords, readBackupConfig } from "@/lib/backups";
import { requireRole } from "@/lib/session";
import { restoreBackupAction } from "../../actions";

export const metadata = { title: "Restore a backup" };
export const dynamic = "force-dynamic";

/** Before a restore: what the archive is, whether it fits this site, what will change and what stays. Nothing runs here. */
export default async function RestorePage({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: FlashParams }) {
  const me = await requireRole("admin");
  const [{ name: raw }, sp] = await Promise.all([params, searchParams]);
  const name = decodeURIComponent(raw);
  const parsed = parseArchiveName(name);
  if (!parsed) notFound();
  const [{ items }, active, c] = await Promise.all([listBackups(), activeOperation(), readBackupConfig()]);
  const item = items.find((i) => i.name === name);
  if (!item) notFound();

  // A quick look (central directory, manifest, signature, SHA256SUMS): the restore itself checks every file again.
  const look = item.legacy || !c.r2 ? null : await verifyArchive(await backupStore(c.r2.bucket), name, { passwords: backupPasswords(c), contents: false }).catch((e: Error) => ({ ok: false, problems: [e.message], signature: "unknown" as const, manifest: null }));
  const m = look?.manifest ?? null;
  const hasUploads = Boolean(m?.components.includes("uploads"));
  const compat = m ? await compatibility(m, { database: true, uploads: hasUploads }) : null;
  const structural = look ? look.problems.filter((p) => !/^the manifest(?: is not signed|'s signature does not match)/.test(p)) : [];
  const blocked = Boolean(active) || me.demo || structural.length > 0 || (compat ? !compat.ok : false);

  return (
    <>
      <AdminHeader
        title="Restore a backup"
        breadcrumbs={[{ href: "/admin/backups", label: "Backups" }, { href: `/admin/backups/${encodeURIComponent(name)}`, label: "Details" }]}
        description="Puts the site back to how it was when the backup was made. Read what changes and what stays before you confirm."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="space-y-6">
        <Card>
          <p className="font-mono text-sm font-medium text-fg [overflow-wrap:anywhere]">{name}</p>
          <p className="mt-1 text-sm text-fg-muted">
            {TYPE_LABEL[item.type]} · made <LocalTime iso={item.createdAt} /> · {formatBytes(item.size)}
            {m?.application.schemaVersion ? ` · schema ${m.application.schemaVersion}` : ""}
          </p>
          {look && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <StatusPill status={look.signature === "valid" ? "verified" : "warning"} />
              <span className="text-fg-muted">{look.signature === "valid" ? "Signed by this site." : look.signature === "missing" ? "Not signed." : "Not signed by this site (another SETTINGS_ENCRYPTION_KEY, or changed)."}</span>
            </div>
          )}
        </Card>

        {active && <Alert tone="info">{`${describeRun(active).replace(/^./, (x) => x.toUpperCase())} is ${active.status === "pending" ? "waiting" : "running"}: a restore can start when it has finished.`}</Alert>}
        {structural.length > 0 && <Alert tone="error">This archive cannot be restored: {structural.slice(0, 3).join("; ")}.</Alert>}
        {compat && !compat.ok && <Alert tone="error">This archive cannot be restored here: {compat.problems.join("; ")}.</Alert>}
        {compat?.warnings.length ? <Alert tone="info">{compat.warnings.join(" · ")}</Alert> : null}

        <Card>
          <h2 className="font-semibold text-fg">What happens</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-fg-muted">
            <li>The whole archive is checked: structure, signature and the checksum of every file. If anything is wrong, nothing is restored.</li>
            <li>The current database is backed up first (a &ldquo;Before a restore&rdquo; backup, listed with the others), so this restore can itself be undone.</li>
            {item.legacy ? (
              <li>Posts, pages, categories, author profiles, comments, messages, media records, redirects and Appearance are replaced with the backup&apos;s (old format: content only, no files).</li>
            ) : (
              <>
                <li>Files: every file of the backup that the bucket no longer has is put back at its address. Nothing in the bucket is deleted or overwritten.</li>
                <li>Database, in one step (all or nothing): every table the backup holds is replaced with its rows.</li>
              </>
            )}
          </ol>
          <h3 className="mt-5 text-sm font-semibold text-fg">What stays as it is now</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-muted">
            <li>Accounts: none is changed or removed; accounts the site no longer has are added back without a password (they use Forgot password or social sign-in){look?.signature === "valid" ? ", with the role they had" : ", as readers (an admin gives staff roles back)"}.</li>
            <li>Sign-in sessions, API keys, MCP tokens and the background job queue.</li>
            <li>Stored credentials (storage, email, AI providers, integrations): the backup holds placeholders; the site keeps the ones it has now. A credential set only after the backup was made stays; one the site no longer has must be entered again.</li>
            <li>The audit log only gains entries. Tables added since the backup are not touched.</li>
          </ul>
          <p className="mt-4 text-sm text-fg-muted">
            <strong className="text-fg">While it runs</strong> (usually a minute or two, longer for many files): visitors keep seeing the current site until the database step commits; saving in the admin may wait; scheduled publishing and background jobs pause. Every server drops its caches when it ends.
          </p>
        </Card>

        <Card>
          <form action={restoreBackupAction} className="space-y-4">
            <input type="hidden" name="name" value={name} />
            {!item.legacy && (
              <fieldset className="min-w-0 space-y-2">
                <legend className="text-sm font-semibold text-fg">Restore</legend>
                <label className="flex items-start gap-2 text-sm text-fg"><input type="checkbox" name="database" defaultChecked className="mt-1" /> The database (content, settings, comments, accounts, AI &amp; SEO data…)</label>
                <label className={`flex items-start gap-2 text-sm ${hasUploads ? "text-fg" : "text-fg-subtle"}`}>
                  <input type="checkbox" name="uploads" defaultChecked={hasUploads} disabled={!hasUploads} className="mt-1" /> The files (media, images, documents){hasUploads ? "" : ": not in a database-only backup"}
                </label>
              </fieldset>
            )}
            {item.legacy && <input type="hidden" name="database" value="on" />}
            {look && look.signature !== "valid" && (
              <label className="flex items-start gap-2 text-sm text-fg">
                <input type="checkbox" name="allowUnsigned" className="mt-1" /> Restore it although this site did not sign it (only if you know where it comes from, e.g. this site before its SETTINGS_ENCRYPTION_KEY changed). Nobody gets a staff role from it.
              </label>
            )}
            <Field label={`Type ${RESTORE_WORD} to confirm`} htmlFor="confirmation">
              <Input id="confirmation" name="confirmation" autoComplete="off" spellCheck={false} required pattern={RESTORE_WORD} className="sm:max-w-xs" />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="danger" disabled={blocked}>Restore this backup</Button>
              <Link href="/admin/backups" className="text-sm link">Cancel</Link>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
