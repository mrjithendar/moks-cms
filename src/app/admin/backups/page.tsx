import { LocalTime } from "@/components/LocalTime";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, StatusPill, Table, td, th } from "@/components/admin/ui";
import { Button, buttonClass } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { backupSummary, isLegacyBackup, listStoredBackups, recentRuns, restoreStoredBackup, runBackup } from "@/lib/backups";
import { RestoreButton } from "./RestoreButton";
import { flash } from "@/lib/flash";
import { PostError } from "@/lib/posts";
import { requireRole } from "@/lib/session";
import { settingsHref } from "@/lib/settings-areas";
import { SettingsElsewhere } from "@/components/admin/SettingsParts";

export const metadata = { title: "Backups" };

async function restore(form: FormData) {
  "use server";
  const actor = await adminActor();
  const name = String(form.get("name") ?? "");
  await flash("/admin/backups", async () => {
    const r = await restoreStoredBackup(actor, name);
    const n = (k: string) => r.restored[k] ?? 0;
    return `Restored ${name}: ${n("post")} posts, ${n("page")} pages, ${n("comment")} comments, ${n("media")} media records${r.usersAdded ? `, ${r.usersAdded} account(s) recreated` : ""}. The previous state was saved as ${r.safetyBackup}.${r.rolesNotRestored ? ` ${r.rolesNotRestored} recreated account(s) had a staff role in the backup and are readers now: give the roles back in Users (the audit log entry names them).` : ""}`;
  });
}

async function runNow() {
  "use server";
  const actor = await adminActor();
  await flash("/admin/backups", async () => {
    const r = await runBackup("manual", actor);
    if (r.status === "failed") throw new PostError(`Backup failed: ${r.results.map((x) => x.detail).join("; ")}`);
    return `Backup ${r.status}: ${r.results.map((x) => `${x.destination} ${x.ok ? "✓" : "✗ " + x.detail}`).join(", ")}`;
  });
}

export default async function BackupsPage({ searchParams }: { searchParams: FlashParams }) {
  const me = await requireRole("admin");
  const [b, runs, stored, sp] = await Promise.all([backupSummary(), recentRuns(), listStoredBackups().catch(() => null), searchParams]);
  return (
    <>
      <AdminHeader
        title="Backups"
        description="Zip backups of content and configuration, encrypted in storage with the server's key: no passphrase to keep. Excludes password hashes, sessions, API-key hashes and stored credentials."
        actions={
          <>
            <form action={runNow}><Button type="submit">Back up now</Button></form>
            {/* A demo account never downloads the database (the route refuses it too). */}
            {!me.demo && <a href="/api/admin/backup" download title="An unencrypted copy: keep it private" className={buttonClass("secondary")}>Download backup</a>}
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="space-y-6">
        {stored && stored.length > 0 && (
          <div>
            <h2 className="font-semibold text-fg">Latest backups in R2</h2>
            <p className="mb-3 mt-1 text-sm text-fg-muted">
              The newest 10{stored.length > 10 ? ` of ${stored.length}` : ""}. Restore replaces content and settings with the backup in one step; the current state is backed up to R2 first.
            </p>
            <Table head={<tr><th className={th}>File</th><th className={th}>Size</th><th className={th}>Stored</th><th className={th}><span className="sr-only">Actions</span></th></tr>}>
              {stored.slice(0, 10).map((f) => (
                <tr key={f.key}>
                  <td className={`${td} font-mono text-xs`}>{f.name}</td>
                  <td className={`${td} whitespace-nowrap`}>{Math.round(f.size / 1024)} KB</td>
                  <td className={`${td} whitespace-nowrap`}>{f.lastModified ? <LocalTime iso={f.lastModified} /> : "—"}</td>
                  <td className={td}>
                    <div className="flex items-center gap-4 whitespace-nowrap">
                      {!me.demo && <a className="link" href={`/api/admin/backup?file=${encodeURIComponent(f.name)}`} download title="An unencrypted copy: keep it private">Download</a>}
                      {/* Older .json.gz.enc backups need the passphrase they were made with. */}
                      {(b.legacyPassphrase || !isLegacyBackup(f.name)) && <RestoreButton name={f.name} created={f.lastModified ?? f.name} action={restore} />}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        )}

        <div>
          <h2 className="mb-3 font-semibold text-fg">Recent runs</h2>
          <Table head={<tr><th className={th}>Started</th><th className={th}>Trigger</th><th className={th}>Status</th><th className={th}>File</th><th className={th}>Destinations</th></tr>}>
            {runs.length === 0 && <tr><td className={td} colSpan={5}>No backups yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td className={`${td} whitespace-nowrap`}><LocalTime iso={r.startedAt.toISOString()} /></td>
                <td className={td}>{r.trigger}</td>
                <td className={td}><StatusPill status={r.status === "success" ? "ok" : r.status === "partial" ? "degraded" : r.status === "running" ? "pending" : "down"} /></td>
                <td className={`${td} font-mono text-xs`}>{r.filename ?? "—"}{r.sizeBytes ? ` (${Math.round(r.sizeBytes / 1024)} KB)` : ""}</td>
                <td className={`${td} text-xs`}>{r.results.map((x) => `${x.destination}: ${x.ok ? "ok" : x.detail}`).join(" · ")}</td>
              </tr>
            ))}
          </Table>
        </div>
      </div>
      <SettingsElsewhere href={settingsHref("backups")}>
        schedule {b.schedule === "off" ? "off (manual only)" : `${b.schedule} at ${String(b.hourUtc).padStart(2, "0")}:00 UTC`}, keep the last {b.retention}, {b.encrypt ? "encrypted" : "not encrypted"}. Change them in Settings → System → Backups.
      </SettingsElsewhere>
    </>
  );
}
