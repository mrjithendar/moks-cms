# SEO intelligence platform: progress

Re-read this file (and DECISIONS.md) before continuing after a context reset.

Branch: `feature/ai-seo-intelligence-platform` (from `master` @ `91954b5`).

## Baseline (before any change, 2026-11-09)

- `npm test`: 45 files, 474 tests, all passed (54 s).

## Phase status

| Phase | Status |
|---|---|
| 1 Discovery and plan | done |
| 2 Data foundation | done (mock-tested) |
| 3 APIs and dashboard | done (mock-tested) |
| 4 Recommendation engine | done (mock-tested) |
| 5 CMS integration and calendar | done (mock-tested) |
| 6 Technical SEO audit | done (mock-tested) |
| 7 Reports and notifications | done (mock-tested) |
| 8 Deployment, observability, CI | done |
| 9 Validate, document, PR | done |

## Open issues

- None yet.

## Phase 2 notes

- Migration `0011_seo_intelligence.sql` (18 tables, additive) + manual rollback script; up → down → up tested on PGlite.
- `src/lib/seo-intel/`: settings (setting row `seo`), Google service-account auth, HTTP with backoff/jitter,
  GSC + GA4 clients, sync with normalisation/aggregation/prune, job runner with leases, schedules, retention.
- Worker hook in `src/lib/scheduler.ts` (guarded; never breaks publishing).
- `tests/seo-intel-sync.test.ts`: 23 tests against a fake Google (`tests/seo-fixtures.ts`, labelled fixture data).
- typecheck clean; lint clean on new files.

## Phase 3 notes

- `src/lib/seo-intel/http.ts`: one guard for every route (admin-only 401/403, same-origin for mutations, rate limit,
  zod, redacted 500s with reference); `queries.ts` read models; `integrations.ts` real "test connection".
- Routes: overview, search-console, analytics, pages, keywords, integrations (+ test), sync (+ history), settings.
- UI: `/admin/seo` (+ search, analytics, pages, keywords, integrations, sync, settings) with skeleton, empty,
  disconnected, stale and error states; SVG charts with table fallbacks; nav entry for admins.
- `scripts/seo-seed-fixtures.ts`: labelled demo data into local PGlite only.
- Tests: `seo-intel-api.test.ts` (16: auth matrix over every route file, CSRF, validation, rate limit, audit,
  KPI maths, stale) and `seo-intel-ui.test.tsx` (9: every page renders disconnected and with fixture data).

## Phase 4 notes

- Rules (`rules.ts`): low CTR by position band (brand excluded), striking distance, decay (28d + YoY, volume floor),
  content gaps, internal links (shared queries/tags/category, capped, existing links skipped), outdated tech
  (cited vs "verify"), quality (audit; no word count / keyword density).
- Scoring (`scoring.ts`, docs/seo/SCORING.md), records + evidence, refresh by fingerprint, rejections respected,
  baseline at "implemented", outcomes at +28/+56 days (`outcomes` job).
- LLM (`llm.ts`): existing `callModel`, zod-validated JSON, one retry then fallback, cache by input hash + prompt
  version, data blocks with neutralised closing tags, PII/secret filtering, token logging, daily limit. Off by default.
- Editorial suggestions (`editorial.ts`): "measured" (GSC gap) vs "editorial idea" (thin theme coverage).
- Views: Recommendations (approve/reject/implementation), Internal linking, Content optimization.
- Bug found by tests and fixed: Markdown images were counted as internal links.
- `tests/seo-intel-recs.test.ts`: 14 tests.

## Phase 5 notes

- Article panel `/admin/seo/articles/[id]` (linked from the post editor for admins): GSC + GA4 performance, queries,
  metadata, structured-data inputs, audit findings, heading outline, link suggestions, recommendations, proposals
  with side-by-side diff (`components/seo/Diff.tsx`).
- `optimize.ts`: rule (+ optional LLM) proposals; accept → the admin's editor `autosave` working copy (never the
  post); reject; rollback restores the previous working copy or reverts the field; stale proposals refused (409).
- `calendar.ts` + `/admin/seo/calendar` (month/week): flow-checked statuses, "published" only follows the linked
  post, create draft via the CMS's `createPost` (status draft), link existing post, owner, clicks since publish.
- `tests/seo-intel-cms.test.ts` (9): accept → working copy → rollback; post rows and revisions untouched; static
  scan that no SEO file references publish/update/delete functions or writes `post`.
- Owner commit `d16f13c "seo platform"` (22:02) on this branch also contains the owner's CI/Dockerfile changes plus
  in-progress Phase 4 files; left as is.

## Phase 6 notes

- `crawler.ts`: host allowlist, DNS checked inside the socket's own lookup (no rebinding window), private/reserved
  v4/v6 ranges refused, manual redirects re-validated, timeout, size cap, UA, robots.txt parser (longest match).
- `technical.ts`: robots, sitemaps (+ index), BFS crawl (private paths and disallowed paths skipped, paced), checks
  for status, redirect chains, canonicals, titles/meta (missing, duplicate), headings, alt, JSON-LD, OG, viewport,
  indexability conflicts, broken links, orphans; optional URL Inspection (quota-capped, "Google's last-known state")
  and PageSpeed/CrUX (off by default, key from env). Scan + issues stored; `/admin/seo/technical`.
- `tests/seo-intel-technical.test.ts` (22).

## Phase 7 notes

- `reports.ts`: weekly (last full Mon–Sun) / monthly (last full month) vs previous period: organic GSC + GA4,
  best/growing/declining pages, new opportunities, decay alerts, technical summary, recommendation counts,
  completed optimisations with baseline and +28/+56, next actions. Upsert per period; scheduled + manual.
- CSV export (injection-safe) and printable page (`/admin/seo/reports/[id]`, Save as PDF). No PDF library (D-09).
- Email via the existing `sendMail` only when enabled + recipients set + email service configured; once per report.
- `tests/seo-intel-reports.test.ts` (4).

## Phase 8 notes

- No new workloads/CronJobs (D-02), no manifest change needed: secrets via existing `envFrom` Secret
  `jithendar-com-env`, property ids via ConfigMap `jithendar-com-public`; `scripts/set-seo-config.sh` (human-run, merges keys).
- Metrics: 9 counters/histogram (Phase 2) + DB-backed gauges for consecutive failures / last success (D-18).
- Alerts: `www/docs/seo/prometheus-alerts.yml` (4 rules) for the miniKube repo (D-12).
- Grafana: `grafana/jithendar-com-seo.json` (owner request), `check-dashboards.py` OK.
- Validation: `kubectl kustomize minikube` (20 objects) and `kubectl kustomize grafana` OK; shellcheck OK;
  kubeconform / promtool not installed (not run).
- Owner commit `d16f13c` also changed `minikube/30-jithendar-com.yaml` (content init container) — not SEO work.

## Phase 9: validation (2026-11-09, this machine, Node 26)

| Command | Result |
|---|---|
| `npm run lint` | pass (0 problems) |
| `npm run typecheck` | pass |
| `npm test` | pass: 52 files, 591 tests (baseline 45 / 474; all existing tests still pass) |
| `APP_ENV=production npm run build` | pass; 1 pre-existing warning (`src/lib/request-log.ts`, Edge runtime `process.on`), unrelated |
| `npm audit --omit=dev` | 0 vulnerabilities; no dependencies added |
| `kubectl kustomize minikube` / `grafana` | pass (manifests unchanged by this work) |
| `python3 scripts/check-dashboards.py` | pass (4 dashboards) |
| `shellcheck scripts/set-seo-config.sh` | pass |
| kubeconform, promtool | not run (not installed); alert YAML structure checked with a parser |

Docs: README, ARCHITECTURE (Mermaid), OPERATIONS, SECURITY, MANUAL_SETUP, SCORING, DECISIONS.

## Open issues / needs a person

- Google credentials and property access (MANUAL_SETUP.md); live Google behaviour is **not verified** here.
- Alert rules must be copied into the miniKube repo; Grafana app sync after merge.
- Branch also contains the owner's commit `d16f13c` (content image, CI workflow, init container) — review separately.


---

# v2: drafts, review, submission, UI (branch `feature/seo-v2-drafts-review-ui`)

Branched 2026-11-10 from `feature/ai-seo-intelligence-platform` @ `ee8ab6c` (v1 complete; nothing missing from v1
was needed). Decisions D-21 … in DECISIONS.md.

## Baseline (before any v2 change, 2026-11-10)

- `npm test` first run: 591 tests, 584 passed, 7 failed in `tests/editor-workflow.test.ts` with `ENOENT
  …/pglite/dist/pglite.data`: a stale `node_modules` (vitest 5.0.5 installed vs 5.1.0 declared). After `npm install`
  the same file passes 64/64. Not a code problem; recorded so it is not mistaken for a regression.
- Public-site baseline captured before Phase 7 (local production build, bundled content marked published in a
  scratch copy, `CONTENT_DIR`): Lighthouse in `docs/seo/ui-review/lighthouse-before.txt`, screenshots in
  `docs/seo/ui-review/before/`, SEO snapshot of 20 URLs + sitemap + robots in `tests/fixtures/seo-snapshot.json`.

## v2 phase status

| Phase | Status |
|---|---|
| 1 Claude API draft automation | done (mock-tested; live API needs credentials) |
| 2 Review & approve (mobile-first) | done (mock-tested; live publish verified only against local fakes) |
| 3 Search-engine submission | done (mock-tested; live IndexNow/Google need production + credentials) |
| 4 Automated internal linking | done (unit + DB-tested; uses real corpus once posts are in Postgres) |
| 5 Content optimization popovers | done (unit + DOM-tested) |
| 6 Keyword opportunities | done (SQL + mocked-Haiku tested; real data needs GSC credentials) |
| 7 UI/UX overhaul | done (owner commit `f592652`; Lighthouse before/after + screenshots in `docs/seo/ui-review/`) |
| 8 Tests, docs, PR | done (PR #25 merged; E2E harness fixed and green 2026-11-10, see below) |

## v2 Phase 1 notes

- Dependencies: `@anthropic-ai/sdk@1.3.0`, `diff@9.0.0` (jsdiff), dev `@playwright/test@1.64.1` — all exact pins,
  all released > 2 weeks before install. `npm audit` result recorded in Phase 8.
- Provider: `src/lib/practice/ai/anthropic.ts` + `callModel` `provider: "anthropic"` (D-22). Structured output,
  cached system blocks, refusal fallback for Sonnet/Opus, typed error mapping.
- `src/lib/seo-intel/claude.ts`: prices, `seo_llm_usage` rows (tokens, cache tokens, cost, model, prompt version,
  latency, request id), month-to-date budget with batch reservations, `claudeJson` (validated, one feedback retry),
  `submitBatch` / `pollBatches`.
- `changeset.ts` (blocks with ids + heading paths, atomic changes, apply, validators), `diff-model.ts` (rendered-token
  word diffs, line diffs, counts, SERP truncation), `drafts.ts` (eligibility, prompt, generate/merge/regenerate, weekly
  batch, batch results, queue, per-change decisions, reject), `notify.ts` (digest via `sendMail`).
- Migration `0012_seo_drafts.sql` (+ rollback; up → down → up tested): `seo_drafts` (one open per article via a
  partial unique index), `seo_llm_usage`, `seo_llm_batches`.
- Settings: `drafts`, `links`, `submission`, `keywords` sections; Settings page shows month-to-date spend; budget banner
  on every `/admin/seo` page.
- Jobs: `drafts_weekly` (batch), `drafts_poll` (hourly), `drafts_digest`; queue kind `seo_draft` for on-demand runs.
- Style guide generated from 39 articles: `docs/seo/STYLE_GUIDE.md`.
- Tests: `tests/seo-v2-drafts.test.ts` (24): blocks/apply/conflicts, validators (hard + soft), substantive-change rule,
  diff model, migration, and mocked Claude: valid → ready + usage row, invalid → retry → `generation_failed`,
  invalid → valid, budget pause (no request sent), env/settings budget precedence, merge vs regenerate (no stacking),
  injection neutralisation, batch submit → poll → apply with reservation release, batch-invalid → sync retry, news
  categories, per-change decisions/edits.
- Two v1 tests needed scoping because they counted *all* `seo_*` tables (now 21); they now check the tables 0011
  creates. One v1 page test renders Settings synchronously, so the usage card is a sync component fed by the page.

## v2 Phase 2 notes

- `publish.ts` (D-21): approve one draft → preflight (admin, ≥ 1 accepted, no blocking flags, base version unchanged,
  still published, no unsaved editor copy, no conflicts) → `updatePost` (reason `seo-draft`) → baseline metrics →
  linked recommendations `implemented` → revalidate → `seo_verify` job (+40 s; up to 3 attempts) → submission
  (Phase 3). Schedule ("publish later") → `publishDueDrafts` in the 30-s worker, as the approving admin (refused if
  no longer admin). Rollback restores the previous revision's fields (or the draft's snapshot when an imported post
  has no revision row) as a new revision, then verifies + submits again. Draft outcomes at +28/+56 days.
- Substantive-change rule: only body changes (heading/paragraph/code) move `updatedAt` → sitemap `<lastmod>`,
  visible "Updated" and JSON-LD `dateModified`. Title/meta/alt/link-only drafts leave them alone.
- API: `POST /drafts`, `GET /drafts/{id}`, `PATCH /drafts/{id}/changes/{c}`, `POST /drafts/{id}/approve|reject|rollback|regenerate`,
  `POST /review/bulk-reject`. No bulk approve. v1's auth matrix covers them automatically (38 tests).
- UI: `/admin/seo/review` (Articles / News / Published tabs, filters type/priority/age, sort, cards on phones,
  bulk reject), `/admin/seo/review/{id}` (`DiffReview`: summary bar, Auto/Inline/Side-by-side, rendered-token word
  diffs, line diffs for code, numbered changes with j/k, a/x, swipe, per-change accept/reject/edit with live counter,
  rationale + evidence, SERP preview desktop/mobile, sticky thumb-reach action bar, confirmation dialog listing every
  step, schedule, reject with reason, verification + submission timeline + rollback), `/preview/seo-draft/{id}`
  (public `ArticleView` with accepted changes, admin-only, noindex). Shared `badges.tsx` scales.
- v1's static "no automatic publishing" scan now exempts only `publish.ts`, which has its own assertions (only
  `updatePost`, only from `publishDraft`/`rollbackDraft`, importers limited to the approve/rollback routes and the
  job registry).
- Tests: `tests/seo-v2-review.test.ts` (12): accepted/edited/rejected → exact post fields + revision + audit,
  metadata-only keeps lastmod, guards, duplicate-title block, scheduling (+ demoted approver), verification pass /
  retry / fail-without-submit, `verifyHtml`, rollback (+ refused after later edits), queue/reject, outcomes.

## v2 Phase 3 notes

- `submission.ts` + migration `0013_seo_submissions.sql` (+ rollback; up/down/up tested). Details: SUBMISSION.md.
- IndexNow: queued rows → one debounced, deduplicated, sorted batch POST per minute; 429/5xx re-queue + job backoff;
  4xx terminal. Key auto-generated on first SEO submission unless an admin turned IndexNow off.
- Google: no Indexing API (a test asserts no request ever goes to `indexing.googleapis.com`). Sitemap resubmission via
  `sitemaps.submit` with the write scope, once per hour per sitemap (+ news sitemap for news); URL Inspection
  scheduled +60 h, stored as Google's last-known state; timeline on the article panel (submitted → crawled → indexed).
- CMS changes (small, in `posts.ts` / `indexnow.ts`): `visibleChange()` — a save that changes no visible field no
  longer pings IndexNow; `updatePost(..., { notifySearchEngines: false })` lets the SEO path submit only after
  verification; the editor's IndexNow queue now goes through the batched log. Legacy per-URL `indexnow` jobs still
  drain through the old handler. `tests/seo-integrations.test.ts` expectation updated accordingly (same guarantees).
- `googleJson` accepts PUT / empty bodies; `SCOPES.searchConsoleWrite`.
- Rollbacks must run newest first (0013 references `seo_drafts`); the 0012 test now does that.
- Tests: `tests/seo-v2-submission.test.ts` (12): kill switch, payload, batching/debounce/dedupe, retry vs terminal,
  automatic key (and respecting "off"), sitemap queue incl. news, write scope + PUT URL, hourly dedupe, missing
  credentials and 403 hint, inspection result + timeline, lastmod only on substantive change, migration.

## v2 Phase 4 notes

- `internal-links.ts`: TF-IDF + shared GSC queries + category/tags relevance, tutorial-path and orphan priorities,
  every hard limit from the brief (INTERNAL_LINKING.md), anchors from existing paragraph text only, anchor diversity
  per target, rolling-week inbound cap from `seo_drafts`. Wired into `drafts.ts` (`linkChangesFor`); a links-only
  recommendation produces a draft without any Claude call.
- Two planner bugs found by the tests and fixed: stripped apostrophes produced truncated anchors ("…for let"); the
  prerequisite signal now requires the source to mention the earlier article's subject instead of a fixed
  similarity threshold.
- `/admin/seo/links` rebuilt: counts, pending link changes with accept/reject (`LinkDecision`), orphans, over-linked,
  sortable inbound/outbound table; v1 rule candidates kept in a collapsible list.
- Tests: `tests/seo-v2-links.test.ts` (11): max per draft, one per target, no self/existing/unrelated, density cap and
  skip-at-cap, forbidden zones (headings/code/captions/first sentence/existing links), spacing, inbound cap per week,
  2–6-word existing anchors, no repeated exact anchor, orphan/prerequisite/series priority, threshold, graph; plus DB
  integration: links-only draft → validate → approve → links in the published body; no re-linking.

## v2 Phase 5 notes

- `issue-details.ts` (pure): every finding located (heading path · line · element/field), with one-line why / how to
  fix and the draft category Claude may use; counts are located issues, so a number and its popover always agree;
  score breakdown = 100 − 15/error − 7/warning − 2/notice (the v1 audit formula).
- `GET /api/admin/seo/content/{id}/details?metric=…&run={contentHash}`: lazy; cached privately per audit run.
- `Popover.tsx`: no Popover/HoverCard existed in the repo, so a small accessible one — mouse hover (delay, mouse only)
  and keyboard focus → tooltip with `aria-describedby`; click/tap/Enter → non-modal dialog with focus trap; Esc closes
  both and returns focus. `MetricCell.tsx`: ≤ 5 issues + "View all N", jump-to-line links, "Fix with Claude" (creates or
  extends the draft via `POST /drafts` with `extra` tasks; never edits).
- Content optimization page: Articles/News tabs, sticky-header table on desktop, cards on phones, every count
  interactive. Article panel: `#issues` (all located issues) and a line-numbered body that highlights `?line=N#LN`.
- Tests: `tests/seo-v2-popover.test.tsx` (8): counts ≡ list lengths, locations/why/fix, score arithmetic ≡ audit score;
  DOM: focus → tooltip + describedby + Esc, mouse-only hover delay, tap → dialog + focus trap + focus return, lazy
  fetch once per run, ≤ 5 + View all, Fix with Claude payload, zero is plain text.

## Environment issue found during v2 (needs the owner)

Files named `<name> 2.<ext>` keep appearing in the working tree during this session (55 + 39 so far), all byte-identical
to v1 files and carrying v1-era timestamps — the signature of a cloud-sync conflict copier (e.g. iCloud "Desktop &
Documents" syncing `~/Desktop/Work`). The first batch was accidentally included in the Phase 4 commit and removed by
amending it (before any push). Every batch was verified identical to a committed version and **moved**, not deleted,
to the session scratchpad. Recommendation: keep this repository outside a synced folder.

## v2 Phase 6 notes

- `keywords.ts` + migration `0014_seo_keywords.sql` (+ rollback, up/down/up tested; index
  `(search_type, date, query)` for the server-side aggregation). Search Console data only: no volume/difficulty
  columns (no licensed source configured).
- Site CTR curve (90 days, web, ≥ 200 impressions per position, PAVA-pooled to be non-increasing; sparse positions
  use the v1 yardstick and the page says how many positions are site-based). Click gap = impressions × (expected −
  actual), labelled as an estimate everywhere.
- Views in SQL with allowlisted multi-column sort + pagination: all, striking (4–20 by gap), low CTR (≤ 5, CTR below
  `lowCtrRatio` × curve, non-brand), rising, new (first seen in period), lost/declining, cannibalization (page split,
  leader-change volatility, link/consolidate/differentiate — never delete), content gaps (clusters with demand,
  best position > 15).
- Clusters: greedy token-set similarity with light stemming (`-s`, `-ing`), parent topic = top query. Intent: Claude
  Haiku 5.5 in batches of 100 (cached per query in `seo_query_intents`, logged in `seo_llm_usage`, budget-capped,
  data blocks), rules fallback. Brand split via the configurable regex. Daily `keywords_refresh` job after the GSC sync.
- Row actions: Draft optimization (queues a draft for the ranking article with the query as evidence), Draft new
  article (calendar item; CMS draft only if "new article" drafting is on), Track, Ignore. Tracked keywords page with
  90-day position history; alert when the 7-day average moves > N positions (once per 6 days, via the mail service).
- UI kit `table-kit.tsx` (column picker + density remembered per viewer, URL-driven multi-sort headers, removable
  chips, roving keyboard rows, saved views via `/api/admin/seo/views`, sparkline); CSV export (formula-safe).
- Bug found by tests and fixed: "locking"/"lock" did not cluster (added `-ing` stemming).
- Tests: `tests/seo-v2-keywords.test.ts` (18).


## v2 Phase 7 notes (owner commit `f592652` "added v2 seo")

- Admin shell rebuilt (`SeoShell`, health score, synced charts), admin CSS split from public CSS (D-37), public-site
  additions (D-40), E2E specs (`e2e/review-flow`, `popover`, `screenshots`, `seo-snapshot`) and the Lighthouse "after" run:
  every page within ±1 point / ±10 ms LCP of the baseline (`docs/seo/ui-review/lighthouse-*.txt`).

## v2 Phase 8: validation (2026-11-10, branch `feature/seo-v3-orchestration` from master `b08d54a`, Node 26)

| Command | Result |
|---|---|
| `npm run lint` / `npm run typecheck` | pass |
| `npm test` | pass (before v3 changes: 59 files, 695 tests) |
| `APP_ENV=production npm run build` | pass; the 1 pre-existing Edge-runtime warning (`request-log.ts`) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| E2E `review-flow` + `popover` (desktop + mobile) | **pass** after three harness fixes (below); first runs failed 4/4 |

E2E harness bugs found and fixed (none in product code):
1. `instrumentation.ts` returned before starting the worker when there is no `DATABASE_URL` (local PGlite), so the draft,
   audit, verify and submission jobs the specs wait for never ran. `E2E_WORKER=1` now opts in locally (ignored when
   `APP_ENV=production`); OPERATIONS.md "E2E" updated.
2. `e2e/helpers.ts#signIn` waited for `/\/admin/`, which the login URL itself (`/login?next=/admin/seo`) matches, so a
   failed sign-in passed silently; and Cloudflare's Turnstile widget does not produce a token in headless Chrome here.
   It now signs in through Better Auth's endpoint with Cloudflare's documented test token (the server still verifies it)
   and checks the pathname.
3. `e2e/fake-services.mjs` proposed a heading change on block `b5` (a paragraph); the heading is `b4`. The validators
   correctly rejected it twice → `generation_failed`. Also two strict-mode locators matched both the status badge and
   the pressed button ("✕ Rejected").

Also fixed: the secret filter `sk-[A-Za-z0-9]{8,}` (llm.ts) missed Anthropic-style keys `sk-ant-…` (found by a v3 test).
Not run: `e2e/screenshots.spec.ts` (would overwrite the committed screenshots), `seo-snapshot` (needs the published-content
scratch setup from Phase 7).


---

# v3: LangGraph, CrewAI, pgvector, Ask the Blog (branch `feature/seo-v3-orchestration`)

Branched 2026-11-10 from master `b08d54a` (#26, with v2 merged as #25 and the `services/` move). The brief asked for a
branch from the latest SEO branch: both SEO branches are merged into master, so master is it. Decisions D-41 to D-53.

## v3 phase status

| Phase | Status | Commit |
|---|---|---|
| 1 Architecture + service skeleton | done | `d0aeea7` |
| 2 LangGraph workflows | done (fake-LLM tests; Postgres checkpointer tests run in CI) | `d0aeea7` |
| 3 CrewAI editorial crew | done (deterministic-LLM tests) | `d0aeea7` |
| 4 Embeddings + pgvector | done (real ONNX model measured; pgvector tests run in CI) | `d0aeea7` |
| 5 Ask the Blog | done (off by default) | `d0aeea7` |
| 6 Deployment + observability | done (manifests rendered and filtered; image not built locally) | `bc297d6` |
| 7 Tests, docs, PR | done | this commit |

## Validation (2026-11-10, this Mac, Node 26, Python 3.13.17)

| Check | Result |
|---|---|
| web `npm run lint` / `typecheck` | pass |
| web `npm test` | pass: 60 files, **720 tests** (v2 baseline 695; +25 v3, 3 v1/v2 tests adjusted on purpose: the publish scan now covers `seo-agent` and allows `publishNewArticle`; the 0011 rollback now runs 0015's rollback first) |
| web `APP_ENV=production npm run build` | pass (1 pre-existing Edge warning) |
| web `npm audit --omit=dev` | 0 vulnerabilities |
| E2E `review-flow` + `popover`, desktop + mobile (legacy path) | pass, re-run on the final code |
| seo-agent `ruff` / `mypy` | pass |
| seo-agent `pytest` | **89 passed, 5 skipped**: the skipped tests need PostgreSQL + pgvector (no Docker or pgvector on this Mac; building pgvector from source was blocked by the sandbox) and run in CI against `pgvector/pgvector:0.8.1-pg18` |
| `pip-audit` (production lock) | oauthlib bumped to 4.0.1 (CVE); chromadb advisories accepted (D-53); otherwise clean |
| `kubectl kustomize minikube`, `manifests.sh seo-agent`, `ci-app-manifests.py` (3 groups) | pass |
| `check-dashboards.py` (5) · `actionlint` · `shellcheck` | pass |
| Docker image build / size | **not run** (no container runtime locally); CI builds and reports the size |
| Live Claude, live cluster, pgvector in the cluster | **not run** (needs credentials and the manual steps) |

## Status by area

| Area | Verified | Mock-tested | Needs credentials / manual step |
|---|---|---|---|
| optimize_article: happy path, retry → fail, reject, edit, approve → publish → verify → submit, verify failure → no submission + alert, budget → paused_budget, transient retries, injection | | ✓ fake LLM, fake web app, in-memory checkpointer | live Claude |
| Resume after restart | ✓ in-memory (new manager, same saver) | Postgres variant written, CI | |
| Approval gate (once, expiry, exact ids, demoted approver, changed decisions, scheduled) + E2E approve → resume → publish → verify → submit records | ✓ web tests on PGlite with the agent mocked | | |
| weekly fan-out (≤ 2 concurrent, idempotent), internal_linking → v2 planner | | ✓ | GSC data |
| Crew: schema, real ReAct tool call, token cap, timeout, budget, roles/tools, new_article graph | | ✓ deterministic LLM | live Claude |
| Tool allowlist, SSRF (Python checks + web docs fetcher), data blocks | ✓ | | |
| Chunker + rehype-slug anchors (cross-checked with github-slugger) | ✓ | | |
| Embeddings (bge-small ONNX): load, memory, retrieval on the 37 real articles | ✓ measured | | |
| pgvector index (incremental reindex, retrieval, versioning) | | written, CI | `CREATE EXTENSION vector` (MANUAL_SETUP §13) |
| Ask the Blog: guards, citations, fallback/gaps, cache, kill switch, daily cap separate from admin, streaming, rate limits | | ✓ | `ASK_BLOG_ENABLED`, live Claude |
| Callback API auth/ownership; client ↔ server contract | ✓ | | Secrets (MANUAL_SETUP §14) |
| K8s manifests, CI workflow, alerts, dashboard | rendered/linted | | apply (§15), scrape job (§16), Argo path |

## Notes

- **Bugs found by the new tests and fixed before commit:**
  - The secret filter missed `sk-ant-…` keys (v2 code too).
  - LangChain's splitter lost paragraph boundaries and duplicate-heading anchors, so it was replaced.
  - Recovery after a crash before the first checkpoint did nothing.
  - The Python and web context endpoints disagreed (GET vs POST); the contract test now guards this.
  - Ask the Blog spend counted against the admin budget.
  - The crew token cap (60k) was below a normal run (~80–105k), so it's now 150k.
  - The ONNX reindex peaked at 1.15 GiB; it's now ~0.7 GiB.
- **Not done / open:**
  - The Docker image size is an estimate (~0.7 GB) until CI reports it.
  - The Lighthouse check with `ASK_BLOG_ENABLED=true` wasn't run. The launcher is one small client component, and
    the panel chunk loads only on click; with the flag off nothing renders.
- **Environment:**
  - Cloud-sync side effects appeared again: `services/www/.gitignore` vanished from disk and was restored from git, and
    `services/www/src/components/ScrollSpy (1).tsx` (an older, different copy) appeared. It was left untouched and
    uncommitted.
  - Node 20 in `/usr/local/bin` shadows Homebrew's Node 26 in the default PATH; the project needs ≥ 24.


---

# v4: CrewAI as the only engine, MCP servers, report PDFs (branch `feature/seo-v4-crewai-mcp`)

Branched 2026-11-10 from master `7ac533f` (#29: v3 merged; it is the latest SEO state, and the v3 feature branch is
behind it). Decisions D-54 to D-65.

## v4 phase status

| Phase | Status | Commit |
|---|---|---|
| 1 Service skeleton (internal API, ports, auth) | done | `9b55362` |
| 2 Flows (11), state, persistence, locks, scheduling | done (in-memory + PostgreSQL 17 tests) | `9b55362`, `5c851ea` |
| 3 Crews (optimization, editorial, report) | done (real CrewAI, deterministic model) | `9b55362` |
| 4 Embeddings + pgvector | unchanged from v3 (still needs `CREATE EXTENSION vector`, §13) | v3 |
| 5 Ask the Blog | pipeline (no graph); shared with public MCP | `9b55362` |
| 5b MCP servers + OAuth | done (in-process, HTTP and Inspector CLI verified locally) | `9b55362` |
| 6 Deployment, Kong, CronJobs, CI, observability | done (rendered, client-validated; not applied) | `5c851ea` |
| 7 Tests, docs, PR | done | this commit |
| Owner requests during the work | admin menu layout `4502ae7`; sync-history error popover `4507a8b`; Redis status `4125db4`; report PDFs in R2 (in `9b55362`) | |

## Validation (2026-11-10, this Mac, Node 26, Python 3.13.17)

| Check | Result |
|---|---|
| seo-agent `ruff check` / `mypy app` | pass / pass (40 files) |
| seo-agent `pytest` | **124 passed, 6 skipped** (the 6 need PostgreSQL; see next row) |
| seo-agent Postgres tests on a local PostgreSQL 17 (no pgvector) | **5 passed, 1 skipped** (pgvector index test; CI runs `pgvector/pgvector:0.8.1-pg18`) |
| web `npm run lint` / `typecheck` | pass / pass |
| web `npm test` | **740 passed** in 64 files (v3: 720 in 60; the v3 agent tests ported to the v4 API, plus v4 OAuth/callbacks/migration, Redis status, admin CSS and sync-error popover tests) |
| web `APP_ENV=production npm run build` | pass; 9 new routes; only the pre-existing Edge-runtime warning |
| Real service, both ports (`python -m app.main`) | `/readyz`, 17 metric families, 401 without token, `publish_flow` kickoff 403 with token, MCP 404 while off |
| MCP Inspector CLI 2.12.0 against the real service | public tools/prompts/templates; admin 401 + resource metadata; DB-issued token → 13 tools; publish_flow refused; scope enforced; revoke 200 → 401 |
| `kubectl create --dry-run=client` seo-agent group (16 objects), `kubectl kustomize minikube`, `ci-app-manifests.py` | pass; CronJobs classified as manual |
| decK file | parses (Service, 2 Routes, 4 plugins) |
| `check-dashboards.py` (5) · `actionlint` · alert YAML | pass |
| Report PDF | rendered and reviewed visually (2 pages for a typical week) |
| `pip-audit` (production lock) | **not completed here**: PyPI timed out from this machine; CI runs it on every PR |
| Docker image build / size | **not run** (no container runtime here); CI builds it and reports the size |
| Live Claude, live cluster, Kong, Claude custom connector | **not run** (credentials / production) |

## Status by area

| Area | Verified | Mock-tested | Needs credentials / production validation |
|---|---|---|---|
| Flow routing: happy paths, retry once, fail, budget pause, skip, cancel, rerun, locks, orphan sweep, no SQLite | ✓ (real CrewAI Flow engine) | fake web app, fake crews | |
| CrewAI Postgres persistence, partial unique index, advisory locks across connections | ✓ PostgreSQL 17 | | |
| Split-flow approval: approve → publish_flow → publish → verify → submit → reindex; reject; regenerate; forged/reused approval; edits must match | ✓ web side on PGlite (real CMS path), agent side with fake web | | live publish |
| No code path from drafting to publish (static + runtime, 4 triggers) | ✓ | | |
| Crews (schema, real tool calls, caps, timeout, budget, per-agent models, injection) | | ✓ deterministic model | live Claude quality and cost |
| Anthropic SDK request shape (caching, fallback, effort, usage, refusal) | | ✓ mock transport | live API |
| Report number check, PDF render, R2 storage | ✓ check + PDF | R2 client mocked | R2 + email in production |
| MCP public/admin tools, scopes, limits, Origin/Host, kill switches, audit | ✓ in-process + HTTP + Inspector | web callbacks mocked in tests | Kong path |
| OAuth AS (PKCE, rotation, reuse detection, revocation, demoted admin) | ✓ PGlite + Postgres + Inspector token | | Claude custom connector |
| CronJobs → kickoff; seoTick hands off flow-owned jobs; slot idempotency | ✓ trigger unit test, seoTick test, callback test | | cluster |
| Manifests, NetworkPolicies, mesh sidecar list | rendered / client-validated | | apply; Kong meshing (MANUAL_SETUP §27) |

E2E: the two halves are each tested end to end (agent: CronJob trigger → weekly flow → drafts → decision → publish_flow
with a fake web app; web: kickoff → callbacks → approval → publish → verify → submission records with the agent mocked),
and the contract test binds every agent call to a real route of the web callback server. A single cross-process run was
not built: the web side runs on PGlite in tests and has no long-running callback server in CI.

## Replaced / retired jobs

| Before (v1–v3) | v4 (SEO_ORCHESTRATOR=crewai) |
|---|---|
| web `seoTick`: gsc_sync daily | CronJob `seo-flow-gsc-sync` → `gsc_sync_flow` |
| web `seoTick`: ga4_sync daily | `seo-flow-ga4-sync` → `ga4_sync_flow` |
| web `seoTick`: technical_scan weekly | `seo-flow-tech-audit` → `tech_audit_flow` |
| web `seoTick`: recommendations weekly + drafts_weekly (v2 batch or v3 graph) + drafts_poll hourly | `seo-flow-weekly-recommendations` → `weekly_recommendations_flow` (synchronous crew runs; no batches to poll) |
| web drafts_weekly's ask-gap clustering | `seo-flow-ask-gaps` → `ask_gaps_flow` |
| web `seoTick`: report_weekly / report_monthly | `seo-flow-report-weekly` / `-monthly` → `report_flow` (+ narrative, PDF in R2) |
| v3 CronJob `seo-agent-reindex` (removed from the manifests; delete it in the cluster, MANUAL_SETUP §20) | `seo-flow-reindex` → `reindex_flow` |
| (new) weekly internal linking into open drafts | `seo-flow-internal-linking` → `internal_linking_flow` |
| kept in the web worker | keywords_refresh, retention, outcomes, drafts_digest, verify/submit job queue for legacy drafts |

## Notes

- **Bugs found by the new tests/checks and fixed before commit:** CrewAI auto-creating LanceDB memory and a SQLite store;
  router labels colliding with method names; inherited flow methods not registered (job flows silently did nothing);
  a flow method shadowing pydantic `validate`; the Optimization Crew passing article text without re-wrapping it as data;
  the contract test not covering new client calls; MCP paths 307-redirecting without a trailing slash; the audit insert
  using wrong column names.
- **Cost:** the crews cost 3–4× v3's single-call drafting; at default settings the admin month is ≈ $8–10.5 against the
  $10 cap (COSTS.md has the levers).
- **Environment:** no stray cloud-sync copies appeared this time. The scratch PostgreSQL and the local agent were
  stopped after the checks.


---

# v5: RAG quality, SEO-side ML, safety and housekeeping (branch `feature/seo-v5-ml-rag`)

Branched 2026-11-10 from master `0ea52e4`. Decisions D-66 onwards. CrewAI Flows stay the only orchestrator; ML runs as
plain Python steps inside flows and writes Postgres tables that the TypeScript rules read, with a fallback to the rule.

## v5 phase status

| Phase | Status | Commit |
|---|---|---|
| 1 Safety and housekeeping | done | `8a5ca05` |
| 2 RAG quality | done (eval measured with the real model; pgvector tests run in CI only) | `09f6fe7` |
| Owner request: SEO settings (tabs, connections, change tracking) | done | `de84e76` |
| 3 SEO-side ML | done (mock- and synthetic-tested; real metrics need production data) | (phase 3 commit) |
| 4 Deployment and observability | done (rendered, client-validated; not applied) | (phase 3 commit) |
| 5 Tests, docs, PR | not started | |

## Phase 1 notes

- **Kube-context guard** (`scripts/lib/kube-context.sh`, D-66) sourced by `deploy.sh`, `create-*` (3), `set-*` (4),
  `setup-ci-applier/deployer`, `verify-practice-sandbox.sh`. `setup-ci-ecr-user.sh` runs no kubectl and is left alone;
  `manifests.sh` only prints. Test: `bash scripts/tests/kube-context.test.sh` (stub kubectl) — 7 behaviours + a check
  that every kubectl script sources the guard: all pass. CI job `ci-repo.yml`.
- **`README 2.md`** was an older copy (pre-`services/` paths, no SEO agent or content image): nothing to merge; deleted.
  `scripts/check-conflict-copies.sh` fails CI on tracked `name 2.ext` / `name (1).ext` files (1–2 digits, so
  `notes 2026.txt` is allowed).
- **LangGraph leftovers:** comments in 7 source files and 2 docs now say CrewAI; MANUAL_SETUP §17 shortened to the alias
  note. The `SEO_ORCHESTRATOR=langgraph` alias stays, with its own test (`tests/seo-orchestrator-alias.test.ts`, 5 cases).
  Migrations 0015/0016, the blog content, the news gazetteer (a product name) and history in PROGRESS/DECISIONS untouched.
- **Budget:** default $15 (D-67); 80 % alert already present; per-flow breakdown on Settings → Claude usage (test in
  `seo-v4-agent.test.ts` "budgets"); COSTS.md updated.
- **Alerts handoff:** `docs/seo/alerts-for-minikube-repo.yaml` (generated, D-69); copy step in OPERATIONS.md#alerts.
- **Image size:** `scripts/image-size.sh` + baselines (D-68); the baselines are empty until the first CI run.

## Phase 2 notes

- **Eval set** `services/seo-agent/tests/fixtures/rag_eval.yaml`: 55 questions (8 no-answer); every slug and anchor is
  checked against the chunker in a test. Baseline recorded first (`baseline-v4` = v4 chunker + cosine, exact).
- **Results** (RAG.md "Results"; files in `docs/seo/rag-eval/`): v4 had 198/1,221 inputs over 512 tokens → v5 0/1,790.
  Recall@3 100 % → 100 % (vector default), MRR 0.989 → 0.968, anchor hits 97.9 → 95.7. Hybrid not adopted (D-71).
- **Floor** 0.15 → 0.66 (calibrated); no-answer questions reaching the grader 100 % → 62.5 %.
- **Grader-selected excerpts** (ask-blog-v3), retrieval logged per question (migration 0018), `rag_calibrate.py`.
- **Reranker** off and unmeasured: its gate can't be met on this set (D-74).
- **Internal linking** check: top-5 similar-article overlap 0.78 between v4 and v5 chunking.
- **Tests:** seo-agent 242 passed, 9 skipped locally (the 5 new + 4 old pgvector tests need CI's pgvector image; the
  non-vector Postgres tests, incl. the new ask-log columns, pass on a local PostgreSQL 17). The hybrid SQL was also
  checked by hand on PostgreSQL 17 with the vector expression stubbed (DDL on an existing table, idempotency, empty
  identifier arrays, stop-word-only questions).
- **Environment:** LightGBM needs libomp on macOS; this Mac has none, so local test runs set
  `DYLD_LIBRARY_PATH` to scikit-learn's bundled `sklearn/.dylibs` (no system change). The ONNX model came from an earlier
  session's scratch copy, verified against the Dockerfile's sha256 pins.

## Phase 3 notes (SEO-side ML; ML.md)

- **Agent:** `app/seo_ml/` (stl, decay, clusters, intent, priority, related, store, train) and `app/flows/ml.py`
  (`seo_ml_flow`, in SPECS and the CronJob list). One `register()` holds the activation rule (beats the rule; review
  where required, carried over to retrains that still win) and the automatic fallback with its metric.
- **Web:** migration 0019 (+ rollback); `ml.ts` (the one model-or-rule decision: override, active, fresh ≤ 14 days),
  decay in `rules.ts` (STL signals, labelled source, trend-vs-actual chart on Recommendations), clusters and intents
  in the keyword refresh (with `source`), ask-gap clustering, related articles A/B on the public page (+ the
  `related_click` GA4 event), GA4 page pairs (best-effort, outside `GA4_REPORTS`), **ML models** and **Labelling**
  pages, APIs (models, override/review, labels, proposals, run), Settings → "ML models & retrieval" (owner request).
- **Measured** (held-out synthetic, 2026-11-10): decay 2/180 false alarms vs the rule's 13, drop recall 91 % vs 47 %.
  Clusters, intent, priority and related need production data and your labels (status "collecting data" / "needs
  review" / "experiment running" until then).
- **Bugs found while measuring and fixed:** LOESS as a Python loop made the weekly run take > 10 minutes (vectorised,
  identical to 1e-15); a yearly STL with two cycles absorbed the declines it should find (0/133 flagged → yearly shape
  from the previous year); σ inflated by the unadjusted first year; holiday dips just before the cut-off flagged
  (last-week confirmation); co-visitation normalisation saturating at 1; token-set "purity" rewarding over-splitting
  (ARI gate); a rollback-test regex that couldn't see table names with digits.
- **Memory** (this Mac, Python 3.13, ONNX bge-small loaded, in-memory store with 400 pages × 800 days, 2,000 queries,
  400 intent labels, 120 outcomes, 40 articles): whole flow ≈ 44 s, **peak RSS 456 MiB** (ONNX 276 MiB, fixtures
  ~110 MiB, ML ≈ 70 MiB). The seo-agent limit is 1,280 MiB and the reindex peak ~0.7 GiB runs at 03:17, the ML flow at
  04:47, so training stays in the Deployment; no separate Job, no limit change.

## Phase 4 notes

- CronJob `seo-flow-ml` (Sun 04:47 UTC, `concurrencyPolicy: Forbid`) in `seo-agent-60-flow-triggers.yaml`;
  `seo-agent-config` gains the RAG settings. `scripts/manifests.sh seo-agent | python scripts/ci-app-manifests.py`
  and `kubectl create --dry-run=client`: 13 CronJobs, pass.
- Metrics: `seo_ml_train_runs_total{model,status}`, `seo_ml_model_active{model}`, `seo_ml_metric{model,metric}`,
  `seo_ml_flow_consecutive_failures`, `seo_rag_eval_recall_at_3`, `seo_rag_retrieval_mode{mode}`,
  `seo_rag_chunk_tokens`, `seo_rag_chunks_truncated_total` (all fixed label sets).
- Alerts (group `jithendar-com-seo-ml`): `SeoMlFlowFailing`, `SeoMlModelFellBackToRule`, `SeoRagChunksTruncated`;
  handoff file regenerated (4 groups, 20 rules).
- Grafana: "ML & RAG" row on the SEO agents dashboard (8 panels); `check-dashboards.py` passes.

## After merge (#34 merged 2026-11-10 14:48 UTC)

- Every seo-agent CI run since #33 failed at `uv sync --frozen`: the #33 squash merge appended identical copies of the
  scikit-learn and scipy lock entries. Fixed in #35 (lock-only; `uv lock --check` passes).
- With CI installing again, the pgvector tests ran for the first time: **276 passed, 2 skipped**, incl. the v5 hybrid
  search, the tsvector migration on a v4 table and the RAG eval smoke on Postgres. One older test failed, and it
  exposed a real bug from `0ea52e4`: `reindex(force=true)` skipped the deletion of unpublished articles' chunks. Fixed
  in #35.
- promtool on the generated alerts file: SUCCESS, 20 rules.
- **Image size** (seo-agent, amd64, first measurement): 381.5 MB per `docker image inspect`, 379.9 MB saved and
  gzipped. The two are nearly equal because the runner's containerd store already holds compressed layers. Recorded as
  the baseline (`services/seo-agent/image-size-baseline.json`); the web image's baseline is filled from its first
  release run.

## Promotion (2026-11-12, owner request; PROMOTION.md, D-88)

**What changed.** Admin → Promotion: channel opportunities with reasons and tagged links for published articles, posts
drafted by Claude for the owner to edit and post by hand, and content ideas from Search Console demand and Reddit
threads that can be sent to the editorial calendar. Two CrewAI flows (`promotion_flow`, `content_ideas_flow`), a
tool-less Promotion Crew, a read-only Reddit client, migration 0027, six admin API routes, four callback routes, two
CronJobs.

**Files.** www: `src/db/migrations/0027_seo_promotion.sql` (+ rollback), `src/lib/seo-intel/promotion/{settings,channels,reddit,store}.ts`,
`src/lib/seo-agent/callbacks-promotion.ts`, `internal-server.ts` (4 routes), `client.ts` (2 flow names),
`src/app/api/admin/seo/promotion/**`, `src/app/admin/(growth)/promotion/page.tsx`, `src/components/seo/{PromoDraftEditor,PromotionSettingsForm}.tsx`,
`src/app/admin/layout.tsx` and `src/components/seo/sections.ts` (navigation), `.env.example`, `tests/seo-promotion.test.ts`.
seo-agent: `app/crews/promotion.py`, `app/flows/promotion.py`, `app/state.py`, `app/webapp.py`, `app/flows/__init__.py`,
`app/flows/base.py`, `app/main.py`, `app/metrics.py`, `tests/test_promotion.py`, `tests/conftest.py`,
`tests/test_contract.py`. Repo: `minikube/seo-agent-62-promotion-triggers.yaml`, `scripts/set-reddit-config.sh`.
Docs: PROMOTION.md (new), FLOWS.md, CREWS.md, MANUAL_SETUP.md §37, DECISIONS.md D-88, README.md.

**Commands run → result.** The authoring sandbox refuses package installs, so the project toolchains ran in CI on
the pull request (#51, commit `3fc96b1`), not locally.

| Check | Where | Result |
|---|---|---|
| www `npm run lint`, `npm run typecheck` | CI `jithendar.com` | Pass |
| www `npm test` | CI | Pass: 82 files, 987 tests passed, 1 skipped (incl. `tests/seo-promotion.test.ts`, 16 tests) |
| www `npm run build`, render production manifests | CI | Pass |
| seo-agent `ruff check app tests`, `mypy app` | CI `seo-agent` | Pass |
| seo-agent `pytest` (incl. Postgres + pgvector) | CI | Pass: 398 passed, 2 skipped (incl. `tests/test_promotion.py` and the callback contract test) |
| seo-agent image build and smoke test, render manifests | CI | Pass |
| shellcheck on `scripts/set-*.sh` and the other repository checks | CI `repository checks` | Pass |
| `kubectl` against the cluster; the two CronJobs applied | — | **Not run.** Agents do not touch the cluster; a person applies them |
| `scripts/set-reddit-config.sh` executed | — | **Not run.** Needs the owner's Reddit credentials |
| Reddit API | — | **Not called.** No credentials exist yet; the client is tested against fake HTTP responses only |
| Promotion page opened in a browser; a real `promotion_flow` / `content_ideas_flow` run with Claude | — | **Not done.** Needs the deployed site and agent |

The first CI run failed one existing test (`seo-intel-sync.test.ts`, migration 0011 rollback): `seo_content_ideas`
references `seo_editorial_calendar`, so the 0011 rollback needs 0027 rolled back first. The test now does that, as it
already did for 0015. Everything else passed on the first run.

**Open issues.** Not yet exercised end to end: the page in a browser, a real model run (draft quality), and the live
Reddit API. Check the first drafts and ideas critically before relying on them.

**Manual steps (owner).** MANUAL_SETUP.md §37: deploy order, the Reddit "script" app, `scripts/set-reddit-config.sh`,
"Test connection", applying the seo-agent group for the two CronJobs.

## Ask the Blog admin settings (2026-11-13, owner request; RAG.md "Admin settings", D-89)

**What changed.** Ask the Blog can be switched on and off by an admin without a restart, limited to signed-in readers
or opened to everyone, and customised (placement, widget text, example questions, per-reader limits, daily budget,
answer reuse, answer length, fallback message). The deployment switch `ASK_BLOG_ENABLED` is now `true` in the
manifests; the admin switch ships **off** and the audience defaults to signed-in readers only, so merging and
deploying exposes nothing until the owner turns it on.

**Files.** www: `src/lib/seo-agent/ask-settings.ts` (new: schema, defaults, the two switches, status numbers),
`src/app/api/admin/seo/ask-blog/route.ts` (new), `src/components/seo/AskBlogSettingsCard.tsx` (new),
`src/app/admin/(growth)/automation/page.tsx`, `src/app/admin/(growth)/keywords/page.tsx`, `src/app/api/ask/route.ts`
(GET status; audience gate; limits from settings; per-account limit), `src/components/ask/{AskBlog,AskLauncher,AskPanel}.tsx`,
`src/app/page.tsx`, `src/lib/pages/article.tsx`, `src/lib/seo-agent/config.ts`, `tests/ask-blog-settings.test.ts` (new),
`tests/seo-v4-agent.test.ts`. seo-agent: `app/ask_runtime.py` (new), `app/ask.py`, `app/services/ask_pipeline.py`,
`app/main.py`, `app/mcp/public.py`, `tests/test_ask_and_chunks.py`. Repo: `minikube/30-jithendar-com.yaml`,
`minikube/seo-agent-40-seo-agent.yaml`. Docs: RAG.md, MANUAL_SETUP.md §18, MCP.md, DECISIONS.md D-89.

**No migration.** The settings are one row in the existing `setting` table (key `ask_blog`).

**Commands run → result.** The authoring sandbox refuses package installs, so the project toolchains were not run
locally; they run in CI on the pull request. Run locally: `ruff check app tests/test_ask_and_chunks.py` (pass),
`mypy` on the three changed agent modules with imports skipped (pass), `python -m py_compile` (pass), and a
syntax-only `tsc` parse of the changed TypeScript files (no syntax errors; types not checked without `node_modules`).
CI on pull request #52, first run (commit `2a63547`): seo-agent (ruff, mypy, pytest, image build) and the repository
checks passed; www lint and typecheck passed; www `npm test` failed one new test (1021 passed, 1 failed), because the
test varied the client-controlled left-most `X-Forwarded-For` hop instead of the right-most one the limiter trusts.
The test was corrected (no production code change). Later runs are recorded on the pull request.

**Not done.** The admin card and the widget have not been opened in a browser; no real question has been answered
(needs the deployed site and agent). The real-model run of the hard evaluation set and the generation eval are still
open (RAG.md), and are recommended before choosing "Everyone".

**Manual steps (owner).** MANUAL_SETUP.md §18: `./deploy.sh` (applies the two manifest changes), reindex, then
Admin → Automation & AI → Ask the Blog → switch on and choose the audience.
