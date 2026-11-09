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

| 3 APIs and dashboard | in progress |
| 4 Recommendation engine | not started |
| 5 CMS integration and calendar | not started |
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

## Next steps

- Phase 3: read models, API routes with shared guard, admin UI at /admin/seo.
