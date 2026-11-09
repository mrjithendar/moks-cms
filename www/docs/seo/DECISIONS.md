# SEO intelligence platform: decisions and deviations

Each entry: what the brief asked, what the repository actually has, what was done and why.

## D-01 Commits and the PR, despite `AGENTS.md` rule 12
`www/AGENTS.md` says agents leave changes uncommitted. The owner's brief for this project explicitly asks for one
commit per phase on `feature/ai-seo-intelligence-platform` and a PR. The brief is the more specific, more recent
instruction, so commits are made **only on the feature branch**. Nothing is merged, force-pushed or deployed;
`master` is untouched.

## D-02 No Kubernetes CronJobs; the existing in-process worker schedules SEO jobs
The repo has a Postgres job queue (`src/lib/jobs.ts`) and a 30-second worker in every replica
(`src/lib/scheduler.ts`), and no CronJobs. Adding CronJobs would mean a second scheduler, a second container
entrypoint and new RBAC. Instead, `seoTick()` runs inside the existing worker: it checks the schedules stored in
the SEO settings, **enqueues** due jobs into the existing `job` table with a per-slot `dedupe_key`, and each
SEO job takes a **per-job-type lease** in Postgres before running. That gives the same guarantee as
`concurrencyPolicy: Forbid` (one run per type across both replicas) with no new workload.

Why a lease row (`seo_job_locks`) rather than `pg_try_advisory_lock`: the app talks to Postgres through a
postgres.js pool (up to 5 connections) behind PgBouncer. A session-level advisory lock is held by whichever pooled
connection ran the `SELECT`, and the matching unlock may run on a different connection, where it silently does
nothing, leaking the lock until that connection closes. A transaction-level lock would have to hold a transaction
open for the whole sync, which deadlocks PGlite (tests, local dev). The lease is acquired with one atomic
`INSERT … ON CONFLICT DO UPDATE … WHERE locked_until < now()`, released by holder id, renewed while a long run
progresses, and expires on its own if a pod dies mid-run.

## D-03 Docs live in `www/docs/seo/`, not `docs/seo/`
All project docs are in `www/docs/`; there is no root `docs/` folder.

## D-04 `audit_log` instead of a new `seo_audit_logs` table
`audit_log` already records actor, action, target, detail (before/after), IP, user agent and severity, and is
browsable and exportable in Admin → Audit log. SEO mutations write `seo.*` actions there.

## D-05 `setting` row `seo` instead of a `seo_settings` table
Every other feature keeps its settings as one validated JSON document in the `setting` table (practice,
integrations, email), with cross-replica cache invalidation (`cache-bus`). SEO settings (weights, schedules,
thresholds, recipients, LLM provider, property ids) follow the same pattern.

## D-06 "Accept" writes to the editor's working copy, never to the post
The CMS has versioning (`revision` = committed snapshots, `autosave` = one uncommitted working copy per user and
post). `updatePost` on a published post changes the live page at once, so the SEO platform **never calls
`updatePost` or `publishPost`**. Accepting a proposed edit writes it into the accepting admin's `autosave` copy
(based on their existing working copy if there is one). The editor then shows its existing "You have autosaved
changes … Restore / Discard" banner; a human restores, reviews the diff and presses Update/Publish. Rollback:
before commit, "Discard" (or Reject in the SEO panel, which restores the previous working copy); after commit,
the editor's existing revision restore. A test asserts that no SEO module imports a publishing function.

## D-07 Google APIs over REST with a hand-signed service-account JWT (no `googleapis` dependency)
Only three Google endpoints are needed (Search Analytics `query`, Analytics Data `runReport` /
`checkCompatibility`, optionally URL Inspection). OAuth for a service account is a single RS256 JWT exchange,
done with `node:crypto`. `googleapis` (~100 MB installed) would be the largest dependency in the app for that.
The key comes only from the environment (`GOOGLE_SEO_SERVICE_ACCOUNT_JSON`, in the existing `jithendar-com-env`
Secret); it is never stored in the database, logged, returned by an API, or sent to an LLM.

## D-08 No Helm chart / Argo CD app changes
The site is deployed with Kustomize by a person (`./deploy.sh`), not Argo CD; there is no Helm chart. Since no new
workload is added (D-02) and egress to Google (443) is already allowed, **no manifest change is required**. The
property ids are optional ConfigMap/Secret entries set with a new helper script, `scripts/set-seo-config.sh`, in
the style of the existing `set-*-config.sh` scripts.

## D-09 Reports: CSV + printable HTML instead of a PDF library
There is no PDF generation in the repo. Reports are exportable as CSV and as a print-optimised HTML page
(`/admin/seo/reports/{id}/print`) that the browser saves as PDF. Adding a headless browser or PDF library to the
image was not justified for a weekly admin report.

## D-10 Charts are dependency-free SVG
There is no chart library; the practice dashboard uses small accessible SVG components. The SEO dashboard follows
that pattern (`src/components/seo/Charts.tsx`).

## D-11 Migration rollback
The migrator is forward-only. The SEO migration is purely additive (`CREATE TABLE IF NOT EXISTS`, no changes to
existing tables). A matching rollback script is kept in `src/db/rollback/0011_seo_intelligence.down.sql`
(never applied automatically), and a test applies up → down → up on a clean PGlite database. Running the down
script in production deletes SEO data only, so it is a manual, owner-approved step (see BACKUP_ROLLBACK in
`OPERATIONS.md`).

## D-12 Alert rules are delivered as a snippet
Prometheus rules live in the separate `miniKube` repository. The SEO rules are provided in
`www/docs/seo/prometheus-alerts.yml` in the same format, for a human to add to that repo's `alerts.yml`.

## D-13 Internal-link relatedness without embeddings
No embedding store exists. Relatedness uses shared GSC queries (when synced), shared tags, category, and
configured related-category pairs. Adding a vector store was not justified.

## D-14 GA4 compatibility: tested allowlist plus an on-demand check
Every report the sync requests uses a fixed dimension/metric combination listed in `GA4_REPORTS`. "Test connection"
calls `checkCompatibility` for each of them against the live property, so an incompatible combination is reported
before a sync runs. The sync does not call it on every run (quota).

## D-15 `seo_url_map.article_id` references `post.id`
Bundled MDX articles that were never imported into the database have no `post` row; their URLs are still mapped
(by path) with a null `article_id`, as the brief allows. FKs use `ON DELETE SET NULL` because posts can be
permanently deleted from the trash.

## D-16 LLM settings are separate from the practice tutor's
The SEO platform reuses `callModel()` but has its own provider/model/key (sealed) in the `seo` settings,
**disabled by default**, so turning on SEO enrichment never changes the tutor's behaviour or budget.
