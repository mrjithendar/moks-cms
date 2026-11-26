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
`sites/jithendar.com/grafana/jithendar-com-seo.json` (uid `jithendar-com-seo`) is added to the existing folder synced by the shared
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
`SEO_LLM_MONTHLY_BUDGET_USD` (default $15 when unset since v5; $10 before) is a ceiling the settings can lower but not raise. Before every
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
**The lancedb half was replaced by D-91 (2026-11-17) and is back since D-103 (2026-11-26): LanceDB is overridden away again.** The chromadb half stands.

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
- **Hardened 2026-11-13** (Dependabot #4–#7: GHSA-f4j7-r4q5-qw2c / CVE-2026-45829, GHSA-2wm9-hf6c-p5cr / CVE-2026-45830,
  GHSA-xph7-9rjv-w5fr / CVE-2026-45831, GHSA-36p7-vc44-83pf / CVE-2026-45833; every chromadb ≤ 1.5.9, still no fixed
  release, and crewai 1.15.30 still pins `chromadb~=1.5.9`). Rechecked: crewai imports `chromadb.config`, `chromadb.api`
  types and the embedding-function modules at load (`crewai.memory` → `crewai.rag`), so chromadb can't be overridden
  away. Importing every `app.*` module loads none of the vulnerable parts. The Dockerfile now deletes them from the image:
  `chromadb_rust_bindings` (the `chroma run` server, 50 MB), `chromadb/server`, `cli`, `app.py`,
  `auth/basic_authn`, `auth/simple_rbac_authz` and `bin/chroma`. The build fails unless `crewai` still imports and
  `chromadb.server` no longer does. `tests/test_chromadb_surface.py` fails if a service module ever imports one of them.
  The full test suite passed with them removed (only the macOS-local LightGBM/libomp failures, unrelated). The
  installed version is still 1.5.9, so scanners keep reporting it; the alerts are "vulnerable code not used".

---

# v4 (branch `feature/seo-v4-crewai-mcp`, from master `7ac533f`)

## D-54 Versions and the APIs checked
The brief asks for the latest stable releases; the v1–v3 rule is the newest stable release at least two weeks old
(cut-off 2026-10-27). Checked on PyPI/npm on 2026-11-10:
- **crewai 1.15.30** (kept; 1.15.39 is one day old). APIs read from the installed package, not from memory:
  `Flow[State]`, `@start`/`@listen`/`@router`/`or_`, `kickoff_async(inputs=…)`, state restored by `inputs["id"]`,
  `FlowPersistence` (`init_db`, `save_state`, `load_state`; sync), `@persist(backend)` at class level with an instance
  `persistence=` that overrides it, `suppress_flow_events`, `BaseLLM.call`, `Crew(max_rpm=…)`, `Agent(max_rpm, max_iter,
  max_execution_time, allow_code_execution)`. Differences found and handled: (1) a Flow auto-creates CrewAI's unified
  `Memory` (LanceDB, which v3 excluded) unless the class sets `_skip_auto_memory`; (2) `@persist()` without a backend
  creates a SQLite `flow_states.db` even when an instance backend is passed (hence `INSTANCE_ONLY`, D-57); (3) a router
  label equal to a method name is refused (labels carry a `to_` prefix); (4) `@start`/`@listen` methods inherited from a
  base class are not registered (each job flow is built by a factory); (5) a flow method named `validate` shadows
  pydantic's `BaseModel.validate` (renamed `validate_draft`; mypy found it).
- **anthropic 2.3.0** (newest ≥ 2 weeks; 2.7.0 is one day old). LangChain's `ChatAnthropic` is gone; the official SDK is
  called directly: `messages.parse(output_format=Model)`, `messages.create`, `messages.stream`, and the beta namespace
  for Sonnet/Opus with `betas=["server-side-fallback-2026-07-01"], fallbacks="default"`. 2.x sends API version
  2026-10-21: no `temperature`/`top_p`/`top_k` are sent (none were), credentials as `Authorization: Bearer`. Usage:
  `input_tokens` is already the uncached part; cache reads/writes come separately. A test checks the exact request body.
- **mcp 1.30.0** (newest 1.x). mcp 2.3.0 is the newest stable, but crewai 1.15.30 requires `mcp<2`. FastMCP: Streamable
  HTTP (`streamable_http_app`, `stateless_http`), `TransportSecuritySettings` (Host/Origin), `token_verifier` +
  `AuthSettings(resource_server_url, required_scopes, validate_token_resource=True)` (401 + `WWW-Authenticate
  resource_metadata`, 403 `insufficient_scope`), `ToolAnnotations`.
- **reportlab 5.1.0** (report PDFs, D-61). **MCP Inspector 2.12.0** for manual verification.
- Removed: langgraph, langgraph-checkpoint-postgres, langchain-core, langchain-anthropic, langchain-text-splitters
  (177 → 161 locked packages).

## D-55 Claude for the crews: a CrewAI `BaseLLM` over the Anthropic SDK
"Use CrewAI's LLM layer with Claude": CrewAI's extension point for models is `BaseLLM`, and `ClaudeCrewLLM` implements it
on top of this service's `AnthropicLlm`, so every crew call shares the budget guard, usage rows, prices, refusal fallback
and caching with everything else. CrewAI's built-in Anthropic provider (`crewai[anthropic]`) would also stamp
`cache_control`, but pins `anthropic~=0.73`, which conflicts with 2.3.0, and would bypass the budget guard.
**Prompt caching:** supported; the stable prefix (untrusted-data rule + the agent's system prompt) is a cached system
block. Per-agent models: `SEO_CREW_MODELS` (`"<crew>.<agent>"` → model).

## D-56 Split-flow approval instead of CrewAI human feedback
As the brief requires. Drafting flows end at `ready_for_review` with their state in `seo_flow_runs`; the web review UI
records the approval (v3 D-43 unchanged) and `POST /review/{id}/decision` starts `publish_flow`. CrewAI 1.15 has
`@human_feedback` / async pending feedback, which persists a paused flow; it isn't used because the approval must be
recorded and re-checked by the web app, and nothing should depend on a paused run surviving deploys. `publish_flow` is
refused for every trigger but `approval` (run-manager policy), and the decision endpoint is the only code that sets it.

## D-57 Flow persistence and locks in the one Postgres
`PgFlowPersistence` (a CrewAI `FlowPersistence`) writes each step's state into the run's `seo_flow_runs` row through a
2-connection sync pool (CrewAI calls `save_state` synchronously). Never SQLite: classes use `@persist(INSTANCE_ONLY)`, a
backend that raises, and each instance gets the Postgres one; a test asserts no `.db` file appears. One active run per
flow + target: partial unique index + a session advisory lock on a dedicated connection for the run's lifetime (v1 D-02
avoided advisory locks because a *shared* pool may unlock on another connection; a dedicated connection doesn't have that
problem, and PgBouncer session mode keeps one server connection per client connection). Runs are not resumed after a
crash: they're failed on start-up and rerun from the beginning (idempotent steps), as the brief specifies.

## D-58 Ask the Blog stays a pipeline; v3's graph code became plain functions
Not a Crew or a Flow (brief). The v3 graph's node functions were kept verbatim as one async pipeline
(`app/services/ask_pipeline.py`), so its guards and tests carry over; the public MCP `ask_blog` uses it.

## D-59 Report numbers are checked mechanically
The Report Crew gets labelled, pre-formatted facts; `check_numbers` requires every number in the narrative to equal a
fact at the precision written, and ISO dates to be period dates. A mismatch fails the run (`report_mismatch`): the
narrative is neither stored nor emailed. The numbers-only PDF is still saved, since its figures come straight from the
data. The web callback refuses to store a narrative whose check didn't pass (second gate).

## D-60 The admin MCP authorization server is a minimal one inside the site
Better Auth 1.7.18 here has no OAuth-provider/MCP plugin; it moved to `@better-auth/oauth-provider`, whose matching
versions (1.7.16–1.7.19) are all under two weeks old, and which adds five tables, its own consent flow and JWT key
management. A heavyweight identity server (Keycloak, Authentik) would cost more memory than the agent itself on
Minikube. So the web app implements the minimum compliant set: RFC 8414 + RFC 9728 metadata, RFC 7591 registration (public
PKCE clients only), an admin-only consent page on the existing session, `authorization_code` + PKCE S256, rotating refresh
tokens with reuse detection, RFC 7009 revocation, RFC 8707 resource binding. Tokens are opaque and stored as SHA-256
hashes in the shared Postgres; the resource server verifies them with one lookup (and that the grant's user is still an
admin), so there are no signing keys and revocation is immediate. Trade-off: ~400 lines of security code to maintain
instead of a library; covered by 6 web tests and the end-to-end Inspector check. Revisit when the Better Auth plugin
matures (it would replace `src/lib/mcp-oauth` and the 0016 OAuth tables).

## D-61 Report PDFs: ReportLab in the agent, stored in R2 by the web app (owner request, 2026-11-10)
The owner asked for weekly/monthly reports as rich PDFs saved in R2 (v1 D-09 had chosen print-to-PDF). ReportLab is pure
Python (no Cairo/Pango system libraries, unlike WeasyPrint), so the CPU-only slim image stays slim. `report_flow`
renders the PDF (cover, KPI cards with direction-aware deltas, daily-clicks chart vs. the previous period, top-articles
chart, the checked summary, styled tables) and hands it to the web callback, which stores it with the site's existing R2
client under a private, unguessable key; admins get a 5-minute presigned link. The legacy path (SEO_ORCHESTRATOR=legacy)
still produces CSV + printable HTML only.

## D-62 MCP on its own port; Kong entities as a decK file
The brief mounts both servers in the seo-agent app. They run in the same process, but on a second listener (8090), so the
NetworkPolicy can admit the gateway to MCP only: a public request can never reach `/flows/*` or `/review/*` on 8080, even
if a route were misconfigured. Kong on mk4 runs in DB mode with entities in the tools repository (branch
`feat/kong-db-migration`); there are no Kong CRDs here. The additive entities are delivered as
`kubernetes/kong/seo-agent-mcp.deck.yaml` (tagged, for `deck --select-tag`), outside the kubectl glob, unapplied. Master
currently routes through the Istio gateway and the namespace is STRICT mTLS, which the Kong branch predates; the exact
mesh steps for either gateway are in MANUAL_SETUP §27. No existing route, plugin or certificate was changed.

## D-63 Each job runs once: CronJobs own the flow jobs, the web scheduler skips them
With `SEO_ORCHESTRATOR=crewai`, `seoTick` skips gsc_sync, ga4_sync, technical_scan, recommendations, drafts_weekly,
drafts_poll, report_weekly and report_monthly; one `seo-flow-*` CronJob per flow triggers them. A scheduled job flow
passes a dated slot, and the web runner skips a type whose scheduled run for that slot already exists, so even an overlap
during the switch can't run a job twice. Keywords refresh, retention, outcomes and the digest stay in the web worker
(not AI workflows; no flow in the brief). Schedules live in the CronJob manifests (the brief's "Helm values"; there is
no Helm chart here, v1 D-08). The v3 `seo-agent-reindex` CronJob is replaced by `seo-flow-reindex`.

## D-64 Shared service functions
`app/services/{content,review,seo_data}.py` are the single implementation behind the internal API, the crews' tools
(`vector_search` calls `content.search`) and both MCP servers. The admin read tools wrap the web app's own TypeScript read
models (`overview`, `keywordTable`, `articlePanel`, `reviewQueue`, `getDraft`, `latestScan`) through new callback routes,
so MCP shows exactly what the dashboard shows. `explain_traffic_change` is the one new query (period-over-period by
query/page, device and country from `seo_gsc_query_daily`).

## D-65 Phases 1–5b in one commit
As in v3 (D-52): the Python flows, the web callbacks they call and the contract test that ties them together only build
and pass together. Phase 6 (deployment) and Phase 7 (docs, tests) are separate commits. Two owner requests made during
the work (the admin menu layout and the sync-history error popover) were committed separately so they can ship to master
on their own.

---

# v5 (branch `feature/seo-v5-ml-rag`)

## D-66 Kube-context guard: explicit or confirmed, never hard-coded
Every cluster-changing script sources `scripts/lib/kube-context.sh`. It resolves the context from `KUBE_CONTEXT` or, failing
that, the current context (no name is hard-coded, so the 2026-11-10 removal of `--context mk4` stands), checks that it
exists, prints it with its API server, and pins every kubectl call to it with `--context` (a `kubectl config
use-context` in another terminal can't redirect a running script). Only an implicit context is confirmed, and only on a
TTY with `YES` ≠ 1, so CI and pipes never block. Calls that bring a generated kubeconfig (`--kubeconfig`, the CI
setup scripts) use `command kubectl` to bypass the wrapper. `manifests.sh` only prints and has no guard. Tested with
a stub kubectl in plain bash (bats isn't installed here or on the runner image by default).

## D-67 Budget default $15; per-flow cost from seo_flow_runs
The admin month is estimated at $8–10.5 (COSTS.md), too close to $10. The default is now $15 in all three places (web
default, agent default, `seo-agent-config`). The per-flow breakdown reads `seo_flow_runs.cost_usd`, which the agent's
persistence already writes per run, so no column was added to `seo_llm_usage`; the remainder of the admin month is
shown as "outside flows". The 80 % alert (`SeoLlmBudget80`) already existed.

## D-68 Image size gate against a committed baseline
`scripts/image-size.sh` reports uncompressed (`docker image inspect`) and compressed (`docker save | gzip`, close to the
registry's gzip layers) sizes in the job summary and fails above +15 % of `image-size-baseline.json`. The seo-agent gate
runs on the pull-request build (amd64); the web image is only built at release, so its gate runs there, before the
push. A baseline with null values reports and warns instead of failing, until it is filled from a CI run: this machine
has no container runtime, so no size was invented.

## D-69 One generated alerts file for the miniKube repo
`scripts/build-alerts.py` combines the SEO and news groups into `docs/seo/alerts-for-minikube-repo.yaml`; the sources
stay where they were (D-12). CI checks staleness and runs `promtool check rules` from the pinned `prom/prometheus:v3.5.0`
image; promtool isn't installed on this machine (and downloading it was not allowed), so local runs do structural checks.

## D-70 Token chunking with code windows; one row per window
The chunker budgets tokens with the model's tokenizer (target 350, hard max 480, prefix included). An oversized code
block keeps one display copy (`content`) and is embedded as overlapping windows, one row each (`part`, `embed_text`),
so `similar_articles`' mean embedding and the HNSW index need no change; retrieval merges windows by content. The
chunker version is in the stored hash, so the first reindex after deploying re-embeds everything once. Measured: v4 had
16 % of inputs over 512 tokens; v5 has none.

## D-71 Retrieval defaults decided by the eval set: vector, ≤ 3 per article
Hybrid (RRF over pgvector + `tsvector` + exact identifiers) is built and tested but not the default: on the 55-question
set it does not beat vector on Recall@3 (95.7 vs 100 at ≤ 3 per article; a tie at ≤ 2) and has fewer anchor hits.
Diversification is 3 per article, not the brief's 2: 2 cost 10.7 points of section-anchor hits for no recall gain.
Both are one environment variable (`RAG_MODE`, `RAG_MAX_PER_ARTICLE`). The eval set saturates article-level Recall@3,
so a harder set should come before revisiting this (RAG.md "Reading it honestly").

## D-72 ASK_BLOG_MIN_SCORE 0.66, applied to cosine before fusion; retrieval logged per question
The floor is calibrated on the eval set (highest floor losing no expected answer) and stays a cosine pre-filter in
both modes; `Hit.score` keeps meaning cosine everywhere. `seo_ask_log` gains `retrieval` and `prompt_version`
(migration 0018) so `scripts/rag_calibrate.py` can check the floor against real traffic. It prints, never applies.

## D-73 The grader names the relevant excerpts (ask-blog-v3)
`Relevance.relevant_excerpts` is optional (default `[]` = all), so an older or cached grader answer and the fake model in
tests keep v4 behaviour. The answer step sees only the named excerpts, renumbered; citations map back to them.

## D-74 Reranker left off without downloading a model
Its gate (+3 points of Recall@3) is unreachable when Recall@3 is already 100 %. Downloading and measuring a 280 MB model
that cannot be enabled was skipped; the code and eval config stay for a harder set.

## D-75 STL in numpy, not statsmodels
The brief names statsmodels for STL, and the rules allow a new library only if nothing installed can do the job.
statsmodels needs pandas and patsy (~100 MB installed) for one function; STL is iterated LOESS, which numpy does.
`app/seo_ml/stl.py` follows Cleveland et al. (1990), with a vectorised LOESS for evenly spaced days that matches the
reference loop to 1e-15 (tested), and yearly seasonality by a second STL pass (MSTL-style). Decay detection adds a
last-week confirmation to the brief's conditions, because STL's trend at the end of a series cannot yet tell a dip that
just ended from a decline. The detector was designed on one seed range and is judged on a held-out range.

## D-76 One flow, one registry, one decision function
All five models are steps of `seo_ml_flow` and register versions in `seo_ml_models` through one `register()` (activation
rule, carried-over review, automatic fallback with a metric). The web app decides "model or rule" in one place
(`ml.ts mlDecision`: override, active, fresh within 14 days), and every consumer labels its output with that decision.
Outputs are written even for inactive models, so "force the model" works and the Models page can show them.

## D-77 Clusters and intents reach the existing tables at refresh time
The keyword views, content gaps and "Asked on site" already read `seo_query_clusters` / `seo_query_intents`. The daily
keyword refresh copies the model's clusters (plus token-set clusters for queries the weekly model hasn't seen, id-offset)
and the confident intent predictions into them, with a `source`, instead of rewriting every reader. Ask-the-Blog gaps
are embedded in the same HDBSCAN run as `ask:<normalized>` rows.

## D-78 Cluster activation gates on ARI, purity within 0.05
Purity alone rewards over-splitting (singletons score 1), which is what token-set clustering does; the brief asks to
compare ARI and purity. ARI must be strictly higher; purity may be at most 0.05 lower; inverse purity is reported.

## D-79 Related articles: an A/B by id parity; link ranking only uses an active model
The public block shows the model's list on even article ids while the model is `experiment_running`, measured with a
consent-gated `related_click` GA4 event. Internal-link candidate ranking uses the model's score (25 % blend) only when
the model is active or forced, so an unvalidated experiment can't change draft links; the v2 link limits stay in the
planner. GA4 page-pair data is fetched outside `GA4_REPORTS`, so a property that rejects the pair can't fail the sync or
"Test connection".

## D-80 Settings improvements as their own commit (owner request during v5)
The owner asked for better SEO settings mid-build and chose: organise the form (tabs, change tracking, defaults, field
errors), a connections card, and ML/RAG controls. The first two were committed separately (`de84e76`); the ML/RAG
card ships with Phase 3 because it needs the model registry.

## D-81 SEO-ML review fixes: reviews bound to a configuration, leakage-free priority, honest intent metrics
- **Decay.** The activation benchmark is a fixed set of held-out seeds, so it gives the same answer every week, and a
  review used to carry over to every retrain that passed it, even after `DecayConfig` or the method changed. A review
  now binds to `review_key` (method + a hash of the config) and carries over only while the key matches and the real
  back-test's Jaccard agreement with the rule stays within 0.15 of the reviewed version's. Activation also needs the
  back-test's alerts within 1.5 × the rule's (+ 2). The benchmark gained zero-inflated pages and step changes (gain:
  negative; loss: positive), which showed the detector catches fewer abrupt step losses than the rule; that is
  reported, not tuned away.
- **Priority.** `outcomes()` used the post body, decay signal, intent and cluster as they are today, i.e. after the
  change it measures. With no snapshot of those at implementation time, they were dropped rather than kept (no
  web-app change: `score_inputs` and the evidence are already frozen once a recommendation leaves review, and
  `baseline_metrics` is captured at "implemented"). One 10-row hold-out was replaced by expanding-window CV and a
  bootstrap CI; a proposal needs the CI's lower bound above 0.
- **Intent.** `MIN_TRAIN` 60 → 300; stratified 5-fold × 2 for the metrics; the threshold is tuned on a calibration
  split of each training fold, so "accuracy when confident" is no longer measured on the rows that chose the threshold.

## D-82 LLM review fixes: book every call once, reserve before calling
A call that stops at `max_tokens` raises `Truncated` (a subclass of `InvalidOutput`, so existing handlers fall back
instead of shipping half a text); a stream closed by the client is booked from an upper-bound estimate in its
`finally`; a schema miss the SDK raises before returning the message is booked as an estimate (`schema_estimated`)
rather than not at all, because `messages.parse` has no raw-response variant to read usage from. The budget guard holds
each call's estimate as pending spend until it is booked: concurrent calls no longer pass on the same reading.
In-process only; a cross-replica reservation (row or advisory lock on `seo_llm_usage`) waits for a second replica.
Spans are emitted after the call (start time kept), because a streamed call lives across generator yields where a
context-managed current span would be detached in another context.

## D-83 Dimension change: build next to the live table, swap when complete
Dropping the live table on start-up lost the index on a failed or reverted provider change. The new table is built
as `seo_article_chunks_next` and swapped in one transaction after a complete reindex. Answers still fall back until
the swap (old vectors can't be searched with the new model), so no automatic reindex was added to start-up: the
container builds before the web app is guaranteed reachable, and the manual step was already documented.

## D-84 Ask the Blog: stream only after a valid citation; narrower injection filter
Deltas used to go out before `guard_output`, so a link or an uncited (later discarded) answer could reach the reader.
Streaming now starts at the first in-range `[n]` and strips links per whitespace-bounded piece. The injection filter
refused honest questions on an AI blog ("how do I write a system prompt…", a reader named Dan): it now matches only
phrasing aimed at this assistant's prompt and a capitalised `DAN`. The eval set's hard questions and the opt-in
generation eval (citation precision, faithfulness via an `eval_judge` call) replace a CI recall gate, which hashed
embeddings can't make meaningful.

## D-85 SEO is part of the CMS; calendar articles are written into their CMS draft post (owner request 2026-11-11)

"Do not make anything separate, integrate the SEO dashboard into the CMS." Two changes:

- **One admin shell.** The SEO section rail is gone; every SEO page is an item in the main admin sidebar (Editorial calendar and AI review queue under Content, analysis pages under SEO, SEO settings/integrations/MCP under Site, sync history and ML models under Operations). URLs are unchanged. The dashboard keeps its view controls and ⌘K palette.
- **No separate review step for calendar articles.** When the Editorial Crew saves a calendar draft, `seo-intel/handoff.ts` writes its title, meta description and body into the item's CMS **draft** post (through `updatePost`, never publishing, never changing status) and marks the seo_drafts row superseded. It only replaces the generated outline: if the post body was edited, nothing is overwritten. Opening the post in the editor runs the same handoff, so drafts that finished earlier move too. The crew's fact-check flags are shown above the editor. Publishing is the editor's own Publish button; the calendar follows the post status. News desk drafts are unchanged. This narrows D-21 (publish.ts is the only SEO module that publishes) rather than replacing it; `tests/seo-intel-cms.test.ts` pins both.

The crew's reviewer sometimes wrapped the body ("## Corrected MDX body", notes, a ```mdx fence, a "needs_fact_check items" heading). `split_review` (seo-agent) and `cleanCrewBody` (www) now unwrap it, including a wrapper cut off by the token cap.

## D-86 No separate SEO area: one CMS (owner request 2026-11-11)

"Do not make separation like SEO dashboard / CMS, merge everything." D-85 put the SEO pages in the main sidebar; this removes the SEO area itself.

- **No /admin/seo.** The pages live in the route group `app/admin/(growth)` (no URL prefix): `/admin/calendar`, `/admin/review`, `/admin/search`, `/admin/analytics`, `/admin/page-insights`, `/admin/keywords`, `/admin/recommendations`, `/admin/content-audit`, `/admin/links`, `/admin/technical`, `/admin/reports`, `/admin/sync`, `/admin/models`, `/admin/automation` (+ `/mcp`). The group layout keeps the admin-only guard, the budget banner and the ⌘K palette; the stylesheet loads in the admin layout (every admin page). Old `/admin/seo/*` links (bookmarks, emails already sent) redirect (`lib/seo-intel/old-urls.ts`). API routes stay under `/api/admin/seo`.
- **Merged pages.** The SEO overview is the "Search & traffic" part of the admin Dashboard (admins). Search Console / GA4 is a section of Admin → Integrations. The per-article SEO panel is `/admin/posts/{id}/insights`, linked from the post editor.
- **Sidebar by job, no "SEO" group.** Content: Posts, Editorial calendar, Review queue, …; Insights: search, analytics, keywords, recommendations, content audit, linking, technical health, reports; Site: Integrations, Automation & AI, MCP access; Operations: Data sync, ML models.

## D-87 Admin sidebar: categories that expand and collapse (owner request 2026-11-11)

"Make admin sidebar menu category wise and can be expand collapse." Same 37 links, regrouped by job: Overview
(Dashboard); Content (posts, pages, media, categories, tags, Python practice); Editorial & AI (editorial calendar,
review queue, news desk); Insights (search, analytics, keywords, reports…); Community (comments, messages, bookings);
Site settings; Operations; Account. Every category is a disclosure button (`aria-expanded`/`aria-controls`). Overview
and the current page's category are open by default; the current page's category is always open; choices are kept in
the browser (`localStorage`, key `admin-nav-open-v1`). A collapsed category shows the sum of its badges (pending
reviews, unread messages) as a pill, otherwise its item count. Expand all / Collapse all. Authors see only the
categories they have pages in. `components/admin/AdminNav.tsx`, `app/admin/layout.tsx`, `tests/admin-nav.test.tsx`.


## D-88 Promotion: drafts and ideas for a person, never automatic posting (owner request 2026-11-12)

"Enable promotion opportunities for content in the SEO dashboard", "suggest content creation for promoting, not only
for existing", "implement Reddit and Search Console". Built as Admin → Promotion ([PROMOTION.md](PROMOTION.md)).

- **No posting code.** Every channel is posted by hand. Reddit, Hacker News and Facebook groups penalise automated
  self-promotion, and AGENTS.md A3.10 keeps AI output behind a person. "Mark as posted" records the owner's own act.
  Posting through the DEV, Hashnode and LinkedIn APIs was left out of this version rather than half-built.
- **Scores are rules, not a model.** `channels.ts` is deterministic and shows its reasons. There is no outcome data yet
  to train on, and a number the owner can trace beats one they cannot. It is labelled as an ordering, not a forecast.
- **CrewAI only** (owner rule: no other job engine): two flows and a tool-less Promotion Crew in `services/seo-agent`.
  The Reddit read is in the web app because the agent has no internet egress except the Anthropic API (as for news).
- **Evidence is verified, not trusted.** The strategist must cite signals; the web app re-checks each against its own
  tables and stores an idea only with verified evidence. An unverifiable claim never reaches the page (A3.6).
- **Reddit: read-only and minimal.** Application-only OAuth, one listing request per subreddit per run, no usernames,
  bodies or comments stored, credentials only in the environment (A3.8, "Requires manual configuration").
- **Ideas feed the existing calendar.** No second drafting path: an accepted idea becomes an approved calendar item
  and `new_article_flow` writes it as before.
- **Own settings row** (`setting` key `promotion`) instead of a new section in the `seo` document, so the feature can
  be switched off or rolled back without touching the SEO settings schema.
- **Not built:** traffic per promotion in the admin (the GA4 sync has no `sessionSource` report), Hacker News as a
  signal, alerts and a dashboard panel for the two flows.

## D-89 Ask the Blog: an admin switch, an audience setting and editable options (owner request 2026-11-13)

"Enable Ask the Blog; the admin can enable or disable it from settings; add more customisations; a setting for only
logged-in users or all users." See [RAG.md](RAG.md) "Admin settings".

- **Two switches, both needed.** `ASK_BLOG_ENABLED` stays as the deployment's switch and is now `true` in the manifests;
  the admin's switch decides whether the assistant is actually on, without a restart. It ships **off**, so merging and
  deploying this exposes nothing (A3.5): the owner turns it on after the reindex and, ideally, the real-model eval run
  that RAG.md still lists as open.
- **Signed-in readers only is the default audience.** It bounds abuse and spend while the hard-set and generation
  evals are pending. The session is checked on the server for every question; the widget's own check is only for the
  prompt. The public MCP `ask_blog` tool has no site sign-in, so it answers `disabled` in that mode rather than being a
  way around it.
- **Own settings row** (`setting` key `ask_blog`), as for promotion (D-88): no migration, and the SEO settings schema
  is untouched. The seo-agent reads the same row with a 30-second cache instead of taking options from the web app per
  request, because the MCP tool does not pass through the web app. The agent fails closed (no row, invalid row or an
  unreadable database before the first read = off) and keeps the last known value through a later database error.
- **The environment keeps the last word on money.** The saved daily budget is capped by `ASK_BLOG_DAILY_BUDGET_USD`.
- **Retrieval and models are not editable.** Top-k and the 0.66 floor came from the evaluation set (D-72); a model
  picker would change cost and invalidate the eval. Answer length is editable, with "standard" kept byte-identical to
  the evaluated prompt and the other lengths logged under their own prompt version.
- **The web switch moved from `jithendar-com-public` to the Deployment manifest** so it is in Git. A key left in that
  ConfigMap no longer has any effect; the hard kill switch is `seo-agent-config` (MANUAL_SETUP.md §18).
- **Commit and pull request by the agent**, at the owner's explicit request for this change (an exception to A3.12).

## D-90 Ask the Blog as a sitewide chat (owner request 2026-11-14)

"Ask the Blog should be like a chat bot site wide … proceed with fully enabled, can control all the settings from
admin." See [RAG.md](RAG.md) "Sitewide chat".

- **Everything new is on by default, every part has an admin switch.** Sitewide launcher, follow-ups, page context,
  kept conversations and feedback default to on; each has its own control on the Ask the Blog card, along with the
  launcher style, the extra hidden paths and the number of earlier turns. The two existing switches still decide
  whether the assistant is on at all, and the audience still defaults to signed-in readers (D-89): "fully enabled" was
  read as all features on, not as opening it to everyone.
- **Follow-ups are rewritten, not answered with history.** A condense step turns the follow-up into a standalone
  question; the evaluated answer prompt, the grounding rule and the citation guards see exactly what they saw before.
  The rewrite is the cache key and the gap-log entry, so a follow-up and the same question asked directly share an
  answer. The conversation is client-supplied and untrusted: guarded turn by turn, inside `<data>`, never rewriting a
  question the guards refuse.
- **No server-side conversation store.** The thread lives in the reader's tab (sessionStorage), so the privacy note
  stays true and nothing ties questions together on the server.
- **Feedback by token, not by row id.** An unguessable token per logged answer means a rating can only reach the row
  it was handed out for; the endpoint gives the same answer whether or not a token exists.
- **Page context is a ranking nudge (+0.05), not a filter.** Other articles can still answer. The value is not
  evaluated yet; it is a constant in `ask_pipeline.py` (`CONTEXT_BOOST`), not an admin setting, for the same reason as
  top-k (D-89).
- **Migration 0029** adds nullable columns and a partial unique index; the agent detects them, so the order of deploys
  does not matter.

## D-91 LanceDB on Cloudflare R2 for CrewAI's memory and the article index (owner request 2026-11-17)
**Withdrawn by D-103 (2026-11-26): LanceDB is removed.** Kept for the record.


"Lancedb data should be stored on cloudflare r2 and this can be managed from seo dashboard: can see and edit and
delete." Asked what LanceDB should hold, the owner chose **agent memory and the article index**, with the R2 keys
taken from **Admin → Storage**. This reverses two earlier rules, on purpose: D-47 (LanceDB not installed) and "one
database: the existing PostgreSQL holds the vectors, no vector database" (v3 ground rules).

- **Step 0 (this entry): the dependency only.** The uv override that excluded LanceDB is gone, so `lancedb` 0.40.0 and
  `pyarrow` 26.0.0 are installed. The image grew from 363.8 to 468.9 MiB as stored (+105 MiB, +28.9 %; D-47's 290 MB was
  the unpacked virtual environment), and the image-size baseline was raised to match. Nothing is switched on by this: crews are still built with
  `memory=False`, flows still set `_skip_auto_memory`, and the article index is still `PgVectorIndex`. The guard test
  now asserts that LanceDB **is** importable; the `.lance` file test and the `crew.memory is False` test stay.
- **The lockfile was regenerated by a temporary workflow on the pull request** (owner decision: the change was written
  where packages cannot be downloaded). It ran `uv lock` in a job with no write access and handed only the diff of
  `uv.lock` to a second job that committed it; the workflow was deleted in the same pull request. The diff: the
  override and its marker removed, wheels added for `lancedb` and `pyarrow`, no other version changed.
- **Planned, each as its own pull request and decision:**
  1. The R2 connection and CrewAI's memory. CrewAI's `LanceDBStorage` (1.15.34) calls `mkdir` on its path and opens a
     local folder only, so R2 needs a subclass that connects with `s3://…` and the R2 endpoint; it depends on CrewAI
     internals and gets a contract test. Keys come from the web app (Admin → Storage) over the internal API: the agent
     then holds the media bucket's keys, which the owner accepted. Data goes under `jithendar/seo-agent/lancedb/`.
     Memory is off by default with a switch per crew.
  2. SEO dashboard → Memory: see, edit and delete records (CrewAI's `list_records`, `update`, `forget(record_ids=…)`).
  3. The article index in LanceDB behind a switch, next to `PgVectorIndex` (both implement `Retriever`), with the RAG
     evaluation run on both stores.
  4. Cut-over of Ask the Blog, and an index view in the dashboard. pgvector stays until the evaluation shows equal
     quality, so the move can be undone.
- **Known limits to design around.** LanceDB's documentation warns that an S3-compatible store is not safe for two
  processes writing the same table, so the agent stays at one replica and every write goes through it. Every recall
  reads from R2, which is slower than local disk. Memory carries text from one run into later prompts, including text
  derived from fetched pages, so the dashboard has to show where each record came from.

## D-92 A LanceDB browser in the admin, and the R2 connection from Admin → Storage (owner request 2026-11-18)
**Withdrawn by D-103 (2026-11-26): LanceDB is removed.** Kept for the record.


"Enable feature that can browse lancedb data, can be viewed and modified from jithendar.com/admin." This delivers the
R2 connection of D-91 step 1 and a generic form of step 2 (see, edit, delete), before anything writes to LanceDB.

- **Where the data is.** The agent asks the web app for the R2 connection on first use (`GET
  /internal/seo-agent/storage/lancedb`, callback port and token only): `s3://<media bucket>/jithendar/seo-agent/lancedb`
  with the endpoint and keys from Admin → Storage or the `R2_*` Secret. Until storage is set up the answer is
  `{configured: false}`, and the agent asks again at most once a minute. `LANCEDB_URI` on the agent overrides this with
  a folder, for local development only. There are no `LANCEDB_S3_*` variables: the keys come from Admin → Storage, as D-91
  decided.
- **Who reaches it.** Only seo-agent opens LanceDB (D-91: one writer, one replica). `/admin/lancedb` (admin role)
  calls the agent's internal API: `GET /lancedb`, `GET /lancedb/tables/{name}`, `POST /lancedb/tables/{name}/row`,
  `/update` and `/delete`, all behind `SEO_AGENT_TOKEN` (`app/lance_admin.py`).
- **What may change.** One row per request, picked by a scalar key column whose value must match exactly one row (409
  otherwise). Only text, number, boolean and timestamp columns can be edited; vectors and nested values are shown
  abridged and are read-only. Table and column names must be plain identifiers that exist, and values become filter
  literals only through one quoting function (tests cover quotes and injection attempts). No table can be created or
  dropped from the browser.
- **Record.** Every write is a new LanceDB table version, an `info` log line on the agent (`lancedb_update`,
  `lancedb_delete`, with the admin), and an audit log entry on the web app (`lancedb.update`, `lancedb.delete` at
  `warning`).
- **Not in this change.** Nothing writes to LanceDB yet, so the browser shows no tables until D-91 step 1 (CrewAI
  memory) or step 3 (the article index) lands. A memory-specific view that shows where each record came from (D-91's
  known limit) belongs to step 1.

## D-93 The article index copied into LanceDB (owner request 2026-11-18; D-91 step 3, first half)
**Withdrawn by D-103 (2026-11-26): LanceDB is removed.** Kept for the record.


"Tables and rows are 0 … I want real data", with the owner choosing both D-91 steps, the article index first. This puts
the real article index in LanceDB without changing what any search reads.

- **A copy, not a second index.** After every reindex that changed something, and once at startup when the table is
  missing, seo-agent copies the published articles' chunks from pgvector's `seo_article_chunks` into the LanceDB
  table `article_chunks` (`app/lance_index.py`), with the vectors pgvector already holds: nothing is embedded twice and
  both stores always hold the same vectors, which is what the RAG evaluation of step 3 needs. Columns: `id`
  (`<article_id>:<chunk_index>`, the unique key /admin/lancedb edits by), article, title, path, category, heading,
  anchor, content, hash, model, `updated_at`, `vector` (fixed-size float32).
- **Whole rewrite, then cleanup.** Each sync writes the whole table as one new version (about 1–2k rows), so the copy
  cannot drift from Postgres; versions older than one hour are removed, so R2 holds about one copy. An admin edit to
  `article_chunks` in /admin/lancedb lasts until the next sync, which is stated in the code; edits belong in the
  article, not in the index.
- **Never harms the reindex.** Postgres is the source of truth: a failed sync is a warning (`lancedb_index_failed`)
  and the reindex result gets `lancedb_synced: 0`. An empty query result never replaces a filled table. Syncs run under
  the reindex lock, so the agent stays the only writer (D-91).
- **Switch.** `LANCEDB_ARTICLE_INDEX` (default `true`; `false` turns the copy off). On by default because it changes no
  behaviour: Ask the Blog, related articles and the crews still search pgvector.
- **Next (step 3, second half).** A LanceDB `Retriever` next to `PgVectorIndex`, and `rag-eval.yml` run on both, before
  any cut-over (step 4).

## D-94 Editorial calendar: unscheduled, scheduled, published; Generate, Improve, Schedule publishes (owner request 2026-11-18)

"There is no approved pending, just scheduled unscheduled, published … publish is scheduled, user can schedule on their
interest … each item should have a Generate draft button … and an Improve button … remove approve, drop." Asked what
scheduling should do, the owner chose **auto-publish: scheduling is the approval**.

- **Three phases**, computed, not stored: published (the linked post is published), scheduled (the item has a date),
  unscheduled. The stored `status` keeps its old values (history, the suggestion engine's cap on open ideas); no
  Approve, Drop or status buttons remain. **Delete** hides the item (`status = 'dropped'`) and keeps its fingerprint, so
  the suggestion engine does not add it again; its post is kept.
- **The draft is found before anything is offered.** Each listing first clears links to deleted or trashed posts (an
  item then shows "No draft" and Generate, instead of a dead "draft" link), links an item without a post to the one
  live post with the same title (a draft written by hand, or an already published article, which makes the item
  published), and follows posts to published. Draft states: none, outline (the generated outline only), writing (the
  agent's run), failed, ready, scheduled, published.
- **Generate draft** (none, outline or failed): the outline post (an existing outline post is reused) and, with the SEO
  agent, `new_article_flow` writes it into the post (D-85's handoff).
- **Improve** (ready or scheduled): `new_article_flow` again, with the post's current body as `currentDraft` in the brief
  and the editor's optional instructions as feedback; the writer gets REVISE_TASK (keep what is correct, fix, complete,
  cut) instead of WRITE_TASK. The new run snapshots the post as it is, so the handoff replaces it only if nobody edits it
  meanwhile. A scheduled post goes back to draft first.
- **Schedule** (`lib/seo-intel/calendar-schedule.ts`, the only new module allowed to change a post): a person's Schedule
  calls `publishPost` with that future date in their name, exactly as the editor's Schedule button, and the CMS's own
  scheduler publishes it then. It schedules only what the person could read: a written draft (not the outline) with no
  fact-check errors from the agent, valid to publish, at least two minutes ahead (publishing now stays the editor's
  button). Otherwise the date is kept with a note saying why; a missing draft is generated, and the person reviews it
  and presses Schedule again. Nothing schedules on its own: no agent, job or tick imports the module (a test enforces
  the importers and the checks). Unschedule, Delete and Improve put a scheduled post back to draft.
- AGENTS.md rule 10 still holds: the person's Schedule on a draft they could read is the approval; the agent never
  schedules or publishes.

## D-95 Editorial calendar ideas added automatically from the AI, ML, Google Analytics and Search Console (owner request 2026-11-18)

"Content calendar items should add automatically based on the ML/AI/Google Analytics and Search Console data. User can
add manually also can delete." Search Console content gaps and editorial ideas were already added (editorial.ts);
`lib/seo-intel/calendar-auto.ts` adds the rest after the same weekly run (recommendations.ts):

- **AI, readers:** Ask-the-Blog question clusters asked at least 2 times that no article answered (`seo_ask_gaps`,
  through the existing `sendGapToCalendar`).
- **AI, Promotion:** the Promotion crew's ideas scoring "high" (≥ 70; `seo_content_ideas`, through `updateIdea`).
- **ML:** `seo_ml_query_clusters` labels with ≥ 100 Search Console impressions in 28 days that no published article's
  title covers; fingerprinted like a Search Console gap for that query, so a subject is on the calendar once.
- **Google Analytics:** for the ten articles with the most engaged sessions (≥ 20 in 28 days), the next uncovered topic
  of their theme, with the article as an internal link; fingerprinted like editorial.ts's idea for that topic.
- **Limits:** at most 2 per source a run; nothing while 12 automatic items are open (no post, no date). A source that
  fails is logged and skipped. Items carry `brief.source` (ask, promotion, ml, analytics) for the calendar's Source
  filter and land unscheduled; a deleted item keeps its fingerprint and is not added again. Nothing is drafted,
  scheduled or published automatically (D-94).

## D-96 Agent skills for every crew, managed on AI room → Skills (owner request 2026-11-18)

"Add skills to each AI run … enable a skills menu and manage skills from there, add default skills, additionally admin
can add more skills." Details: CREWS.md "Skills".

- **CrewAI's own Agent Skills, activated.** crewai 1.15.34 has `Agent(skills=…)`. Skills are passed as `Skill` objects
  at INSTRUCTIONS level, so their full text is in the system prompt (cached with it). Not used: path skills with
  progressive disclosure (CrewAI then adds a `load_skill` tool outside our allowlist, and the model may not call it),
  and registry refs (downloads from CrewAI's platform at run time, which the crews keep off).
- **Stored by the web app, read through the callback API.** Like the news writing profiles, the web app owns the data
  and the admin page; unlike them, the agent reads skills over `GET /internal/seo-agent/skills` instead of a database
  grant, so a skill change needs no agent deploy and the agent's role is unchanged. Defaults live in code
  (`DEFAULT_SKILLS`) and are inserted when missing, so they are reviewed like code and Reset can restore them.
- **Chosen by code from signals the run already has, not by the model.** Tags come from the brief's intent and source,
  the recommendation categories, the news classifier's topics and mode, and the report period. Where a calendar item
  has no intent (ML query clusters, ideas added by hand), `calendarBrief` takes the ML intent model's prediction for its
  queries, only when the model is in use (mlDecision) and the prediction is above the model's threshold. So the ML that
  picks a topic (query clusters, D-95) also picks how it is written (intent → skill).
- **Admin-only, instructions by design.** Skills are trusted text from admins (seoRoute: admin, same-origin, rate
  limit, audit), placed outside the `<data>` blocks. Guards: no `<skill>` tags in a skill, length caps per skill and per
  agent, and "the task wins" over a skill, so a skill cannot change an output format the code parses.
- **Not given skills:** the single-shot calls outside the crews (news classification and vision checks, the style
  review, ML labelling, the RAG-eval judge, Ask the Blog). They are classifiers, checks or a judge with fixed rules,
  and their prompt versions are measured; guidance there would move those measurements.

## D-97 CrewAI console: run history like GitHub Actions and Jenkins (owner request 2026-11-18)

"seo-agent crews and jobs can be managed from jithendar.com/admin/crewai, can see all run logs like github actions …
make it like enterprise applications … inspire from gh actions jenkins jobs." The owner accepted a phased plan and four
choices: built-in flows keep their structure in code and get an editable, versioned configuration (phase 3); schedules
move from the CronJobs to the database with one dispatcher (phase 2); full prompts and answers are kept, 14 days, with
a switch; admins edit, authors have no access, a demo account reads. This entry is phase 1: runs and logs.
Details: FLOWS.md "Run history (CrewAI console)".

- **The agent writes, the web app reads.** Steps, log lines and transcripts go straight into the shared database
  (migration 0036), like `seo_llm_usage`, so the run page streams them without asking the agent, and history stays
  readable while the agent is off. Starting and cancelling still go through the agent's API.
- **The log is the agent's own structured log**, not a second logging system: a root handler copies the records of a
  run into the table, so every existing `log.info(..., extra={"event": …})` appears in the console with its fields,
  and Loki keeps getting the same lines. New lines only where the console needed them: a crew task starting, and one
  line per model call.
- **Run numbers by a trigger,** so the agent's insert is unchanged and an older agent still gets numbers; a refused
  second active run takes none (no gaps from the one-active-run rule).
- **Transcripts on by default, bounded:** each text is cut at 200,000 characters, kept 14 days, and the switch (Automation
  & AI → settings → Run history) applies to the agent's next call within a minute. Prompts hold the site's own content
  and tool results, no secrets (the agent never puts a credential in a prompt).
- **Re-run only where it is safe from a console:** drafting flows keep one open draft per article (Regenerate in the
  review queue), publish_flow starts only from an approval, and per-story news runs have their own retry.
- **No new dependency.** Icons are inline SVG; the per-day chart is plain HTML.

## D-98 CrewAI console, phases 2–3: schedules in the database, Run with parameters, crew versions and Test run, import / export (owner request 2026-11-19)

"Replace the 15 CronJobs with one dispatcher and schedules stored in the database, Run with parameters from the UI, a
crew editor with versioned prompts and a test-run button, like Jenkins Replay, and enable import export of
configurations." Phases 2 and 3 of D-97, as accepted on 2026-11-18. Details: FLOWS.md "Scheduling", CREWS.md
"Configuration versions and Test run", the user guide's CrewAI console entries.

- **One dispatcher, called by one CronJob every minute, not a scheduler loop in the agent.** That is the accepted
  design, it keeps "is anything firing" visible as Kubernetes Jobs, and a suspended CronJob pauses everything. The
  agent does the work (`POST /schedules/dispatch`): which times are due, in each schedule's own time zone, with the
  cron evaluator the news desk already uses. Cost: one short pod a minute instead of fifteen spread over the week.
- **Exactly once per time slot, without a lease:** one conditional `UPDATE … where last_slot < slot`. A retried
  CronJob, two calls or two pods start a slot once; the flow's own one-active-run lock still applies on top.
- **No surprise runs:** `armed_at` moves when the cron, time zone or switch changes, and the dispatcher never fires a
  time at or before it. Missed times (agent down) run late within an hour, and only the latest, like
  `startingDeadlineSeconds: 3600` with `concurrencyPolicy: Forbid` before.
- **The fifteen schedules are built-in rows of migration 0037** (same times, UTC), with their defaults on the row, so
  Reset needs no copy of them in code. They were site configuration in jithendar.com's manifests; they are now product
  defaults every site gets, and import / export carries a site's own times.
- **The agent may write five columns of the schedules table** (`last_*`, column grants in scripts/db-role.sql) and
  nothing else of the console's configuration. Crew versions reach it through the callback API, like the skills.
- **Run with parameters uses the flows' own input models** (JSON Schema from Pydantic), so the form never drifts from
  what the agent accepts, and the agent validates again. Same limits as Re-run: no drafting, publish or per-story news
  flows from the console.
- **Crew configuration is an overlay on code, never code:** text, models, limits and tools from the crew's own set.
  Output contracts and safety rules stay in code and are shown as "Added by the code". Custom crews and flows (phase 4
  of D-97) are not part of this.
- **Test run replays the crew, not the flow:** it starts from the source run's persisted state, so it needs no
  dry-run mode in every flow and cannot write a draft, report, post or article. The configuration under test is in
  the run's inputs, so the run records exactly what it ran and can be saved as a version from its page.
- **Import is a plan first and only adds or changes** (nothing deleted or paused); crews are checked by the agent,
  schedules matched by name. No secrets, IDs or run history in the file.
- **No new dependency.** The word diff uses `diff`, already a dependency.

## D-99 Flows and crews only: crew jobs are content flows (owner request 2026-11-23)

"Make only crews, flows, no jobs, merge it." AI & SEO had Jobs (content jobs and system jobs), Job runs, Flow runs,
Flows and Crews: three words for things that all start a flow. Now it has Flows, Runs and Crews (moks-cms #190,
moks-seo-agent #32).

- **A crew job is a content flow,** shown with the other flows (AI & SEO → Flows: Content flows, Custom flows, Built-in
  flows). It is a saved flow configuration with its own schedule, exactly what the `news_jobs` row already was, so it
  keeps its table, its versions, its editor and its dispatcher path; only the names and pages change.
- **No data moves.** Tables (`news_jobs`, `news_runs`, `seo_flow_schedules`), API routes (`/api/admin/news/*`), flow ids
  (`news_job_flow`), metric names and alert names stay. Renaming them would touch both repositories' migrations,
  dashboards and alerts for no difference anyone sees. Migration 0040 only rewords one built-in schedule's description.
- **One Runs list.** A content flow's run already has its flow run's id (moks-seo-agent `app/flows/news.py` `open_run`),
  so the Job runs page is a panel on the flow run's page (timeline, articles, candidates, retry / rerun) and the Runs
  list shows such a run under the content flow's name; `?content=<id>` filters to one content flow.
- **Schedules stay one table for the built-in and custom flows** (`/admin/crewai/schedules`, linked from Flows); a
  content flow's time stays on the content flow. Both are started by the same one dispatcher (D-98), as before.
- **Old addresses keep working**: `/admin/crewai/jobs/*` and `/admin/news/*` redirect (`src/lib/news/old-addresses.ts`).
- **MCP follows:** `list_content_flows`, `get_content_flow`, `run_content_flow` replace `list_news_jobs`,
  `get_news_job`, `kickoff_news_job`; an old name in `MCP_ADMIN_TOOLS_OFF` still switches the renamed tool off. The old
  names are not kept as aliases: duplicate tools would confuse a client choosing between them.

## D-100 One catalogue of crews and flows; AI & SEO follows the SEO agent module (owner brief 2026-11-24)

The brief: every crew and every flow can be created, edited, duplicated, switched off, deleted and filtered the same
way; no system, custom, content or SEO kinds; categories and tags for organisation only; one engine; the AI & SEO menu
only when the SEO agent is there; no Skills/Content settings inside the crew console; structured, redacted run logs.
Built in moks-cms (this repository) and moks-seo-agent, one PR each. Guide: [CATALOGUE.md](CATALOGUE.md).

- **One table per entity.** `crewai_crews` and `crewai_flows` (migration 0041) hold every crew and every flow with the
  same columns: name, description (and a crew's objective), categories, tags, on/off, deleted, created/changed. Where a
  row's work is defined (`definition`: code, spec, content) only decides how it is edited and run. It is not a kind: it
  is not shown as one, not filtered on, and every action (edit, duplicate, switch, delete, restore) exists for all.
- **What stays code, and why.** The agent's own crews and flows are Python with logic around the model (drafts, the
  approval gate, syncs). Their prompts, models, tools and limits stay editable as versions (D-98); their structure
  stays in code, because their flows read those agents and tasks by key. Duplicate turns any of them into a spec that
  can be changed entirely: a code crew becomes a spec crew (materialized by the agent from its active version, with the
  tools that need no fixed article), a code flow becomes a step flow whose first step starts it.
- **One engine.** Step flows run on the agent's generic engine, which now runs any crew (spec or code), starts any other
  flow as a step (never an approval-only one or the console's test run), and gives every step needs, a condition,
  retries with backoff, a time limit and stop / continue / fallback. Code flows are started by the same runner, which
  now refuses any flow switched off here, whoever starts it (GET /flow-switches).
- **Categories are data.** `crewai_categories` is seeded with SEO, Content, AI, Automation, Research, Monitoring and
  Custom; admins add, rename (the slug stays) and remove them. The agent serves default categories for its own flows
  (used once, when a row is added) and never reads them; a test checks the engine modules do not mention them.
- **Old rows move, nothing is lost.** seo_custom_crews / seo_custom_flows rows are copied with their keys, specs,
  versions, switches, deletions and times; every content flow (news_jobs) gets a row, kept in step by a trigger; the
  old tables stay until the copy is checked on mk4, then a later migration drops them. Old routes
  (`/api/admin/crewai/custom/*`, `/admin/crewai/*/custom/*`, `?kind=`) keep working.
- **Deleting keeps the row** (run history names it) and is restorable; a crew a flow runs cannot be deleted or switched
  off; a flow whose crew is off cannot be switched on. A spec flow's schedules are removed, a code flow's paused.
- **The SEO agent is a module** (`lib/modules.ts`): installed when an endpoint is set or found, available when it
  answers. AI & SEO is drawn only while it is installed, so a set-up agent that is briefly down keeps its menu (its pages
  say it is off) and a site without one has no menu and no empty pages; it is set up under Settings → Integrations →
  SEO agent. GET /api/admin/capabilities serves the same answer. No hard-coded flag decides the menu.
- **The console is crews and flows only**: its Skills ↗, Content ↗ and Settings ↗ tabs are gone (those pages are in the
  AI & SEO menu); skills work exactly as before (D-96), and Import / export still carries them.
- **Logs**: the agent redacts every log line, step detail and transcript (by key and by shape) before storing it; each
  step records attempts, conditions, versions, child runs, tokens, cost and short input/output previews; two new Run
  history switches (`logs`, `stepIo`, both on) decide what is kept. Retention is as before.

## D-101 The CrewAI configuration as files in the site's repository (owner brief 2026-11-24)

The brief: the Import / export file had schedules but empty `crews` and `skills`, and no flows, agents, tasks or tools;
make the whole configuration exportable, versioned in Git in the site repository (`crewconfig/`), managed from the
admin, and restored automatically after each Kubernetes deployment. Built in moks-cms (this repository), moks-seo-agent
(GET /config-catalogue) and jithendar.com (crewconfig/, its check and the deploy stage). Guide:
[CREWCONFIG.md](CREWCONFIG.md).

- **Root cause.** Format 1 exported crew versions (none while a crew runs on its code defaults) and only added or edited
  skills (the shipped ones were left out), and nothing else. Format 2 discovers everything when it exports.
- **Files, not one JSON.** One file per crew, agent, task, flow and skill (Markdown bodies for the long texts) so a
  change is a readable diff; collections for schedules, sources and categories; JSON Schemas generated from the same zod
  schemas the importer uses, so the site repository's own check needs no copy of them.
- **The database stays the runtime; Git is the source a deployment restores.** Rows are not replaced by files: the
  catalogue, crew versions, skills, schedules and content flows keep their tables and pages. The bundle is their
  portable form, and `crewai_config_syncs` records each import and export with its Git revision, a baseline for drift,
  and a snapshot for rollback. A second, file-backed configuration store would have been a duplicate system.
- **Conflicts have a rule.** An item changed here since the last sync is never overwritten by a deployment (`skip`);
  the admin, who sees the plan, overwrites by default. Without an earlier sync every difference is a conflict, so the
  first deployment after bootstrapping crewconfig/ only adds what is missing.
- **One transaction, verified.** Every write function used by the import takes the caller's transaction; the import
  exports again inside it and rolls back on any difference. A refused item refuses the import unless asked otherwise.
- **Code stays code.** Code crews and flows keep their structure in the agent; the bundle changes only what their pages
  change. Nothing in a bundle runs: YAML core schema, zod, then the agent's own checks.
- **Git access is one fine-grained token on one repository**, saved sealed in the admin or given to the deployment as a
  Secret; saves are commits or pull requests with conflict detection by base commit and blob. Deployments use an API key
  with the new `crewai:read` / `crewai:import` scopes (admins only), never cluster credentials.

## D-102 One report system for the CrewAI console and SEO-AI reports (owner brief 2026-11-24)

- **One table.** `seo_reports` (D-59's weekly / monthly briefings) also holds console reports (`request` set) rather
  than a second table; the briefings' uniqueness moved to a partial index. Deliveries are their own table because one
  report has many emails and each needs its status. See docs/seo/REPORTS.md.
- **Who does what.** The web app owns the data (its own database), R2, email, RBAC and audit, and builds reports in its
  existing job queue; the SEO agent owns every LLM call (budget, run history, cost ledger) and the PDF (ReportLab, as for
  the briefing), through report_flow with a `report_id`. No new service.
- **The AI explains, code decides what is true.** Findings are rules over the figures; the Report crew's analysis is
  kept only where its numbers are the report's figures and its items cite the report's evidence; "confirmed" needs
  direct evidence. A source that is not there is reported, never filled in; costs are recorded costs only.
- **Degrade, do not fail.** Without the agent, the LLM budget, R2 or email, a report is still made with what can be
  made, and says what is missing.

## D-103 LanceDB removed; the article index is browsed in pgvector (owner decision 2026-11-26)

Replaces D-91, D-92 and D-93; D-47's override is back.

- **Why.** LanceDB only ever held D-93's copy of `seo_article_chunks` on R2, and nothing searched it: Ask the Blog and
  the crews search pgvector, CrewAI memory (D-91 step 1) was never built, and the LanceDB retriever (step 3, second
  half) never came. Measured on 2026-11-24: a query on the R2 copy took about 730 ms against 3.5 ms in pgvector, and
  the copy drifted (a deleted article's chunks stayed). The owner asked for it to be removed completely.
- **Removed.** In the agent: `app/lance_index.py` (the copy), `app/lance_admin.py` and `/lancedb*` (the browser), the
  `LANCEDB_ARTICLE_INDEX` setting, and the dependency (`override-dependencies` drops lancedb, pyarrow and
  lance-namespace, about 105 MiB of image). In the web app: `/admin/lancedb` (now a redirect), its client calls and
  `GET /internal/seo-agent/storage/lancedb`, which handed the agent the media bucket's keys. The agent no longer gets
  any storage keys from the web app.
- **Added: Article index (AI & SEO → Models & data, `/admin/article-index`).** A read-only view of pgvector through the
  agent's `GET /chunks…` routes (moks-seo-agent `app/chunk_browser.py`), because the agent owns the tables and their
  vector size follows the model: counts, model, vector column, index method, size; articles with chunk counts and
  status; one article's chunks; a text search over chunks; one chunk in full with its nearest chunks. During a
  rebuild after an embeddings model change it shows the new table beside the live one and how far the rebuild has got.
- **Read-only on purpose.** D-92 allowed one-row edits because LanceDB was a copy. In pgvector a chunk edited by hand
  would no longer match its vector, and the next reindex rewrites it anyway: change the article instead.
- **Left to the owner.** The files under `jithendar/seo-agent/lancedb/` in the media bucket: nothing reads or writes
  them any more; delete them in the Cloudflare dashboard.

## D-104 Published posts synced to the shared Hybrid RAG service, moks-rag (owner brief 2026-11-26)

- **What.** Published posts are kept in moks-rag's `cms_content` collection (rag-api in namespace `rag`: bge-m3
  dense + BM25 sparse vectors in Qdrant, RRF fusion), so Open WebUI's `moks-cms` model and other services can search the
  site's content by meaning. `docs/RAG.md`.
- **How.** Every post change that readers could or can see queues a `rag_sync` job per address (Postgres job queue,
  run by the worker in the site pods). The job reads the post when it runs: visible → `POST /ingest`; otherwise
  `DELETE /documents/{collection}:{slug}?collection=cms_content`. Saving and publishing never call rag-api, so its
  outage never blocks the editor: 10 s timeout, two quick retries on 5xx/timeouts, then the queue's backoff
  (8 attempts, about two hours). Admin → Integrations → Hybrid RAG: settings, sync status, Reindex all posts
  (the backfill) and a test search (`POST /query`, `include_answer: false`).
- **Same rule as the SEO agent's index.** Only what every reader can see: members-only posts send their free preview,
  noindex posts are left out. This is a second, independent index: the SEO agent keeps its own pgvector index for Ask
  the Blog and the crews; nothing here changes it.
- **Off by default.** Nothing is sent until `RAG_BEARER_TOKEN` is set (deployment Secret `jithendar-com-rag`, or the
  admin). A site that buys moks-cms without moks-rag sees no change.

## D-105 The SEO agent is part of moks-cms again: one repository, one Dockerfile, one image, one Deployment (owner decision 2026-11-26)

- **What.** mrjithendar/moks-seo-agent is merged into this repository as `seo-agent/`, with its whole history (a
  subtree merge of its master at b4f058f). There is one `Dockerfile` (`Dockerfile.ci` is gone) and one image,
  `registry.jithendar.com/jithendar/moks-cms`: the web app's standalone build and the agent's virtualenv and ONNX
  models, on python:3.13-slim-trixie with Node's binary from node:26-trixie-slim (Debian: the agent's wheels and sharp
  need glibc). `seo-agent:latest` is no longer built. The owner's words: "only 1 application one docker file for cms
  and seo", and, asked how it runs, "one container runs both" over two Deployments.
- **How it runs.** One Deployment, the site's: each site pod runs the image as two containers, `web` (the default
  command, `node server.js`) and `seo-agent` (`python -m app.main`, workingDir `/srv`, user 10001). The site calls its
  own pod's agent (`SEO_AGENT_URL=http://127.0.0.1:8080`). The `seo-agent` and `seo-agent-mcp` Services, the metrics
  Service (Prometheus job `seo-agent`) and the agent's NetworkPolicy select the site's pods. The dispatcher CronJob runs
  the same image (`python -m app.trigger dispatch`). Manifests: jithendar.com `kubernetes/30-jithendar-com.yaml`.
- **Two containers, not one process.** The site and the agent share variable names with different values
  (`OTEL_SERVICE_NAME` jithendar-com / seo-agent, `LOG_LEVEL` info / INFO), and each needs its own memory limit (a crew
  run that runs out of memory must restart the agent, not the site) and probes. Containers of one pod give all of that
  and still start, scale and stop together.
- **Several agents (app/runs.py).** KEDA runs 2 to 8 site pods, so 2 to 8 agents share one database. Until now the agent
  assumed one replica (Recreate): at start-up it failed every queued/running run, and a cancel only stopped a run in its
  own process. Now each run executes in the agent that started it and its Postgres advisory lock says that agent is
  alive. Every agent sweeps, at start-up and every 60 s, only runs whose lock nobody holds (or older than the flow
  wall-clock limit + 5 min, for a lock a dead node's connection still holds), never rows younger than 30 s (a kickoff
  takes its lock just after creating its row). Every 5 s it cancels a run of its own whose row another agent ended (a
  cancel that reached another pod, or a sweep), keeping that agent's status. `wait()` on another agent's run follows
  its row. The schedule dispatcher already claimed each time slot in the database, the MCP servers are stateless and
  live settings were already re-read every period. Tests: `seo-agent/tests/test_several_agents.py`, and on Postgres
  `test_an_agent_sweeps_only_the_runs_whose_lock_nobody_holds`.
- **Known limits.** The LLM budget's in-flight reservations are per agent: with N pods, calls that start at the same
  moment in different pods can go over the budget by at most N-1 calls' estimates (booked spend is shared). The public
  MCP server's daily limits are counted per agent, so per pod (MCP.md). A manual news ingest in one pod while a
  scheduled one runs in another can fetch a source twice (items stay unique). Every site
  rollout and scale-down now ends the flow runs of the pods it stops (they are swept as "interrupted by a restart"; a
  rerun starts from the beginning), where before only agent releases did. Every site pod pulls the agent's layers
  (about 480 MB compressed) and reserves its memory too (request 768Mi, limit 1280Mi per pod). Gauges every agent sets
  from the database (drafts awaiting review, last success, budget ratio) now come from every pod: read them with
  `max()`, not `sum()` (the dashboards and alerts already do).
- **CI.** `ci-moks-cms.yml` has a `seo-agent` job (ruff, mypy, pytest with pgvector, the RAG eval smoke, pip-audit) on
  the same events as `check`. The contract tests read this repository directly (`seo-agent/tests/moks_cms.py`), so they
  run in CI for the first time. `image` and `release` build `Dockerfile` and smoke-test the image as the site and as
  the agent (`scripts/smoke-seo-agent-image.sh`); `release` waits for `seo-agent` like it waits for `check` and `test`.
  The manual retrieval evaluation is `seo-agent-rag-eval.yml`. Dependabot updates `seo-agent/` (uv) from here.
- **Replaces** the "own repository, own image, no cross-repository credentials" layout of 2026-11-18 (moks-cms #145,
  #147; moks-seo-agent #3) and the agent's one-replica rule. `moks-seo-agent#N` in these docs refers to pull requests of
  the archived repository.

## D-106 One Settings area: every setting in one place, by category (owner brief 2026-11-26)

- **What.** Admin → Settings (`/admin/settings`) holds every setting of the admin and nothing else holds one. It is a
  directory of 13 categories (General, Users & access, Content & publishing, Email, Media & storage, Payments &
  bookings, AI & models, SEO agent, Assistants, Search & SEO, Integrations, Practice, System) with a search over
  section names and field labels, and one page per category (`/admin/settings/<category>?section=<id>`). The menu's
  Settings group lists the overview and the categories; AI & SEO no longer lists Settings and MCP. This is decision
  D2 of docs/SETTINGS.md ("one home per knob, under Settings by category"), which the owner's brief settles.
- **Where it is written down.** `src/lib/settings-areas.ts` (pure): the categories, the sections (id unique across
  all), which belong to the SEO agent module, the old addresses. `src/app/admin/settings/sections/index.ts`: what each
  section draws. The menu, the redirects, the user guide and the tests read the first; a test fails when the two
  disagree, when a section is drawn outside Settings, or when a `/admin/settings/...` link names a section of another
  category.
- **What moved, unchanged.** The forms of Integrations, Media & storage, Email and AI & SEO → Settings (each a
  section now), and the settings cards of Users (members-only, profile pictures), Cache (Cloudflare), Payments
  (Razorpay), Bookings (Cal.com), Invoices → Settings, Practice, Posts → Promotion (Settings tab), Tools → Backups
  (schedule, encryption, bucket), AI & SEO → Configuration (Settings tab) and Content sources (fetching). Same server
  actions, stores, validation, audit entries and permissions (admins only); only where they are drawn and where a save
  returns to changed. The feature pages keep their records and operations and end with a link to their settings.
- **Not moved.** The Appearance editor stays the one home of the site's design and identity: it is one draft with a
  live preview and one Publish, so drawing part of it elsewhere would let a Publish there push unrelated draft changes
  live. Settings → General shows the published identity, features and maintenance mode and links into Appearance;
  splitting General (D9) remains the owner's call. Per-user pages (Profile, API keys) and records that behave like
  settings (flow schedules, ML overrides, crews) stay where they are.
- **Gating.** The SEO agent's sections are listed only while the module is set up (lib/modules.ts), as its menu was;
  opened by address they say how to set it up. SEO agent → Connection, where it is set up, is always listed. Whether
  Search & SEO should be reachable without the agent (D7) is unchanged.
- **Merged.** The SEO agent's endpoint card was drawn twice (Integrations → SEO agent, AI & SEO → Settings → Overview):
  one section now, Settings → SEO agent → Connection.
- **Old addresses.** `/admin/integrations`, `/admin/storage`, `/admin/email`, `/admin/automation` (with the ids merged
  on 2026-11-23), `/admin/automation/mcp`, `/admin/invoices/settings`, `/admin/advanced`, Promotion `?tab=settings` and
  Configuration `?tab=settings` redirect to the section that has their settings, keeping the rest of the query.
  `/admin/settings`, which opened Appearance → General, is the overview now.
- **Fixed on the way.** Saving a runtime-settings group returned to `#group` on a sectioned page, which ignores
  anchors, so the page opened another section (docs/SETTINGS.md P1.10): it returns to `?section=<id>` now.
