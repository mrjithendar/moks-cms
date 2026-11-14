# SEO intelligence platform: operations

Deploy, daily sync, backfill, the recommendation workflow, admin guide, troubleshooting, backup and rollback.
First-time Google setup: [MANUAL_SETUP.md](MANUAL_SETUP.md).

## Deployment (Kubernetes)

Nothing new runs in the cluster: the platform lives in the `jithendar-com` Deployment and its existing worker.

1. Merge the PR to `master` (a person). CI builds and pushes `moks-cms:pr-<number>` and rolls the Deployment out on it. On
   start the migrator applies `0011_seo_intelligence.sql` (additive, under the existing advisory lock).
2. `scripts/set-seo-config.sh /path/to/key.json` (a person, `mk4` context): merges `GOOGLE_SEO_SERVICE_ACCOUNT_JSON`
   (and optional `PAGESPEED_API_KEY`) into Secret `jithendar-com-env`, and `SEO_GSC_PROPERTY` / `SEO_GA4_PROPERTY_ID`
   into ConfigMap `jithendar-com-public`. Both are already loaded with `envFrom`, so no manifest change is needed.
3. `kubectl -n jithendar rollout restart deployment/jithendar-com`.
4. Admin → SEO intelligence → Integrations → **Test connection** (must say "connected" for both).
5. Sync history → **Backfill** (see below), then **Generate now** on Recommendations.
6. Alerts: add the group in `services/www/docs/seo/prometheus-alerts.yml` to the miniKube repo's
   `deploy/minikube/observability/prometheus/files/alerts.yml` (see [Alerts](#alerts)).
7. Dashboard: sync the `grafana` Argo CD app; **Jithendar.com · SEO** appears in the Jithendar.com folder.

Resource impact: sync and analysis run in the existing pods (2 × 250m/512Mi requests, 1Gi limit). One run of each type
at a time across replicas (lease); backfills work in 7-day (GSC) / 14-day (GA4) windows and re-enqueue themselves every
~4 minutes, so memory stays bounded by one window of rows. Node capacity on `mk4` is far from the limit (DISCOVERY.md).

Egress: the NetworkPolicy already allows 443 to public addresses (Google APIs, the site's own public URL for the crawler).

## Daily sync

Schedules (UTC, Settings → Schedules): GSC and GA4 daily at 06:00; technical scan, recommendations and the weekly report
on Mondays; monthly report on the 2nd; retention and outcome capture daily. `seoTick()` (at most every 5 minutes per
replica) enqueues each slot once; a slot that already has a run is never re-enqueued, and a missed slot runs as soon as
the site is up again that day.

Each daily run re-fetches the trailing window (default 4 days, Settings → Sync) ending yesterday in Pacific time (GSC) or
the GA4 property's time zone. That corrects provisional data: rows are upserted, and rows Google no longer returns for
that window are pruned. `data_state = provisional` marks days at or after GSC's `firstIncompleteDate`.

**Sync now** (Sync history) queues the same trailing-window run for GSC and GA4.

## Backfill

Manual only (Sync history → Backfill, or `POST /api/admin/seo/sync {"source":"gsc","mode":"backfill","months":16}`).
Up to 16 months (GSC's own limit). Jobs process windows until ~4 minutes have passed, record a `partial` run and enqueue
the rest; watch Sync history until the last slice says `succeeded`. GA4 backfills stop early (status `partial`, error
code `quota`) when the property's token quota runs low; re-run later to continue. Schedules never backfill.

API budget per run: `sync.maxRequestsPerRun` (default 400). A GSC day window costs 3 requests per search type (more when
a report exceeds 25,000 rows).

## Recommendation workflow

1. **Generate** (weekly schedule or Recommendations → Generate now): rules run without an LLM; scores and bands per
   [SCORING.md](SCORING.md). Re-running refreshes pending items, never rejected/approved/implemented ones.
2. **Review**: each item shows the problem, evidence rows (metric, period, value, source), score inputs (and which were
   missing), confidence, qualitative impact and, if enabled, an AI explanation labelled as generated. **Approve** or
   **Reject** (both audit-logged).
3. **Act**: for article items open the article panel → **Generate proposals** → compare current vs proposed →
   **Accept into my draft**. That writes the value into *your* editor working copy (autosave). Open the editor, choose
   **Restore** on the "You have autosaved changes" banner, review, then **Update** / **Publish** as usual (creates a
   revision). **Roll back** in the panel restores your previous working copy; after saving, use the editor's revision
   history to restore an older version.
4. **Mark implemented**: captures the 28-day baseline. The daily `outcomes` job fills days 1–28 and 29–56 after.

Editorial calendar: suggestions (Measured = Search Console data, Editorial idea = speculative) → Approve → **Create draft
post** (a draft via the CMS) → Send to review → the item turns **published** only when a person publishes the linked post.

## Admin guide (sections)

| Section | Use it to |
|---|---|
| Overview | KPIs with source, period, last sync and change vs the previous period |
| Search performance | trends, top pages/queries, devices, countries, gaining/losing pages, low CTR, positions 5–20 |
| Visitor analytics | GA4 sessions (all and organic), landing pages, engagement, channels, devices, countries, new vs returning |
| Page intelligence | every page with GSC + GA4 + article + open recommendations, sortable |
| Keyword opportunities | queries with flags (striking distance, low CTR, several pages ranking) |
| Recommendations | review and track recommendations |
| Content optimization | weakest articles first (audit score) |
| Internal linking | related, unlinked article pairs with reasons |
| Technical SEO | latest crawl: issues by check and severity; Scan now |
| Editorial calendar | month/week view, statuses, drafts |
| Reports | weekly/monthly, CSV, print/PDF, email status |
| Integrations | credentials, properties, connection state, Test connection |
| Sync history | every run; Sync now; Backfill |
| Settings | properties, schedules, weights, thresholds, crawler, LLM, recipients |

States on every data view: skeleton while loading, **Disconnected** (no key or property), **No data yet** (configured,
never synced), **Stale** (last success older than `sync.staleAfterHours`, default 48 h), **Sync error** (last run failed),
and an error panel with a reference if a view fails.

## Troubleshooting

### Sync failures
Sync history shows the error code per run. `not_configured`: set the key / property ids. `locked`: another replica is
running the same job (normal). `budget`: raise `maxRequestsPerRun` or backfill in smaller ranges. `bad_request`: check the
property format (`sc-domain:example.com` or `https://example.com/` with trailing slash). `unavailable`: Google errors
after retries; the next scheduled run retries. For details, search Loki for `event="seo_job_finished"` and the run's
trace id (stored in the run's `detail.traceId`).

### Auth errors
`auth` (HTTP 401/403): the key was revoked/rotated, or the service account lost access. Check the email under
Integrations is a user on the GSC property and a Viewer on the GA4 property; re-run `scripts/set-seo-config.sh` with a
new key if needed, restart, **Test connection**.

### API errors
Persistent 429: lower the schedule frequency or `maxRequestsPerRun`; GA4 quota resets hourly/daily. 5xx: transient,
retried with backoff; persistent errors fire `SeoGoogleApiErrorsPersistent`.

### Other
- Numbers differ from the Search Console UI: Search Console shows Pacific-time days and fresh data; this platform shows
  synced days, and query tables exclude anonymised queries by design (totals do not).
- GA4 sessions ≠ GSC clicks: different measurements (GA4 depends on consent and JavaScript).
- No recommendations: GSC rules need synced data; content rules (outdated tech, quality, links) work without it.
- Technical scan finds nothing: check that `SITE_URL` is the public origin and the site's robots.txt is reachable.

## Alerts

`services/www/docs/seo/prometheus-alerts.yml` (group `jithendar-com-seo`): `SeoSyncConsecutiveFailures` (3 failed daily syncs in
a row), `SeoGoogleAuthError`, `SeoGoogleApiErrorsPersistent`, `SeoDataStale`. Copy the group into the miniKube repo's
`alerts.yml`, then reload Prometheus the way that repo documents. The consecutive-failure and staleness inputs come from
the database (survive restarts).

### Alerts handoff (v5): one file for the miniKube repo

The SEO, agent, ML/RAG and news groups are combined into
[`alerts-for-minikube-repo.yaml`](alerts-for-minikube-repo.yaml) by `python3 scripts/build-alerts.py` (generated; edit
`docs/seo/prometheus-alerts.yml` or `docs/news/prometheus-alerts.yml`, then rerun). CI (`ci-repo.yml`) fails if the file
is stale and validates it with `promtool check rules` (pinned `prom/prometheus:v3.5.0`). Copy step, in the miniKube repo:

1. Open `deploy/minikube/observability/prometheus/files/alerts.yml`.
2. Replace the groups listed in the file's header (append them the first time) with the groups from the generated file.
3. `promtool check rules alerts.yml`, commit, and let Prometheus reload as that repo documents.

This repository never edits the miniKube repo or applies alert rules (D-12).

## Backup and rollback

- **Data**: SEO tables are in the site database and are included in Admin → Backups like every other table. GSC and GA4
  data can also be re-fetched (backfill, up to 16 months back).
- **Application rollback**: revert the merge commit on `master` (CI redeploys). The SEO tables stay and are ignored by
  the old code (additive migration, nothing else changed).
- **Disable without a deploy**: Settings → Schedules → untick every schedule (manual runs still work), or remove the key
  from the Secret and restart (everything shows Disconnected).
- **Remove the tables** (destroys SEO data only; owner decision): take a backup, then
  `psql "$DATABASE_URL" -f services/www/src/db/rollback/0011_seo_intelligence.down.sql`. It also removes the migration's ledger
  row, so a later deploy re-creates empty tables. Also delete the `setting` row `seo` if wanted.
- **Content changes**: proposals only ever land in editor working copies; anything published went through the editor
  and can be restored from its revision history.

---

# v2 operations

## Daily/weekly jobs added by v2 (same worker, same queue)
| Job | When | What |
|---|---|---|
| `drafts_weekly` | Settings → Drafts → weekly (default Tue 04:00 UTC) | Message Batch for the top articles; reserves its estimated cost |
| `drafts_poll` | hourly | applies ended batches; invalid results get one synchronous retry |
| `drafts_digest` | Settings → Drafts → digest (only with recipients) | email of drafts waiting |
| `keywords_refresh` | daily, an hour after the GSC sync | clusters, intents (Haiku, budget-capped), tracked-keyword alerts |
| `seo_draft` / `seo_verify` / `seo_submit` | on demand | generation, post-publish verification, IndexNow/sitemap/inspection |
| scheduled drafts | every 30-s tick | "Publish later" approvals whose time has come |

Budget paused? The search, review and automation admin pages show a red banner; Settings shows month-to-date spend per model. Raise
`SEO_LLM_MONTHLY_BUDGET_USD` or wait for the next UTC month. Stop submissions: `SEO_SUBMISSION_ENABLED=false`.

## Rollback of an approved change
On the draft's page: **Roll back this change** (new revision; history kept), or the editor's revision history if the
article was edited afterwards. Code rollback: revert the merge; the migrations are additive and can stay. Removing
the v2 tables (data loss, owner-approved only): run `src/db/rollback/0014…`, `0013…`, `0012…` in that order.

## E2E (Playwright, local)
Production build + seeded local PGlite + fakes for Claude and IndexNow (Google calls are recorded as "needs
credentials"). Uses the installed Google Chrome; no browser download.
```bash
cd www && npm run build
export E2E_ADMIN_PASSWORD="e2e-$(openssl rand -hex 12)"
NODE_OPTIONS=--conditions=react-server PGLITE_DIR=/tmp/seo-e2e SITE_URL=http://localhost:3100 \
  SETTINGS_ENCRYPTION_KEY=<64 hex> npx tsx scripts/e2e-seed.ts
node e2e/fake-services.mjs &                                  # :3199
PGLITE_DIR=/tmp/seo-e2e SITE_URL=http://localhost:3100 BETTER_AUTH_SECRET=<32+ chars> SETTINGS_ENCRYPTION_KEY=<same> \
  ANTHROPIC_API_KEY=sk-ant-fake ANTHROPIC_BASE_URL=http://localhost:3199 INDEXNOW_ENDPOINT=http://localhost:3199/indexnow \
  INDEXNOW_KEY=0123456789abcdef0123456789abcdef SEO_SUBMISSION_ENABLED=true SEO_SUBMIT_DEBOUNCE_MS=2000 \
  SEO_VERIFY_FETCH_ORIGIN=http://localhost:3100 E2E_WORKER=1 npx next start -p 3100 &
npx playwright test e2e/review-flow.spec.ts e2e/popover.spec.ts
```
`SEO_VERIFY_FETCH_ORIGIN` exists only for this: the SSRF-safe fetcher refuses loopback, so verification would always
fail locally. It is ignored when `APP_ENV=production`.

## Performance and SEO snapshot
Baseline (before Phase 7) and after: `docs/seo/ui-review/lighthouse-*.txt`, screenshots in `docs/seo/ui-review/`.
Both runs use the bundled MDX content with `status: published` in a scratch copy (`CONTENT_DIR`), a production build
and `next start`, Lighthouse 13.5.0 mobile (simulated throttling), median of 3; summary via
`scripts/lighthouse-summary.py`. SEO snapshot: `npx tsx scripts/seo-snapshot.ts --check tests/fixtures/seo-snapshot.json`
or `SEO_SNAPSHOT_CHECK=1 npx playwright test e2e/seo-snapshot.spec.ts` against the same configuration. To snapshot the
real top-20 URLs, set `SEO_SNAPSHOT_URLS` from Search Console and capture against production before a release.
