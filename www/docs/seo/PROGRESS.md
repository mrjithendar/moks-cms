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
