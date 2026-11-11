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
`minikube/kong/seo-agent-mcp.deck.yaml` (tagged, for `deck --select-tag`), outside the kubectl glob, unapplied. Master
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
