import Link from "next/link";
import { SectionHeading, SeeAlso } from "@/components/admin/SettingsParts";
import { Card, StatusPill } from "@/components/admin/ui";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { flowSchedules } from "@/lib/backup/service";
import { BACKUP_ROOT, backupSummary, saveDestination, saveGeneral, testDestination } from "@/lib/backups";
import { flash } from "@/lib/flash";
import { settingsHref } from "@/lib/settings-areas";

async function general(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("backups"), async () => {
    await saveGeneral(actor, Object.fromEntries(form));
    return "Backup settings saved.";
  });
}

async function destination(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("backups"), async () => {
    await saveDestination(actor, { enabled: form.has("enabled"), bucket: String(form.get("bucket") ?? "") });
    if (form.get("test") === "1") await testDestination(actor);
    return form.get("test") === "1" ? "Backup destination saved and tested successfully." : "Backup destination saved.";
  });
}

/** Settings → System → Backups (the first two cards of Tools → Backups until 2026-11-26, which keeps the backups themselves). */
export default async function BackupsSection() {
  const [b, flows] = await Promise.all([backupSummary(), flowSchedules()]);
  const flowOwns = flows.filter((f) => f.enabled);
  return (
    <section aria-labelledby="backups-title" className="space-y-4">
      <SectionHeading
        id="backups-title"
        title="Backups"
        description="When complete site backups are made (database, files, configuration), how many are kept, whether they are encrypted, and the bucket they go to. They never hold password hashes, sessions, API keys or stored credentials."
      />
      <Card>
        <h2 className="mb-4 font-semibold text-fg">Schedule, retention and encryption</h2>
        {flowOwns.length > 0 && (
          <div className="mb-4">
            <Alert tone="info">
              The CrewAI schedule {flowOwns.map((f) => `${f.name} (${f.cron}, ${f.timezone})`).join(", ")} runs the backup flow, so the built-in schedule below stands down: there is one schedule for backups, never two.
              Change it in <Link href="/admin/crewai/schedules" className="font-semibold underline">AI &amp; SEO → Schedules</Link>; switch it off there to use this one.
            </Alert>
          </div>
        )}
        <form action={general} className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-4">
          <Field label="Built-in schedule" htmlFor="schedule">
            <Select id="schedule" name="schedule" defaultValue={b.schedule}><option value="off">Off (manual only)</option><option value="daily">Daily</option><option value="weekly">Weekly</option></Select>
          </Field>
          <Field label="Hour (UTC)" htmlFor="hourUtc" hint="21 UTC = 02:30 IST"><Input id="hourUtc" name="hourUtc" type="number" min={0} max={23} defaultValue={b.hourUtc} /></Field>
          <Field label="A scheduled backup holds" htmlFor="scheduleType">
            <Select id="scheduleType" name="scheduleType" defaultValue={b.scheduleType}><option value="full">The whole site (database + files)</option><option value="database">The database only</option></Select>
          </Field>
          <Field label="Keep the newest" htmlFor="retention" hint="Per type: full, database only, before a restore."><Input id="retention" name="retention" type="number" min={1} max={365} defaultValue={b.retention} /></Field>
          <Field label="Delete backups older than (days)" htmlFor="maxAgeDays" optional hint="Empty: no age limit. The newest of each type is always kept."><Input id="maxAgeDays" name="maxAgeDays" type="number" min={1} max={3650} defaultValue={b.maxAgeDays ?? ""} /></Field>
          <Field label="Largest backup allowed (MB)" htmlFor="maxSizeMb" optional hint="Empty: no limit. A backup expected to be larger does not start."><Input id="maxSizeMb" name="maxSizeMb" type="number" min={1} defaultValue={b.maxSizeMb ?? ""} /></Field>
          <div className="space-y-1 xl:col-span-4">
            <label className="flex items-center gap-2 text-sm font-medium text-fg">
              <input type="checkbox" name="encrypt" defaultChecked={b.encrypt} /> Encrypt backups stored in R2 (AES-256)
            </label>
            <p className="text-sm text-fg-muted">
              There is no passphrase: backups are encrypted with a key derived from the server&apos;s <code className="text-xs">SETTINGS_ENCRYPTION_KEY</code> (the
              Kubernetes Secret), so they restore here even after the database is lost, as long as that secret is kept. <strong>Download</strong> always gives you an
              unencrypted copy you can open with any zip tool: keep it private. Off: backups are stored as plain zips, so keep the bucket private.
              {b.legacyPassphrase ? " A passphrase set before 2026-11-18 is still kept, only to restore the older backups made with it." : ""}
            </p>
          </div>
          <div className="xl:col-span-4"><Button type="submit">Save</Button></div>
        </form>
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold text-fg">Storage bucket (Cloudflare R2 or Amazon S3)</h2><StatusPill status={b.r2?.enabled ? "ok" : b.r2 ? "read" : "not configured"} /></div>
        <p className="mb-4 text-sm text-fg-muted">
          Backups use the storage account and keys from <Link href={settingsHref("media-storage")} className="link">Settings → Media &amp; storage</Link> (Cloudflare R2 or Amazon S3) and are written to{" "}
          <code className="text-xs">{BACKUP_ROOT}/</code> in the bucket below. A separate private bucket is recommended: anything in a bucket with a public custom domain can be
          fetched by URL (backups are encrypted, but keep them private anyway). The key must be able to read and write objects in that bucket.
        </p>
        {!b.storageReady && (
          <div className="mb-4"><Alert tone="info">Media storage (Cloudflare R2 or Amazon S3) is not configured yet. <Link href={settingsHref("media-storage")} className="font-semibold underline">Set it up</Link> first.</Alert></div>
        )}
        <form action={destination} className="grid gap-4 sm:grid-cols-2">
          <Field label="Bucket (optional)" htmlFor="r2-bucket" hint="Leave empty to use the media bucket.">
            <Input id="r2-bucket" name="bucket" defaultValue={b.r2?.bucket ?? ""} placeholder="jithendar-backups" autoComplete="off" spellCheck={false} />
          </Field>
          <label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" name="enabled" defaultChecked={b.r2?.enabled ?? true} /> Back up to the storage bucket</label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" name="test" value="0" variant="secondary" disabled={!b.storageReady}>Save</Button>
            <Button type="submit" name="test" value="1" disabled={!b.storageReady}>Save and test</Button>
          </div>
        </form>
      </Card>

      <SeeAlso href="/admin/backups">Tools → Backups: back up now, download, verify, restore and delete</SeeAlso>
    </section>
  );
}
