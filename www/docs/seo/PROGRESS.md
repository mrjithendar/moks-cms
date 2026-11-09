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
| 6 Technical SEO audit | in progress |
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

## Next steps

- Phase 6: technical audit (robots, sitemaps, canonicals, titles/meta, headings, broken links, redirects, orphans,
  alt, JSON-LD, OG, viewport, indexability, status codes), SSRF-safe crawler, optional URL Inspection / PSI.
