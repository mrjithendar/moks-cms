# SEO intelligence platform: decisions and deviations

Each entry: what the brief asked, what the repository actually has, what was done and why.

## D-01 Commits and the PR, despite `AGENTS.md` rule 12
`services/www/AGENTS.md` says agents leave changes uncommitted. The owner's brief for this project explicitly asks for one
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

## D-03 Docs live in `services/www/docs/seo/`, not `docs/seo/`
All project docs are in `services/www/docs/`; there is no root `docs/` folder.

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
`services/www/docs/seo/prometheus-alerts.yml` in the same format, for a human to add to that repo's `alerts.yml`.

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

## D-17 No CI workflow change
New tests live in `services/www/tests/` and run in the existing `npm test` step of `ci-jithendar-com.yml` (PR `check` job).
Dependency scanning already exists: Dependabot version and security updates for npm, Terraform and Actions
(`.github/dependabot.yml`). The project adds **no npm dependency**, so nothing new needs scanning. `npm audit` was run
locally in Phase 9 and its result is reported, but it is not added as a blocking CI step (it would fail on
pre-existing advisories unrelated to this work).

## D-18 Restart-safe alert inputs
Process counters reset on restart and are per replica, so "N consecutive failures" cannot be computed from them.
`seo_sync_consecutive_failures` and `seo_sync_last_success_timestamp_seconds` are gauges computed from
`seo_sync_jobs` at scrape time (cached 30 s with the other database gauges); alerts use them.

## D-19 Log correlation
The cluster's log collector keeps only allowlisted fields (`event`, `operation`, `outcome`, `errorCode`, `traceId`, …),
so a `correlationId` field would be dropped before Loki. Runs log `operation=seo_<job>` and `outcome`, and every job run
is inside a trace (`job seo` span); the run's `correlation_id` and `traceId` are stored on its `seo_sync_jobs` row,
which links the dashboard's Sync history to Loki/Jaeger.

## D-20 Grafana dashboard
`services/grafana/jithendar-com-seo.json` (uid `jithendar-com-seo`) is added to the existing folder synced by the shared
`grafana` Argo CD app. It only reads metrics/logs this site already exports. Like the other dashboards, it is loaded
after merge and an Argo CD sync of the `grafana` app (a person does that).

---

# v2 (branch `feature/seo-v2-drafts-review-ui`, from `feature/ai-seo-intelligence-platform` @ `ee8ab6c`)

## D-21 Approval publishes through the CMS's own update path (supersedes D-06 for approved drafts only)
v1 never wrote `post` (D-06). v2's brief asks that an explicit "Approve & publish" makes the page live. Automation
still stops at `ready_for_review`: generation, validation, merging and the weekly batch never write `post` (a static
test enforces this for every SEO module except `publish.ts`). Only `publish.ts`, called from the admin-only approve
route (same-origin, rate-limited, audit-logged) or from a schedule the admin set, calls `updatePost` with the
approving admin as actor and the draft's `base_version` as optimistic-concurrency guard. That is the same function
the editor's "Update" button uses, so permission checks, validation, revision history, redirects, IndexNow and cache
invalidation all apply unchanged.

## D-22 Claude is one more provider of `callModel`, via the official SDK
`@anthropic-ai/sdk@1.3.0` (released 2026-10-23, older than two weeks at install) is added as `provider: "anthropic"`
in `src/lib/practice/ai/providers.ts` (implementation in `anthropic.ts`). The SEO-specific parts (pricing, the
monthly cap, usage rows, Message Batches) live in `src/lib/seo-intel/claude.ts` and reuse the same client factory and
request builder, so there is one AI layer. The tutor's provider list (`AI_PROVIDERS`) is unchanged: Claude is not
offered to the Python-practice tutor by this work. The v1 SEO enrichment (`llm.ts`) can now also select Claude.

## D-23 The API key is a secret reference only
`ANTHROPIC_API_KEY` comes from the existing `jithendar-com-env` Secret. Unlike the v1 LLM key, it cannot be saved in
the database (no sealed copy), never appears in settings, logs or API responses.

## D-24 Structured output via `output_config.format`, validated twice
Every Claude response uses a JSON schema (`MODEL_OUTPUT_JSON_SCHEMA`) and is then validated server-side with zod and
the change-set validators (block exists, `before` matches exactly once, code untouched, no invented URLs, …). Any
schema or semantic failure triggers exactly one retry, with the validator's messages as feedback; a second failure
marks the draft `generation_failed` with the reason. Soft problems (lengths, unsourced technical detail, large
rewrites) do not retry; they become flags the reviewer sees.

## D-25 Internal links are never written by Claude
Claude may not add internal links (a validator rejects them). Links come only from the deterministic planner
(Phase 4), whose limits are testable and auditable. They are reviewed like any other change.

## D-26 Budget: hard cap from the environment, estimated before each call
`SEO_LLM_MONTHLY_BUDGET_USD` (default $10 when unset) is a ceiling the settings can lower but not raise. Before every
synchronous call and every batch, an upper-bound estimate (input characters / 3.5, full `max_tokens`) is checked
against month-to-date spend plus batch reservations; when it would cross the cap, nothing is sent, the draft records
"Paused", the weekly job reports `skipped/budget` and every `/admin/seo` page shows a banner. Prices are first-party
list prices (Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per MTok; cache reads 0.1×, writes 1.25×; batches −50 %),
overridable with `SEO_LLM_PRICES_JSON`. Unknown models are priced at the most expensive known rate.

## D-27 Weekly generation uses Message Batches; "regenerate now" uses the synchronous API
The weekly job submits one batch (custom_id `d_<draftId>`), reserves its estimated cost, and an hourly
`drafts_poll` job applies results. A batch result that fails validation gets its single retry through the
synchronous API. The Batches API rejects `fallbacks`, so batch requests carry none; synchronous Sonnet/Opus calls use
the server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
User-triggered generation runs as a `seo_draft` job in the existing queue, so the request returns immediately.

## D-28 Style guide is generated, and also compiled into the app
`scripts/seo-style-guide.ts` measures the articles and writes `docs/seo/STYLE_GUIDE.md` plus
`src/lib/seo-intel/style-guide.ts` (same text), because `docs/` is not in the runtime image. It is the second cached
system block (after the rules), so it is billed at cache-read rates after the first call in a 5-minute window.

## D-29 `seo_audit_logs` → the existing `audit_log` (D-04 continues)
Every v2 action (generate, decide change, approve, schedule, publish, verify, submit, rollback, reject) is written to
`audit_log` as `seo.draft.*` / `seo.submission.*`, like v1.

## D-30 News articles
News drafts are generated like blog drafts but with their own category set (default: title/meta, alt text, internal
links — no body rewrites of reported facts) and appear in a separate News tab of the queue and recommendations.

## D-31 Submission only after verification; the editor's IndexNow ping only on visible changes
`updatePost` gained `notifySearchEngines: false` so an approved draft is submitted only after the live page passed
verification (the existing hook would otherwise ping IndexNow before the check). Independently, the existing
editor hook now skips saves that change no visible field, and goes through the batched submission log instead of one
job per URL. Legacy queued `indexnow` jobs still drain through the old handler.

## D-32 No Google Indexing API; sitemap resubmission needs Full permission
See SUBMISSION.md. The write scope is requested only for `sitemaps.submit`; syncs stay read-only.

## D-33 IndexNow key generated automatically, unless turned off
The first SEO submission generates a key (via the existing Admin → Integrations code path, audit-logged) when none
exists. If an admin turned IndexNow off, it stays off.

## D-34 Link relevance uses TF-IDF, not embeddings
There is no embedding store (v1 D-13). TF-IDF over title/headings/body plus shared GSC queries, category and tags.

## D-35 Popover built in-repo
The brief asks for the existing UI library's Popover/HoverCard; the repo has none (only a modal Dialog). A small
accessible Popover (`components/seo/Popover.tsx`) implements hover (mouse only) / focus as tooltip with
`aria-describedby`, click/tap as non-modal dialog with focus trap, Esc everywhere.

## D-36 Keyword data is Search Console only
No search volume or keyword difficulty columns: no licensed third-party source is configured. Expected CTR comes from
the site's own curve (positions with < 200 impressions in 90 days use the v1 yardstick, and the page says how many).

## D-37 Admin CSS split from public CSS
The new admin UI added ~20 KB of utilities to the single render-blocking stylesheet that public pages load, and the
first "after" Lighthouse run showed it (article LCP +2 %, consistent across runs). `globals.css` now excludes
`components/seo` and `app/admin/seo` with `@source not`; those get `app/admin/seo/seo.css`, loaded only by the SEO admin
layout. The theme moved verbatim to `theme-tokens.css` so both stylesheets share it.

## D-38 E2E-only verification origin
`SEO_VERIFY_FETCH_ORIGIN` lets a local E2E run verify against `http://localhost:…` (the SSRF-safe fetcher refuses
loopback by design). Ignored when `APP_ENV=production`; only `localhost` / `127.0.0.1` accepted.

## D-39 The SEO snapshot URLs
The brief asks for the 20 most-trafficked URLs; there is no traffic data locally. The committed snapshot covers the home
page, the indexable category pages and the newest articles of the bundled content (20). `SEO_SNAPSHOT_URLS` takes the
real top 20 from Search Console for a production check.

## D-40 Public-site additions that were already there
Reading width (~70ch), skip link, reading time, "Updated" date, author box, breadcrumbs + BreadcrumbList, copy button and
language label, mobile TOC, instant search and self-hosted fonts with `font-display: swap` already existed and were left
as they were. Added: fence-meta filenames and line highlighting (opt-in; existing articles render unchanged),
TOC scroll-spy (~1 KB), related reading from the internal-link graph, series/topic previous-next, category "Start here"
hub row. Nothing in metadata, JSON-LD, canonicals, sitemap or robots changed (snapshot test).

---

# v3 (branch `feature/seo-v3-orchestration`, from master `b08d54a`)

## D-41 Library versions and the two-week rule
The brief asks for the latest stable releases. The v1/v2 rule is the newest stable release that's at least two weeks
old at install time. On 2026-11-10 that gives `langgraph==1.2.18`, `langgraph-checkpoint-postgres==3.2.0`
(`langgraph-checkpoint` 4.3.1), `langchain-core==1.7.0`, `langchain-anthropic==1.7.6` (anthropic SDK 1.17.0),
`langchain-text-splitters==1.1.3`, `crewai==1.15.30` (pydantic 2.12.5, which crewai caps below 2.13),
`fastapi==0.162.0`, `uvicorn==0.54.0`, `psycopg[binary]==3.3.6`, `psycopg-pool==3.3.3`, `onnxruntime==1.31.1`,
`tokenizers==0.23.3`, `numpy==2.5.4`, `prometheus-client==0.26.0`, `opentelemetry-sdk`/`-exporter-otlp-proto-http`
1.45.1, Python 3.13 (crewai needs < 3.14 and numpy ≥ 3.12). The direct pins are exact, and `uv.lock` pins all 177.
`tool.uv.exclude-newer = "2 weeks"` applies the same rule to transitive dependencies on every re-lock, Dependabot's
included (cooldown 14 days). API names were checked against the installed packages: `interrupt`, `Command(resume=)`,
`RetryPolicy`, `AsyncPostgresSaver`, `with_structured_output(include_raw=True)`, and CrewAI `Agent`/`Task`/`Crew`/
`Process.sequential`/`BaseLLM.call`. pip-audit's own dependencies conflict with crewai's `tomli-w` pin, so CI runs
it in isolation (`uvx`) on the exported production lock.

## D-42 A Python service, `services/seo-agent`
CrewAI is Python-only, and the backend is Next.js/TypeScript, so the agent layer is a separate FastAPI service, as
the brief planned. It has one replica and a ClusterIP Service only. Service-to-service auth uses bearer tokens from
Secrets. Istio STRICT mTLS already encrypts the hop, but every pod here runs as the `default` service account, so mTLS
identity can't tell the site from other pods. Two tokens are used, one per direction, so a leak in one direction
doesn't give the other.

## D-43 The approval gate lives in the web app
The brief keeps human approval as the only way to publish. Trusting the agent's `approve` decision wouldn't be
enough, because anything that can call `/runs/{id}/resume` could forge one. So the admin approve route records an
approval (`seo_draft_approvals`: approver, exact accepted change ids, expiry, single use), and the agent's publish
callback goes through `publishWithApproval`, which re-checks all of it plus "approver still admin". The agent's
writes are limited to its own drafts, with every change saved as `pending`. The static no-publish test now also scans
`src/lib/seo-agent`, and `publishNewArticle` was added to the allowed callers of `updatePost`.

## D-44 v2 code is called, not reimplemented: a callback API on its own port
Prompts, validators, the link planner, publish/verify/submit and the SSRF-safe fetcher are TypeScript. The agent
calls them through `/internal/seo-agent/*`, which is served by a separate listener in the web process (port 9465,
like the metrics port). It has a `jithendar-com-internal` Service that the VirtualService never routes, a
NetworkPolicy that admits only `seo-agent`, and a token compared in constant time. A contract test checks every client
call against the parsed route table. Agent documentation fetches go through the same SSRF-safe fetcher with a
documentation allowlist, so the agent itself needs internet egress only for the Anthropic API.

## D-45 Direct SQL for pgvector, and a custom chunker
`langchain-postgres` (0.0.19) owns its table layout. The brief's `seo_article_chunks` needs an article foreign key,
heading path, anchor and content hash, and the column dimension follows the embeddings model. Direct SQL is simpler,
so `langchain-postgres` isn't installed. LangChain is still used for the model wrapper (`langchain-anthropic`,
`langchain-core` messages) and LangGraph. LangChain's `MarkdownHeaderTextSplitter` was tried and dropped: it removes
blank lines, so paragraph boundaries are lost, and it can't tell repeated headings apart, which breaks rehype-slug's
`-1` anchors. Both were caught by tests. `seo_article_chunks` is created by `seo-agent` when the extension exists,
not by the web app's migrations.

## D-46 No Message Batches inside graphs
`weekly_recommendations` fans out to `optimize_article` children. Each child needs its model answer inline
(validate → one retry → human_review), and a batch result can take up to 24 hours. Children therefore use the
synchronous API with prompt caching, with concurrency capped at 2. The legacy path keeps Batches (−50 %); the
difference is about $1 a month at the current size (COSTS.md).

## D-47 CrewAI's unused stores
crewai 1.15 hard-requires chromadb and lancedb for memory features this service never enables (`memory=False`).
lancedb (with pyarrow, ~290 MB) is excluded with a uv override marker that never matches; a test asserts it isn't
installed. chromadb stays because crewai imports it at load. The production venv went from 761 to 469 MB.

## D-48 Ask-the-Blog spend is separate from the admin budget
The brief asks for a daily public cap separate from the admin budget. Public rows (purpose `ask…`) are excluded from
the monthly admin total in both the agent's guard and v2's `budgetState`, so a busy assistant can never pause
drafting. The daily cap also bounds the public month (≤ 31 × daily).

## D-49 Kustomize groups, not Helm or Argo CD
The site has no Helm chart and isn't an Argo CD app (D-08). The agent is a new manifest group `seo-agent-*.yaml`
(`scripts/manifests.sh seo-agent`), applied by a person once its Secret and pgvector exist. CI renders it, and applies
the Deployment, Service and ConfigMap kinds only via the existing applier. `CronJob` is classified as manual (a
schedule that runs workloads stays a person's decision). The reindex CronJob calls the service and then the Istio
sidecar's `/quitquitquit`, so the Job completes in the mesh. The Deployment uses `Recreate`, so two pods never drive
the same runs.

## D-50 The orchestrator stays `legacy` until switched
`SEO_ORCHESTRATOR` defaults to `legacy`. That makes rollback a config change, and merging this branch changes nothing
until the agent, its Secret and pgvector are in place. Drafts remember their owner (`thread_id`), so switching modes
never strands one.

## D-51 Tracing and telemetry
OTel spans per node and per crew run go to the existing collector (`OTEL_EXPORTER_OTLP_ENDPOINT`, then Jaeger; this
cluster uses Jaeger, not Tempo). LangSmith is off (`LANGSMITH_TRACING=false`). CrewAI telemetry and tracing are off
via `CREWAI_DISABLE_TELEMETRY`, `CREWAI_DISABLE_TRACKING`, `CREWAI_TRACING_ENABLED=false` and
`CREWAI_DISABLE_VERSION_CHECK`, as read in crewai_core 1.15.30. `OTEL_SDK_DISABLED` is deliberately **not** set: it
would silence this service's own tracing. Langfuse (self-hosted) is documented as an option and not deployed.

## D-52 Phases 1–5 in one commit
The service's modules depend on each other (`main.py` wires graphs, crew, index and ask together), so Phases 1–5 landed
in one commit (`d0aeea7`) that builds and passes tests. Phase 6 (deploy/CI/observability) and Phase 7 (docs) are
separate commits.

## D-53 Dependency audit findings (pip-audit, 2026-11-10)
- `oauthlib 4.0.0` → **4.0.1** (CVE-2026-49272, device-flow token disclosure). 4.0.1 is 10 days old, so it's a
  deliberate exception to the two-week rule: a released security fix beats the waiting period (`constraint-dependencies`
  + a per-package `exclude-newer-package` in `pyproject.toml`). oauthlib is a transitive dependency of crewai; this
  service runs no OAuth flow.
- `chromadb 1.5.9`: PYSEC-2026-311 and -3813/-3814/-3815, with **no fixed release**. crewai pins `~=1.5.9` and imports it
  at load, so it can't be removed (D-47). The advisories concern a Chroma server or client (pre-auth code injection,
  tenant/RBAC checks). This service never starts or connects to one: crewai memory and knowledge are off, and
  NetworkPolicy allows no inbound traffic except from the site, the reindex job and Prometheus. **Accepted risk**,
  ignored by those exact IDs in CI. Revisit when crewai allows a fixed chromadb.
