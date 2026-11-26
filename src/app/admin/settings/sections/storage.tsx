import Link from "next/link";
import { SectionHeading } from "@/components/admin/SettingsParts";
import { Card, StatusPill, Table, td, th } from "@/components/admin/ui";
import { Alert, Button, buttonClass } from "@/components/ui/form";
import { adminActor, actorOf } from "@/lib/admin";
import { flash } from "@/lib/flash";
import { migrateBatch, migrationStatus, rollbackMigration } from "@/lib/media-migration";
import { PostError } from "@/lib/posts";
import { requireRole } from "@/lib/session";
import { settingsHref } from "@/lib/settings-areas";
import { MEDIA_ROOT, PROVIDER_LABEL, saveStorageConfig, storageSummary } from "@/lib/storage";
import { StorageForm } from "./StorageForm";

/** Settings → Media & storage (its own page, /admin/storage, until 2026-11-26). */

async function saveStorage(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("media-storage"), async () => {
    const provider = form.get("provider") === "s3" ? "s3" : "r2";
    const r = await saveStorageConfig(actor, {
      provider,
      ...(provider === "s3" ? { region: String(form.get("region") ?? "") } : { accountId: String(form.get("accountId") ?? "") }),
      endpoint: String(form.get("endpoint") ?? ""),
      bucket: String(form.get("bucket") ?? ""),
      publicBaseUrl: String(form.get("publicBaseUrl") ?? ""),
      accessKeyId: String(form.get("accessKeyId") ?? ""),
      secretAccessKey: String(form.get("secretAccessKey") ?? ""),
    });
    if (!r.verified) throw new PostError(`Saved, but the connection test failed, so uploads stay disabled: ${r.error}`);
    return `${PROVIDER_LABEL[provider]} connected. Uploads are enabled.`;
  });
}

async function migrate() {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("move-media"), async () => {
    const { entries, remaining } = await migrateBatch(actor, { dryRun: false, limit: 25 });
    const failed = entries.filter((e) => e.status.startsWith("failed"));
    if (failed.length) throw new PostError(`${entries.length - failed.length} copied, ${failed.length} failed (${failed[0]!.status}). ${remaining} still on S3. Run again to retry.`);
    return `${entries.length} file(s) copied to R2 and verified. ${remaining} still on S3.`;
  });
}

async function rollback() {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("move-media"), async () => `${await rollbackMigration(actor)} file(s) now read from the legacy S3 bucket again.`);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Media storage: Cloudflare R2 or Amazon S3, from the admin or the deployment's Secret. */
export async function MediaStorageSection() {
  const s = await storageSummary();
  const fromEnv = s?.source === "env";
  return (
    <section aria-labelledby="media-storage-title" className="space-y-4">
      <SectionHeading
        id="media-storage-title"
        title={`Media storage${s ? ` (${PROVIDER_LABEL[s.provider]})` : ""}`}
        description="Where media, invoices, backups and the SEO agent's data are stored: Cloudflare R2 or Amazon S3. Keys are encrypted at rest and never shown again."
        aside={<StatusPill status={s?.verifiedAt ? "ok" : s ? "degraded" : "not configured"} />}
      />
      <Card>
        <p className="mb-4 text-sm text-fg-muted">
          Files are stored as <code className="text-xs">{MEDIA_ROOT}/&#123;type&#125;/&#123;yyyy&#125;/&#123;mm&#125;/&#123;id&#125;.&#123;ext&#125;</code> in the bucket.
          Readers always use <code className="text-xs">/media/…</code> links on this site; large videos and documents are redirected to the public URL when one is set.
        </p>
        {fromEnv ? (
          <Alert tone="info">
            Configured by the Kubernetes Secret ({s.provider === "s3" ? "S3_*" : "R2_*"} environment variables): {PROVIDER_LABEL[s.provider]} bucket <strong>{s.bucket}</strong>
            {s.provider === "s3" ? ` in ${s.region}` : ""}, endpoint <span>{s.endpoint}</span>
            {s.publicBaseUrl ? <>, public URL <span>{s.publicBaseUrl}</span></> : ", no public URL (served through the site)"}. Change it in the Secret and redeploy.
          </Alert>
        ) : (
          <StorageForm
            action={saveStorage}
            initial={{
              provider: s?.provider ?? "r2",
              region: s?.region ?? "",
              accountId: s?.accountId ?? "",
              bucket: s?.bucket ?? "",
              accessKeyId: s?.accessKeyId ?? "",
              publicBaseUrl: s?.publicBaseUrl ?? "",
              endpoint: s?.customEndpoint ? s.endpoint : "",
              saved: Boolean(s),
            }}
          />
        )}
      </Card>
    </section>
  );
}

/** Whether "Move media to R2" has anything to do: listed only while files are on the old S3 bucket, or were copied. */
export async function moveMediaAvailable(): Promise<boolean> {
  const m = await migrationStatus();
  return m.legacy > 0 || m.migrated > 0;
}

/** Move media to R2: copy files still read from the old S3 bucket, 25 at a time, with a dry run and a rollback. */
export async function MoveMediaSection(query: Record<string, string | undefined> = {}) {
  const me = await requireRole("admin");
  const [s, migration] = await Promise.all([storageSummary(), migrationStatus()]);
  const plan = query.plan === "1" && migration.legacy > 0 && s?.verifiedAt && migration.sourceConfigured ? await migrateBatch(actorOf(me), { dryRun: true, limit: 25 }) : null;
  return (
    <section aria-labelledby="move-media-title" className="space-y-4">
      <SectionHeading
        id="move-media-title"
        title="Move existing media from S3 to R2"
        description={
          <>
            {migration.legacy} file(s) are still read from the old S3 bucket; {migration.migrated} have been copied to R2. Copying is resumable (25 per run), verified, and never deletes
            anything from S3. Links do not change: posts keep using <code className="text-xs">/media/&#123;id&#125;/…</code>.
          </>
        }
      />
      <Card>
        {!migration.sourceConfigured && <div className="mb-4"><Alert>The legacy S3 configuration is missing, so files cannot be copied or rolled back.</Alert></div>}
        <div className="flex flex-wrap gap-2">
          {migration.legacy > 0 && (
            <Link href={`${settingsHref("move-media")}&plan=1`} className={buttonClass("secondary")}>
              Dry run
            </Link>
          )}
          {migration.legacy > 0 && (
            <form action={migrate}>
              <Button type="submit" disabled={!s?.verifiedAt || !migration.sourceConfigured}>Copy next 25</Button>
            </form>
          )}
          {migration.migrated > 0 && (
            <a href="/api/admin/media-migration" download className={buttonClass("secondary")}>
              Download manifest
            </a>
          )}
          {migration.migrated > 0 && (
            <form action={rollback}>
              <Button type="submit" variant="ghost" disabled={!migration.sourceConfigured}>Roll back to S3</Button>
            </form>
          )}
        </div>
        {plan && (
          <div className="mt-6">
            <p className="mb-2 text-sm font-medium">Dry run: the next {plan.entries.length} file(s) would be copied ({mb(plan.entries.reduce((n, x) => n + x.bytes, 0))}). Nothing was changed.</p>
            <Table head={<tr><th className={th}>Site URL</th><th className={th}>From (S3)</th><th className={th}>To (R2)</th></tr>}>
              {plan.entries.map((x) => (
                <tr key={x.id}>
                  <td className={`${td} whitespace-nowrap font-mono text-xs`}>{x.url}</td>
                  <td className={`${td} whitespace-nowrap font-mono text-xs`}>{x.oldKey}</td>
                  <td className={`${td} whitespace-nowrap font-mono text-xs`}>{x.newKey}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>
    </section>
  );
}
