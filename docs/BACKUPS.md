# Site backups

A backup is the whole site in one zip: every table of the PostgreSQL database, every file the site keeps in its storage
bucket, its configuration, a manifest and checksums (D-108, since 2026-11-28). Admin → Backups makes, lists,
downloads, verifies, restores and deletes them. Settings → System → Backups holds the schedule, retention, a size
limit, encryption and the bucket. The CrewAI flow `backup_flow` makes them on a CrewAI schedule. On jithendar.com that
schedule is `website-full-backup`, daily at 02:00 Asia/Kolkata.

Code: `src/lib/backup/` (format, catalog, store, archive, create, verify, restore, service, callbacks),
`src/lib/backups.ts` (settings, and backups of format 1), `src/app/admin/backups/`, `src/app/api/admin/backup/`, the
agent's `seo-agent/app/flows/backup.py`. Tests: `tests/backup-*.test.ts`, `seo-agent/tests/test_backup_flow.py`.

## A complete backup, or metadata only?

| | Full site backup (format 2) | Database only (format 2) | Content only (format 1, before 2026-11-28) |
|---|---|---|---|
| Database | every table (about 140 tables; the policies below) | every table | 12 content tables |
| Files in the bucket | yes, every file under `jithendar/` | no | no (records only, the files stayed in the bucket) |
| Settings, AI & SEO, CrewAI, Practice, invoices… | yes | yes | no |
| Configuration (site.json, config/, metadata) | yes | yes | no |
| Manifest, checksums, signature | yes | yes | no |
| Recovers the site on its own | **yes** (with the deployment's secrets) | with the bucket's files still there | no |

Format 1 named 12 tables in a list (`TABLES` in `lib/backups.ts`) and wrote `backup.json` and `README.txt`. Every
table added after that list was written was missing from it: sign-in methods, Python practice, invoices, all SEO,
news and CrewAI data, and every setting except Appearance. The files themselves were never in it. Format-1 archives
are still listed, downloaded and restored (label "Content only (old format)"), with the rules they were made for.

## What is in the zip

`jithendar-com-backup-2026-11-28-203000-full.zip`. The name says the site, the time (UTC) and the type: `full`,
`database`, or `prerestore` (the safety backup a restore makes first). Everything sits in one folder of the same name:

```text
jithendar-com-backup-2026-11-28-203000-full/
├── README.txt                      what this is and how to restore it (never encrypted)
├── manifest.json                   what the archive holds, the checksum of SHA256SUMS, the site's signature
├── database/
│   ├── schema.json                 tables, columns, keys, foreign keys, policies and row counts at backup time
│   └── tables/<table>.jsonl        every row of the table, one JSON object per line (PostgreSQL to_jsonb)
├── uploads/
│   └── jithendar/www/media/…       every file of the bucket under jithendar/, at its bucket key
├── uploads-index.jsonl             per file: key, size, SHA-256, content type, cache control
├── application/
│   ├── settings.json               every settings row (secrets redacted) and Appearance, readable
│   ├── metadata.json               application version (commit), schema version, Node, site
│   └── site-files/                 site.json and config/*.json as the site ran with them
├── deployment/
│   ├── environment.json            safe values (SITE_URL, APP_ENV …); every other variable by name only
│   ├── kubernetes.json             namespace and pod seen, what is stateful (no volumes: the pods keep nothing)
│   └── restore-requirements.json   schema version, PostgreSQL version, the secrets a recovery needs
└── checksums/
    └── SHA256SUMS                  SHA-256 of every file above (of the content, not of its zip bytes)
```

- **Database.** All tables are read inside one `REPEATABLE READ, READ ONLY` transaction, so the export is one
  consistent snapshot: rows that point at each other always match. Each table is read through a cursor, 1,000 rows
  at a time. The tables come from the PostgreSQL catalog of the schema, not from a list. A table a migration or the
  SEO agent adds is in every backup from the day it exists.
- **Files.** Everything under `jithendar/` in the media bucket is included: the media library, featured and cover
  images, avatars, documents, site images, invoice PDFs and report PDFs. Two prefixes are left out: the backups
  themselves (`jithendar/backups/`) and unaccepted AI images, which expire after a day (`jithendar/www/tmp/`). The
  manifest warns when the database points at a file the bucket does not have. Files are stored without compression,
  because images and videos are already compressed.
- **Not in any backup, on purpose** (manifest `database.excludedTables`, each with its reason):
  - Credentials: `session`, `verification`, `api_key`, `preview`, `seo_mcp_codes`, `seo_mcp_tokens`.
  - State of the running deployment: `job`, `backup_run`, `schema_migrations`, `rate_limit`, `seo_job_locks`,
    `practice_execution_job`.
  - A cache: `seo_llm_cache`.
- **Never leaves the database:** `account.password`, `access_token`, `refresh_token` and `id_token`. Every credential
  the site stores sealed with `SETTINGS_ENCRYPTION_KEY` is replaced by `{"$secret": "redacted"}` wherever it is (the
  manifest counts them). This covers storage, email, Gemini, AI providers, the CrewAI repository token and Practice AI.
- **Encryption** (Settings → System → Backups, on by default). Every file except README.txt is AES-256 encrypted
  inside the zip (WinZip AES) with a key derived from `SETTINGS_ENCRYPTION_KEY`. Nobody types or keeps a passphrase.
- **Signature.** The manifest is signed (HMAC-SHA256, key derived from `SETTINGS_ENCRYPTION_KEY`) and names the
  SHA-256 of SHA256SUMS. SHA256SUMS in turn names every file's SHA-256. An archive changed after it was made, or made by
  another site, does not verify.

## Where backups are stored

In the backup bucket: the media bucket, or a separate private bucket set in Settings → System → Backups (recommended).
They sit under `jithendar/backups/`, and each archive has a sidecar `<name>.json` holding the manifest, the archive's
size and its SHA-256. The bucket is Cloudflare R2, Amazon S3 or any S3-compatible service, reached with the media
storage account (Settings → Media & storage, or `R2_*`/`S3_*` in the Secret).

The archive never touches a pod's disk. The pods have a read-only root and a 64 MiB `/tmp`, and none of their storage
lasts. The zip is streamed to the bucket as a multipart upload in parts of 16 MiB, so one part is in memory at a time,
and an archive can reach about 150 GB. The object only appears once the upload completes, so a half-written archive
never exists. An attempt cut off by a pod stopping leaves an unfinished upload; the next backup aborts it (only one
backup operation runs at a time). Object storage lives outside the cluster, so the backups survive pod restarts and
outlive the cluster itself. A PersistentVolume would do neither: the site runs 2 to 8 replicas, and a volume dies with
its cluster.

Backups are never under `public/` or any URL of the site. Download is the admin route `/api/admin/backup?file=…`
(admins only, never a demo account).

## Making a backup

- **By hand:** Admin → Backups → Full site or Database only → Back up now. The backup is queued and starts within 15
  seconds. The page shows its phase and progress, and Cancel stops it at its next step.
- **On a schedule:** see Scheduling below.
- **Before every restore:** a database backup (type `prerestore`) is made first, automatically.

Each backup runs as a job of the Postgres job queue (`job` kind `backup`), on the worker's own backup loop (every 15 s,
`lib/scheduler.ts`), on whichever replica claims it. It never runs in a request, and it never holds back publishing or
the other jobs. These are the steps (`lib/backup/create.ts`):

1. List the files, measure the database, and refuse to start if the backup would pass the size limit.
2. Export the database snapshot.
3. Add the files.
4. Add configuration and metadata.
5. Write SHA256SUMS and the signed manifest.
6. Complete the upload.
7. Read the whole archive back and verify it: structure, signature, every file's checksum, and the archive's own
   SHA-256. A backup that fails is deleted.
8. Write the sidecar, apply retention, and record the result.

A backup counts as made only after step 7. A storage or network error is tried again (up to 3 attempts, with the job
queue's backoff). The record keeps the reason of each failure, never a secret or database contents.

Every operation is a row of `backup_run`: `operation` is backup, verify or restore; `status` goes pending → running →
completed, failed or cancelled. The row also keeps progress, attempts, the archive name, size and SHA-256, and a
summary. Admin → Backups → Recent activity lists them. Backup, download, verify, restore, delete, cancel and every
settings change are written to the audit log.

## Downloading

Admin → Backups → Download, or the backup's Details page. You always get a zip that any tool opens:

- An encrypted archive is decrypted on the way. It is streamed entry by entry from the bucket, so it never fills
  memory, whatever its size.
- An unencrypted one is passed through as stored.

The download holds personal data (accounts, comments, messages, invoices): keep it private. Check it on your computer:

```sh
unzip jithendar-com-backup-2026-11-28-203000-full.zip
cd jithendar-com-backup-2026-11-28-203000-full
sha256sum -c checksums/SHA256SUMS   # every line must say OK
```

## Verifying

Admin → Backups → Verify (or the Details page) queues a verification. It reads the archive back and checks:

- that every entry is a file this format writes;
- the signature;
- that SHA256SUMS matches the manifest;
- that every file is listed and present, and has the right checksum;
- the archive's SHA-256 against its sidecar.

The result shows as Verified or Verification failed, with the problems on the Details page. A restore runs the same
verification first.

## Restoring

Admin → Backups → the backup → Restore…. The page shows first:

- whether this site signed the archive;
- whether it fits this site (same site; its last migration applied here);
- what will change and what stays.

You choose the database, the files, or both, and type `RESTORE`. The restore runs as a background job
(`lib/backup/restore.ts`):

1. **Verify everything.** An archive that fails is never restored. An archive that is not signed by this site is
   restored only if you tick "Restore it although this site did not sign it", and then nobody gets a staff role from it.
2. **Check compatibility:** same site id; the backup's last migration is applied here (a backup from a newer version
   is refused); the PostgreSQL version.
3. **Make a safety backup** of the current database (`…-prerestore.zip`, listed with the others). Restoring it undoes
   the restore.
4. **Files.** Every file of the archive that the bucket no longer has, or has with another size, is put back at its
   key, with its content type and cache control. Nothing in the bucket is deleted or overwritten.
5. **Database, in one transaction** (all or nothing). Tables go parents first, in the order their foreign keys require:
   - replaced tables: every row deleted, then the backup's rows inserted;
   - `user` and `account`: merged. Missing accounts are added (without a password: they use Forgot password or social
     sign-in). They get their role back only from a signed archive. An existing account is never changed;
   - `audit_log`: only gains entries;
   - sealed credentials: the backup's placeholders take the value the site holds now at the same place. A credential
     set only after the backup was made stays; one the site no longer has must be entered again;
   - account ids are remapped by email when an account exists now under another id;
   - comment replies get their parent once every comment is in;
   - sequences are moved past the restored ids;
   - every replaced table must end with exactly the backup's row count, or nothing is committed.
6. **Clear the caches.** Every replica drops what it cached (content, categories, settings, integrations, practice,
   pages). The result, with counts per table, is on the activity row and in the audit log (severity critical).

**Downtime.** Visitors keep seeing the current site until the database transaction commits: a PostgreSQL DELETE does
not block readers. Saving in the admin may wait while it runs. Scheduled publishing and background jobs pause on every
replica. The SEO agent's own flows are not paused: one that writes during the restore may fail and is retried by its
schedule. This is not zero-downtime for writes.

**If a restore fails** nothing in the database changed: the transaction rolls back. Files already put back stay, but
they are only files that were missing. The activity row says why. Fix the cause and restore again. To undo a restore
that succeeded, restore its safety backup (the activity row and audit entry name it). A restore whose pod stopped
part-way is marked failed and is never restarted on its own.

**Not restored by design:** sessions (everyone signs in again), API keys (issue new ones, for example for
`content.yml`), MCP tokens (clients sign in again), the job queue, and the backup history of the deployment.
`site.json` and `config/` come from the site repository's ConfigMap: the archive keeps a copy for reference only.

## Scheduling

There is one scheduler for backups, never two:

- **CrewAI schedule (jithendar.com).** AI & SEO → Schedules → `website-full-backup` runs `backup_flow` with cron
  `0 2 * * *` in time zone `Asia/Kolkata`, from `crewconfig/schedules/schedules.yaml` in the site's repository (D-101:
  restored on every deploy). The cron runs in the schedule's own time zone, never the node's. Enable, disable, change
  or Run it there. Every run is in Flow runs, with a line per phase and a backup report.
- **Built-in schedule.** Settings → System → Backups: off, daily or weekly at an hour (UTC), full site or database only.
  It stands down while any enabled CrewAI schedule runs `backup_flow` (the settings page says so), so a site without
  the SEO agent still has scheduled backups.

Both go through the same job, so overlapping backups cannot happen: while a backup, verification or restore is queued or
running, the flow's run is skipped (outcome "skipped") and the built-in schedule waits for its next tick. Every replica
ticks; one claims each run under an advisory lock. A run survives the pod that started it: its job lock runs out and
another replica takes it.

### The backup flow (`backup_flow`)

`seo-agent/app/flows/backup.py`; label "Website backup". It has no crew and calls no model: the web app's backup service
does all the work, and the flow only orchestrates, monitors and reports.

1. **start:** `POST /internal/seo-agent/backups/start` queues the same backup as Back up now.
2. **wait:** `GET /backups/runs/{id}` every 15 s, with one log line per phase. The run fails as stalled if a running
   backup stops reporting for 10 minutes (its heartbeat comes every 30 s), or if it does not start within 30 minutes.
3. **report:** the result holds the status, time, archive, size, location, database, media and validation status,
   duration, retention, storage use and any error. `POST /backups/notify` emails it to the SEO report recipients when
   email is set up.

Inputs: `type` (full | database) and `notify` (always | failures | never). The run succeeds only when the web app
reports the backup completed and verified. The report holds names, counts, sizes and states: never contents or a
credential (the web app builds it from its own record).

## Retention

After each successful backup the newest **N of each type** are kept (Settings → System → Backups → Keep the newest; full
site, database only and before a restore are counted apart). If "Delete backups older than" is set, older ones go too.
Two backups are never removed: the newest of each type, and one being verified or restored. Format-1 backups are never
removed automatically; delete them by hand. Admin → Backups shows how many are stored and their total size.

"Largest backup allowed (MB)" refuses to start a backup expected to be larger (database size plus files) and stops one
whose archive passes it; empty means no limit. The pods' disks are never used, so local disk space is never what limits
a backup. Bucket quotas, if the provider has any, are the provider's.

## Recovering the site on a fresh deployment

1. **Restore the deployment's secrets from where they are kept**, never from a backup. Use the same values as before;
   `deployment/restore-requirements.json` lists them:
   - `SETTINGS_ENCRYPTION_KEY` (Secret `jithendar-com-env`). Without the same key, encrypted archives cannot be opened,
     signatures do not verify (you would have to tick "not signed"), and every stored credential must be entered again;
   - `BETTER_AUTH_SECRET`, `ADMIN_BOOTSTRAP_TOKEN` (`jithendar-com-env`);
   - the database credentials (Secret `postgres-db-credentials`, written by Terraform in the miniKube repository);
   - the bucket credentials `R2_*` or `S3_*`;
   - `SEO_AGENT_CALLBACK_TOKEN` and `SEO_AGENT_TOKEN` (`jithendar-com-env`, `seo-agent-env`);
   - the optional Secrets `jithendar-com-crewconfig`, `jithendar-com-rag` and `seo-agent-rag`.
2. **Deploy the same version of the site or a newer one** (jithendar.com `deploy-kubernetes.yml`). The migrations
   create the empty schema.
3. **Sign in** as the bootstrap admin (`ADMIN_BOOTSTRAP_TOKEN`).
4. **Point Settings → Media & storage and Settings → System → Backups at the bucket** (with `R2_*` in the Secret,
   storage is already set). If the backups are in that bucket under `jithendar/backups/`, they are listed. Otherwise
   copy the archive there, for example `aws s3 cp <file>.zip s3://<bucket>/jithendar/backups/` with the R2 endpoint, or
   `rclone copy`. A downloaded copy works as well: it verifies with the same signature.
5. **Admin → Backups → the newest full backup → Restore…**, with database and files ticked.
6. **Afterwards:** people sign in again (sessions are not restored); staff set a password with Forgot password if they
   had one; issue new API keys (for example `JITHENDAR_API_KEY` for `content.yml`); MCP clients sign in again; enter
   any credential the restore reports as cleared.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Turn on the backup destination first" | Settings → System → Backups → Storage bucket: tick "Back up to the storage bucket", Save and test. |
| "Another backup operation is waiting to start / running" | One operation at a time. Wait, or Cancel it on Admin → Backups. |
| Stuck on "Waiting to start" | No replica runs the backup loop: check the pods (`kubectl -n jithendar get pods`) and Loki for `backup schedule tick failed`. |
| "Not started: the backup would be about …" | The size limit. Raise or clear "Largest backup allowed" in Settings → System → Backups. |
| "Attempt N failed (…); it will be tried again" | A storage or network error. It is retried up to 3 times; check the bucket and its credentials if it keeps failing. |
| "The archive failed verification and was deleted" | The bucket returned different bytes than were written. Check the storage service, then back up again. |
| Verification failed on an older backup | The object changed in the bucket (corruption, or someone replaced it). Use another backup; the Details page lists the problems. |
| "encrypted with a key this site does not have" | `SETTINGS_ENCRYPTION_KEY` is not the one the backup was made with. Restore the old key in the Secret. |
| "made by a newer version of the site" | Deploy that version (or newer) first, then restore. |
| Restore failed part-way | Nothing in the database changed (one transaction). Read the reason on the activity row; fix it and restore again. |
| The flow run failed as "stalled" | The backup's pod stopped. The job queue gives it to another replica on its own; the next scheduled run follows. |
| No report email | Email is not set up, or there are no SEO report recipients. The report is in the flow run either way. |

Logs (Loki, `service=jithendar-com`): `backup requested`, `backup finished`, `backup operation failed`, `backup operation
will retry`, `old backups removed`, `scheduled backup queued`, `site restored from a backup`. Traces: `backup backup`,
`backup verify`, `backup restore`. The agent logs (`service=seo-agent`) have `backup_start`, `backup_progress` and
`backup_report`.

## Security

- Admins only, for every page, action, route and callback. A demo account can see the list, but cannot download, make,
  verify, restore, delete or cancel anything.
- Nothing from an archive is executed or written to the disk. Rows go to PostgreSQL as parameters
  (`jsonb_populate_recordset`). Files go to the bucket only under keys that pass `safeObjectKey`: inside `jithendar/`,
  never the backups or the expiring images, no `..`, no control characters.
- An archive with an entry outside its folder, a `..` or absolute path, a symbolic link, two entries of one name, or a
  file this format does not write is refused as a whole: ZIP Slip has no way in.
- The signature covers the manifest; the manifest covers SHA256SUMS; SHA256SUMS covers every file. Whoever can write
  to the bucket cannot make an archive this site accepts as signed. Accounts recreated from an unsigned archive are
  readers.
- Logs and records hold counts, names and states, never rows or secrets. Archive names are not secret; their contents
  are, so keep the bucket private.
