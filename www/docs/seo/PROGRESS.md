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
| 5 CMS integration and calendar | in progress |
| 6 Technical SEO audit | not started |
| 7 Reports and notifications | not started |
| 8 Deployment, observability, CI | not started |
| 9 Validate, document, PR | not started |

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

## Next steps

- Phase 5: article panel (performance, queries, audit, proposals), side-by-side diff, accept → editor working copy,
  rollback, calendar UI/API.
