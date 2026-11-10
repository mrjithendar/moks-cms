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
| 5 Content optimization popovers | pending |
| 6 Keyword opportunities | pending |
| 7 UI/UX overhaul | pending |
| 8 Tests, docs, PR | pending |

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
