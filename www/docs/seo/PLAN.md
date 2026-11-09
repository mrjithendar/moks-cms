# SEO intelligence platform: plan

Maps each phase of the brief to modules in this repository. Paths are relative to `www/`.
New server code lives in `src/lib/seo-intel/` (the existing `src/lib/seo/` is the public site's metadata/sitemap
code and is not modified).

| Phase | Deliverable | Files |
|---|---|---|
| 1 | Discovery, plan, decisions, progress | `docs/seo/{DISCOVERY,PLAN,DECISIONS,PROGRESS}.md` |
| 2 | Additive migration | `src/db/migrations/0011_seo_intelligence.sql`, `src/db/rollback/0011_seo_intelligence.down.sql` |
| 2 | Settings (setting row `seo`) | `src/lib/seo-intel/settings.ts` |
| 2 | Google auth (service-account JWT), HTTP with backoff | `src/lib/seo-intel/google/{auth,http}.ts` |
| 2 | GSC client + sync (totals, page, query; searchType loop; pagination; trailing window; backfill) | `src/lib/seo-intel/google/gsc.ts`, `src/lib/seo-intel/sync/gsc-sync.ts` |
| 2 | GA4 client + sync (allowlisted reports, quota, timezone) | `src/lib/seo-intel/google/ga4.ts`, `src/lib/seo-intel/sync/ga4-sync.ts` |
| 2 | URL normalisation + article mapping | `src/lib/seo-intel/urls.ts` |
| 2 | Job runs, advisory locks, schedules, retention | `src/lib/seo-intel/jobs.ts`, hook in `src/lib/scheduler.ts` |
| 2 | Tests | `tests/seo-intel-*.test.ts`, fixtures `tests/fixtures/seo/` (labelled demo data) |
| 3 | Read models for the dashboard | `src/lib/seo-intel/queries.ts` |
| 3 | API routes + shared guard (admin, origin check, rate limit, zod, audit, redaction) | `src/lib/seo-intel/http.ts`, `src/app/api/admin/seo/**/route.ts` |
| 3 | Admin UI | `src/app/admin/seo/**`, `src/components/seo/*` |
| 3 | Dev fixtures | `scripts/seo-seed-fixtures.ts` (writes clearly labelled demo rows to a local PGlite only) |
| 4 | Rules, scoring, records | `src/lib/seo-intel/rules/*.ts`, `src/lib/seo-intel/scoring.ts`, `src/lib/seo-intel/recommendations.ts` |
| 4 | LLM enrichment | `src/lib/seo-intel/llm.ts` (reuses `src/lib/practice/ai/providers.ts#callModel`) |
| 4 | Editorial suggestions | `src/lib/seo-intel/editorial.ts` |
| 5 | Article audit + optimisation proposals → autosave working copy | `src/lib/seo-intel/audit-article.ts`, `src/lib/seo-intel/optimize.ts`, panel `src/app/admin/seo/articles/[id]/` |
| 5 | Calendar | `src/lib/seo-intel/calendar.ts`, `src/app/admin/seo/calendar/` |
| 6 | Technical audit + safe crawler (+ optional URL Inspection / PSI) | `src/lib/seo-intel/crawler.ts`, `src/lib/seo-intel/technical.ts` |
| 7 | Reports, CSV, print view, email via `sendMail` | `src/lib/seo-intel/reports.ts`, `src/app/admin/seo/reports/` |
| 8 | Metrics, alerts snippet, CI, config script | `src/lib/metrics.ts` (extend), `docs/seo/prometheus-alerts.yml`, `scripts/set-seo-config.sh`, `.github/workflows/ci-jithendar-com.yml` |
| 9 | Docs + MANUAL_SETUP + PR | `docs/seo/*.md` |

Order of work inside each phase: schema/library → tests → API → UI → docs. Commit at the end of each phase.
