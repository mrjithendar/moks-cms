# SEO intelligence platform: architecture, schema, API, configuration

Admin-only (role `admin`): ordinary CMS admin pages since D-86 (`/admin/search`, `/admin/review`, `/admin/automation`…; old `/admin/seo/*` URLs redirect). Reads Google Search Console (GSC) and GA4, turns the data into
evidence-backed recommendations, and feeds the CMS editor. **It never publishes or edits a post on its own.**

## Architecture

Everything runs inside the existing `jithendar-com` Deployment: no new service, queue, Redis or CronJob.

```mermaid
flowchart LR
  subgraph Google
    GSC[Search Console API<br/>searchAnalytics.query]
    GA4[Analytics Data API<br/>runReport / checkCompatibility]
    UI2[URL Inspection API<br/>optional]
    PSI[PageSpeed Insights<br/>optional]
  end
  subgraph Pod["jithendar-com pod (×2)"]
    W[worker tick 30 s<br/>src/lib/scheduler.ts] -->|seoTick: enqueue due slots| Q[(job table)]
    Q -->|runDueJobs| R[runSeoJob<br/>lease + seo_sync_jobs]
    R --> S[GSC / GA4 sync]
    R --> T[technical scan<br/>SSRF-safe crawler]
    R --> E[recommendation engine<br/>rules + scoring]
    R --> P[reports]
    E -. optional .-> LLM[callModel<br/>OpenAI-compatible / Gemini / Bedrock]
    API[/api/admin/seo/*<br/>seoRoute guard/] --> Q
    UI[/admin pages/] --> RM[read models<br/>queries.ts]
    API --> RM
    UI -->|accept proposal| AS[(autosave =<br/>editor working copy)]
    M[/metrics :9464/]
  end
  S --> GSC & GA4
  T -->|own host only| Site[https://jithendar.com]
  T -. optional .-> UI2 & PSI
  S & E & T & P & RM --> DB[(PostgreSQL<br/>seo_* tables)]
  AS --> Editor[Post editor<br/>human saves / publishes]
  M --> Prom[Prometheus → Grafana<br/>jithendar-com-seo]
```

### Data flow

```mermaid
sequenceDiagram
  participant Sched as seoTick (worker)
  participant Job as runSeoJob
  participant G as Google APIs
  participant DB as Postgres
  participant Admin as Admin (browser)
  participant Ed as Post editor
  Sched->>DB: enqueue gsc_sync for today's slot (once per slot)
  Job->>DB: acquire lease, insert seo_sync_jobs (running)
  Job->>G: date / page / query reports per search type (paginated, backoff)
  Job->>DB: upsert daily rows, prune revised rows, map URLs → articles
  Job->>DB: seo_sync_jobs = succeeded (rows, requests, retries)
  Sched->>DB: weekly: recommendations → rules → scored records + evidence
  Admin->>DB: approve / reject (audit_log)
  Admin->>DB: generate proposals for an article
  Admin->>DB: accept proposal → their autosave (working copy)
  Admin->>Ed: open editor → "Restore" autosave → review → Update/Publish (human)
  Sched->>DB: outcomes job: +28 / +56 day metrics for implemented items
```

### Modules (`services/www/src/lib/seo-intel/`)

| Module | Role |
|---|---|
| `settings.ts` | `setting` row `seo` (zod-validated, defaults, env fallbacks for property ids, sealed LLM key) |
| `google/auth.ts`, `google/http.ts` | Service-account JWT → token; Google calls with timeout, backoff + jitter, auth stop, request budget |
| `google/gsc.ts`, `google/ga4.ts` | Search Analytics query / runReport / checkCompatibility |
| `sync.ts`, `urls.ts`, `sqlutil.ts` | Normalise, aggregate, upsert, prune; URL → article mapping |
| `jobs.ts`, `handlers.ts` | Leases, run records, schedules, backfill continuation, retention; handler registry |
| `queries.ts` | Dashboard read models and source status (disconnected / never synced / stale / error) |
| `rules.ts`, `scoring.ts`, `data.ts`, `audit-article.ts` | Deterministic recommendation rules and scoring ([SCORING.md](SCORING.md)) |
| `recommendations.ts`, `llm.ts`, `editorial.ts` | Records + evidence, optional LLM explanation, editorial suggestions |
| `optimize.ts`, `article-panel.ts`, `calendar.ts` | Proposals → editor working copy, article panel, editorial calendar |
| `crawler.ts`, `technical.ts` | SSRF-safe fetcher, robots.txt, technical audit |
| `reports.ts` | Weekly/monthly reports, CSV, email via `sendMail` |
| `http.ts` | The single guard for `/api/admin/seo/*` |

## Schema (migration `0011_seo_intelligence.sql`, additive)

| Table | Key | Notes |
|---|---|---|
| `seo_integrations` | `provider` | gsc / ga4: property id, status (`connected`, `auth_error`, `error`), last verified, last error, `config.timeZone` |
| `seo_sync_jobs` | `id` | job type, trigger, window, status, start/finish, rows, API requests, retries, error, error code, correlation id, actor, detail (slot, traceId) |
| `seo_job_locks` | `job_type` | lease (one run per type across replicas) |
| `seo_gsc_daily_totals` | date × search_type | **source of truth for site totals** |
| `seo_gsc_page_daily` | date × page × search_type × device × country | page totals |
| `seo_gsc_query_daily` | date × page × query × search_type × device × country | **partial coverage** (anonymised queries excluded) |
| `seo_ga4_page_daily` | date × landing page × channel × device × country × new/returning | GA4 metrics (never mixed with clicks) |
| `seo_url_map` | normalised URL | → `post.id` (nullable, `ON DELETE SET NULL`) |
| `seo_recommendations` (+ `_evidence`) | `id`, unique `fingerprint` | see SCORING.md; baseline + 28/56-day outcomes |
| `seo_content_audits`, `seo_internal_link_suggestions` | | per article |
| `seo_editorial_calendar` | `id`, unique `fingerprint` | linked to recommendation / post / owner |
| `seo_article_optimizations` | `id` | field, current, proposed, source, base version, status, previous working copy (rollback) |
| `seo_reports` | period type × start | payload JSON, emailed_at |
| `seo_technical_scans`, `seo_technical_issues` | | crawl results |
| `seo_llm_cache` | input hash × prompt version | validated outputs + tokens |

Reused instead of new tables: `setting` (key `seo`) for settings, `audit_log` (`seo.*` actions) for audit, `revision` +
`autosave` for versioning (DECISIONS.md D-04/05/06). Indexes cover `(page, date)`, `(query, date)`, `(date, search_type)`
and the status/score lists the dashboard reads. Retention: daily tables keep `sync.retentionMonths` (default 16).

**URL normalisation:** site hosts (apex and `www.`) → canonical https origin; query and fragment dropped; trailing slash
removed; path lower-cased (all site routes are lower-case); duplicate slashes collapsed. Rows that normalise to the same
URL are summed, with impression-weighted position.

## API (`/api/admin/seo/…`, admin only)

Every route: 401 without a session, 403 for non-admins, same-origin `Origin` on mutations, rate limit per admin and
route, zod validation (400 + `issues`), audit log on mutations, `no-store` + `noindex`, redacted 500s with a reference.

| Method | Path | Purpose |
|---|---|---|
| GET | `overview`, `search-console`, `analytics`, `pages`, `keywords` | read models; query: `range=7\|28\|90\|custom`, `start`, `end`, `page`, `category`, `query`, `device`, `country`, `searchType`, `sort`, `limit`, `offset` |
| GET | `recommendations` | `status`, `category`, `band`, `articleId`, `limit`, `offset` |
| POST | `recommendations/generate` | queue a run (5 / 10 min) |
| PATCH | `recommendations/{id}` | `{ reviewStatus?, implementationStatus?, note? }` (implementation requires approval) |
| GET | `articles/{id}/audit` | article panel data |
| POST | `articles/{id}/optimize` | (re)generate proposals |
| PATCH | `optimizations/{id}` | `{ action: accept \| reject \| rollback }` (accept → your editor working copy) |
| GET, POST | `calendar` | list (`from`, `to`, `status`) / create `{ title, category?, targetDate?, notes? }` |
| PATCH | `calendar/{id}` | `{ status?, targetDate?, ownerId?, postId?, title? }` (flow-checked) |
| POST | `calendar/{id}/draft` | create a **draft** post from an approved item |
| GET | `reports` | list |
| POST | `reports/generate` | `{ type: weekly \| monthly }` |
| GET | `reports/{id}/csv` | CSV export |
| GET | `technical` · POST `technical/scan` | latest scan / queue a crawl (3 / h) |
| GET | `integrations` · POST `integrations/test` | state / real test request per provider (6 / 10 min) |
| POST | `sync` | `{ source: gsc\|ga4\|both, mode: sync\|backfill, months? }` (5 / 10 min) |
| GET | `sync/history` | runs (`limit`, `offset`, `jobType`) |
| GET, PUT | `settings` | settings (LLM key only as `llmKeySet`; `llmApiKey` write-only) |

## Configuration

| Variable | Where | Required | Purpose |
|---|---|---|---|
| `GOOGLE_SEO_SERVICE_ACCOUNT_JSON` | Secret `jithendar-com-env` | for Google data | Service-account JSON key, raw or base64 |
| `SEO_GSC_PROPERTY` | ConfigMap `jithendar-com-public` | optional | `sc-domain:jithendar.com` or `https://jithendar.com/`; Settings override it |
| `SEO_GA4_PROPERTY_ID` | ConfigMap `jithendar-com-public` | optional | Numeric GA4 property id; Settings override it |
| `PAGESPEED_API_KEY` | Secret | optional | Only used when PageSpeed is enabled in Settings |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Secret `jithendar-com-env` | optional | DataForSEO API (volume, difficulty, live ranks, backlinks); only used when switched on in Settings ([DATAFORSEO.md](DATAFORSEO.md)) |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | Secret (existing) | optional | Fallback for the LLM key when none is saved in Settings |
| `SETTINGS_ENCRYPTION_KEY` | Secret (existing) | yes (prod) | Seals the optional LLM key |
| `SITE_URL` | Deployment (existing) | yes | Canonical origin; crawler allowlist |

All schedules, thresholds, weights, crawler limits, LLM provider/model and report recipients are in Settings
(`/admin/automation`).

## Local development

```bash
cd www && export PATH=/opt/homebrew/bin:$PATH
npx tsx scripts/seo-seed-fixtures.ts   # DEMO DATA into .data/pglite (refuses if DATABASE_URL is set)
npm run dev                            # http://localhost:3000/admin (sign in as an admin; search pages are in the sidebar)
npx vitest run tests/seo-intel-*       # the platform's tests (fake Google, PGlite)
```

Without `GOOGLE_SEO_SERVICE_ACCOUNT_JSON`, every view shows the **Disconnected** state over whatever (fixture) data
exists. The fixture key and numbers in `tests/seo-fixtures.ts` are invented; never use them as real data.

---

# v2: drafts, review, submission, linking, keywords

## Architecture (v2 additions)

```mermaid
flowchart LR
  subgraph App["jithendar-com pods (existing worker, no new workloads)"]
    REC["Recommendations (v1)"] --> DR["drafts.ts<br/>eligibility · prompt · merge/regenerate"]
    DR -->|"structured JSON (output_config.format)<br/>cached system: rules + style guide"| LLM["callModel provider 'anthropic'<br/>+ claude.ts (usage, budget, batches)"]
    LLM --> VAL["changeset.ts validators<br/>(code untouched, no invented URLs,<br/>lengths, duplicates, rewrite %)"]
    LINKS["internal-links.ts<br/>(rule-based, hard limits)"] --> VAL
    VAL --> Q[("seo_drafts<br/>ready_for_review")]
    Q --> UI["/admin/review<br/>diff view (jsdiff)"]
    UI -->|"Approve (one article, admin)"| PUB["publish.ts → updatePost()<br/>(CMS update path, base-version guard)"]
    PUB --> VER["seo_verify job<br/>200 · canonical · noindex · title · JSON-LD"]
    VER -->|pass| SUB["submission.ts"]
    VER -->|fail| ALERT["alert + one-click rollback"]
    KW["keywords.ts<br/>site CTR curve · views · clusters"] -->|"intent (Haiku, cached)"| LLM
    KW -->|"Draft optimization"| DR
  end
  LLM -->|"Messages / Message Batches"| ANT["Anthropic API"]
  SUB -->|"batched POST"| IDX["IndexNow (Bing, Yandex, …)"]
  SUB -->|"sitemaps.submit (write scope)"| GSC["Search Console API"]
  SUB -->|"+60 h URL Inspection"| GSC
```

## Data flow: from recommendation to live page

```mermaid
sequenceDiagram
  participant W as Worker (30 s tick)
  participant D as drafts.ts
  participant C as Claude
  participant A as Admin (phone)
  participant P as publish.ts
  participant S as Search engines
  W->>D: drafts_weekly (batch) / seo_draft job (on demand)
  D->>C: change set request (data blocks, no tools)
  C-->>D: JSON change set
  D->>D: validate (retry once with feedback) → seo_drafts ready_for_review
  W-->>A: weekly digest (if recipients set)
  A->>A: accept / reject / edit each change
  A->>P: Approve & publish (confirm)
  P->>P: updatePost (revision "seo-draft"), revalidate, baseline metrics
  W->>P: seo_verify (+40 s): fetch live page, check
  P->>S: IndexNow batch, sitemap resubmit, URL Inspection +60 h
  Note over P,S: verification fails → nothing submitted, alert, rollback offered
  W->>P: outcomes job: metrics at +28 / +56 days
```

## v2 modules (`services/www/src/lib/seo-intel/`)

| Module | Purpose |
|---|---|
| `../practice/ai/anthropic.ts` | Claude provider for `callModel` (SDK, structured output, prompt caching, refusal fallback) |
| `claude.ts` | prices, `seo_llm_usage`, monthly budget (+ batch reservations), `claudeJson` (validated, one retry), Message Batches |
| `changeset.ts` | Markdown blocks with ids, atomic changes, apply, validators, substantive-change rule |
| `diff-model.ts` | rendered-token word diffs, line diffs, counts, SERP truncation (isomorphic) |
| `drafts.ts` | eligibility, prompt, generate / merge / regenerate, weekly batch + results, queue, decisions, reject |
| `publish.ts` | approve, schedule, publish via `updatePost`, verification, rollback, draft outcomes (only module that writes posts) |
| `submission.ts` | IndexNow batches, sitemap resubmission, URL Inspection, submission log + timeline |
| `internal-links.ts` | link planner (limits in INTERNAL_LINKING.md), link graph, report |
| `issue-details.ts` | located issues + score breakdown behind Content optimization numbers |
| `keywords.ts` | site CTR curve, click gap, opportunity views (SQL), cannibalization, gaps, clusters, intent, tracked keywords |
| `overview-v2.ts` | daily series, top movers, health score, annotations, onboarding checklist |
| `notify.ts` | digest and alerts through `sendMail` (only with recipients) |
| `style-guide.ts` | generated from the articles (`scripts/seo-style-guide.ts`) |

## v2 schema (additive)

| Migration | Tables |
|---|---|
| `0012_seo_drafts.sql` | `seo_drafts` (one open per article: partial unique index), `seo_llm_usage`, `seo_llm_batches` |
| `0013_seo_submissions.sql` | `seo_search_submissions` |
| `0014_seo_keywords.sql` | `seo_query_intents`, `seo_query_clusters`, `seo_tracked_keywords`, `seo_keyword_ignores`, `seo_saved_views`; index on `seo_gsc_query_daily (search_type, date, query)` |

Rollbacks in `src/db/rollback/` — run **newest first** (0014 → 0013 → 0012).

## v2 API (`/api/admin/seo/…`, admin only, same guard as v1)

`POST drafts` · `GET drafts/{id}` · `PATCH drafts/{id}/changes/{changeId}` · `POST drafts/{id}/approve|reject|rollback|regenerate`
· `POST review/bulk-reject` · `GET content/{id}/details` · `POST keywords/actions` · `GET keywords/export` ·
`GET|POST|DELETE views` · `GET palette`. No bulk-approve endpoint exists.

## v2 configuration

Env: `ANTHROPIC_API_KEY` (Secret), `SEO_DRAFT_MODEL`, `SEO_CLASSIFY_MODEL`, `SEO_LLM_MONTHLY_BUDGET_USD`,
`SEO_LLM_PRICES_JSON`, `SEO_SUBMISSION_ENABLED`, `SEO_SUBMIT_DEBOUNCE_MS`; E2E only (ignored in production):
`SEO_VERIFY_FETCH_ORIGIN`. Settings sections: `drafts`, `links`, `submission`, `keywords`.
