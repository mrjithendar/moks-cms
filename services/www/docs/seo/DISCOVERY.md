# SEO intelligence platform: discovery (Phase 1)

Inspected 2026-11-09 on branch `feature/ai-seo-intelligence-platform` (from `master` at `91954b5`).
Everything below was read from the repository or queried read-only from the `mk4` cluster; nothing was assumed.

## Stack

| Area | Finding | Where |
|---|---|---|
| Frontend + backend | One Next.js 16 App Router app (React 19, TypeScript 6, Tailwind 4), `output: standalone`. Route handlers under `src/app/api`, server actions under `src/app/**/actions.ts`. No separate backend service. | `www/` |
| Database | PostgreSQL (shared CloudNativePG cluster, namespace `postgres-db`, via PgBouncer in session mode). Local dev and tests: embedded PGlite. | `src/db/index.ts` |
| ORM / migrations | Drizzle ORM 0.45. Migrations are **hand-written SQL files** in `src/db/migrations/NNNN_name.sql`, applied in order at start-up by `src/db/migrate.ts` under an advisory lock and recorded in `schema_migrations`. Forward-only: no down migrations exist. Since 0003 they are written by hand (the drizzle-kit journal only lists 0000–0002). | `src/db/migrate.ts` |
| Raw SQL | `db.execute(sql\`…\`)` + `rowsOf()` (normalises postgres.js vs PGlite results) is the common pattern for anything beyond simple CRUD. | `src/db/rows.ts`, `src/lib/jobs.ts` |
| Package manager | npm (`package-lock.json`), Node ≥ 24 (`/opt/homebrew/bin/node` is v26 on this Mac). | `www/package.json` |
| Validation | zod 4. | |
| Tests | Vitest 5 (`tests/**/*.test.ts(x)`), PGlite-backed DB tests via `tests/db-helpers.ts#freshDb()` (one migrated template per worker, cloned per test). happy-dom for component tests. Fixed clock `NOW` in `tests/helpers.ts`. | `www/vitest.config.ts` |
| Lint / types | ESLint 10 (`eslint-config-next`), `next typegen && tsc --noEmit`. | |

## Auth / RBAC

- Better Auth (email + password, admin plugin, social sign-in). Roles on `user.role`: `admin`, `author`, `user`.
- Server components and actions: `requireRole("admin")` (`src/lib/session.ts`) redirects to `/login` or `/account?denied=1`.
  `adminActor()` (`src/lib/admin.ts`) returns the `Actor` used by services and audit.
- Route handlers: `getSessionUser()` then an explicit role check, wrapped in `handleErrors()` (`src/lib/http-errors.ts`),
  e.g. `src/app/api/admin/audit/route.ts`. Responses carry `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- CSRF: session cookies are SameSite (Better Auth default); state-changing JSON routes additionally require a
  same-origin `Origin` header (`sameOrigin()` in `src/lib/practice/http.ts`). Server actions get Next's own origin check.
- Rate limiting: `hit(key, max, windowSeconds)` (`src/lib/rate-limit.ts`): Redis if configured, otherwise the
  `rate_limit` table. Production has no Redis (removed 2026-11-09), so Postgres is used.
- Audit: append-only `audit_log` table with severity, IP and user agent (`src/lib/audit.ts`). Reused for SEO
  mutations instead of a separate `seo_audit_logs` table (see DECISIONS.md D-04).
- `/admin/*` is `noindex` and gated in `src/app/admin/layout.tsx` (`requireRole("admin", "author")`); admin-only
  nav items are filtered by role.

## CMS

- Posts live in Postgres (`post` table): `id uuid`, `collection` (`blog` | `news` | `projects`), `slug`
  (unique per collection), `title`, `description`, `body` (Markdown/MDX), `category`, `tags[]`, `status`
  (`draft` | `review` | `scheduled` | `published` | `archived`), `seo_title`, `seo_description`, social overrides,
  `noindex`, `canonical_url`, `related[]`, `version` (optimistic concurrency), `deleted_at` (trash).
- Public URL: `/{collection}/{slug}`. Renamed slugs get a 308 via the `redirect` table.
- Categories: editable `category` table seeded from `src/config/taxonomy.ts` (8 topics: AI engineering,
  AI agents/MCP/LLMOps, MLOps, AWS & cloud, Kubernetes, DevOps/SRE/platform, IaC, cybersecurity). Tags are free text.
- **Versioning exists**: `revision` (a committed snapshot per save/publish/restore) and `autosave` (one
  uncommitted working copy per user and document, shown in the editor as "You have autosaved changes … Restore /
  Discard"). Restoring loads a revision into the editor; the next save creates a new revision, so history is never
  rewritten (`src/lib/revisions.ts`). → No `seo_article_versions` table is needed.
- Publishing is a manual action in the editor (`publishPost`, `src/lib/posts.ts`); `publishDuePosts` publishes only
  posts a human scheduled. Editing a *published* post with `updatePost` changes the live page immediately, so the SEO
  platform must never call it (see DECISIONS.md D-06).
- Editor: `src/app/admin/posts/PostEditor.tsx` (Tiptap block editor + Markdown).
- Existing link tools: `internalLinks()`, `findBrokenLinks()`, `findImageProblems()` in `src/lib/content/links.ts`.

## LLM abstraction

- `src/lib/practice/ai/providers.ts#callModel(settings, apiKey, call)`: providers **openai** (or any
  OpenAI-compatible base URL, e.g. Ollama's `/v1`), **gemini** and **bedrock** (Converse). Structured output:
  OpenAI `json_schema` strict, Gemini `responseSchema`, Bedrock schema-in-prompt. Returns text + input/output tokens.
  Typed `ProviderError` codes (`timeout`, `rate_limited`, `auth`, `unavailable`, `bad_response`).
- Config pattern: settings in the `setting` table with the API key sealed by `SETTINGS_ENCRYPTION_KEY`
  (`src/lib/secrets.ts`), env fallback (`OPENAI_API_KEY`, `GEMINI_API_KEY`), Bedrock via pod credentials.
- Cost logging exists for practice (`practice_ai_usage`). Despite the module path, `callModel` has no practice-specific
  logic and is reused as-is.

## Jobs

- `job` table + `enqueue()` / `runDueJobs()` (`src/lib/jobs.ts`): Postgres queue with `FOR UPDATE SKIP LOCKED`,
  retries with exponential backoff, de-duplication by `dedupe_key` while queued/running.
- `startWorker()` (`src/lib/scheduler.ts`), started from `src/instrumentation.ts`, ticks every 30 s in **every**
  replica (2 replicas in production): publishes scheduled posts, runs due jobs (IndexNow), practice sweeps.
- There are **no Kubernetes CronJobs** in this repo and no other scheduler. Locking today is per-row (SKIP LOCKED) and
  `pg_advisory_lock` for migrations.

## SEO state (verified in code; production behaviour not re-tested here)

| Item | State | Evidence |
|---|---|---|
| GA4 collection | **Present.** Loads only in production when `GA4_MEASUREMENT_ID` is set, never on `/admin`, `/account`, `/login`, `/setup`, `/preview`. One `page_view` per location, `article_engaged` event. | `src/components/integrations/ThirdParty*.tsx`, `src/lib/analytics.ts`, `docs/SEO_ANALYTICS_ADS.md` |
| Consent | **Consent Mode v2** defaults (denied in EEA/UK/CH or everywhere with `CONSENT_DEFAULT=strict`); Google's certified CMP via AdSense. | `ThirdParty.tsx` |
| GTM | Not used (gtag.js directly). | grep |
| GSC verification | `GOOGLE_SITE_VERIFICATION` meta tag, or DNS (recommended in docs). | `docs/SEO_ANALYTICS_ADS.md` |
| robots.txt | Route handler; production disallows `/api/` and other workloads' path routes, advertises both sitemaps. | `src/app/robots.txt/route.ts`, `src/lib/seo/robots.ts` |
| Sitemaps | `/sitemap.xml` (+ image entries) and `/news-sitemap.xml`, per request, published + indexable only. | `src/app/sitemap.ts`, `src/lib/seo/sitemap.ts` |
| Metadata | Per-page title/description/canonical/OG/Twitter with SEO overrides. | `src/lib/seo/metadata.ts` |
| Structured data | `WebSite`, `Organization`, `Person`/`ProfilePage`, `BlogPosting`/`NewsArticle`, `BreadcrumbList`. | `src/lib/seo/jsonld.ts` |
| IndexNow | Postgres job queue (not Google). | `src/lib/indexnow.ts` |
| GSC / GA4 **data** APIs | **Not present.** No Search Console or Analytics Data API client, no service-account handling. | grep |

Conclusion: tracking, robots and sitemap logic are already complete; this project only **reads** from Google and
does not touch them.

## Deploy, secrets, observability

- Manifests: plain YAML + Kustomize in `minikube/` (`kubectl apply -k minikube`; run by a person via `./deploy.sh` until 2026-11-14, since then by `.github/workflows/deploy-minikube.yml` on merge).
  **No Helm chart, and the site is not an Argo CD app** (owner decision 2026-10-27); Argo CD only syncs `grafana/`
  dashboards. CI (`.github/workflows/ci-jithendar-com.yml`): PRs run lint, typecheck, test, build and
  `kubectl kustomize`; `master` builds, pushes `:latest` to Harbor and restarts the Deployment. Pushing a feature
  branch runs nothing.
- Secrets: plain Kubernetes Secret `jithendar-com-env` created by `scripts/create-secrets.sh` (never committed),
  public config in optional ConfigMap `jithendar-com-public`; `postgres-db-credentials` written by Terraform in the
  miniKube repo. In-app secrets are sealed with `SETTINGS_ENCRYPTION_KEY`. No Sealed Secrets / ESO.
- Egress: NetworkPolicy already allows 443 to public IPs, so Google APIs are reachable without manifest changes.
- Metrics: dependency-free Prometheus registry in `src/lib/metrics.ts` on port 9464 (in-cluster only), scraped by
  `roboshop-prometheus`. Logs: structured JSON (`src/lib/log.ts`) → Alloy → Loki (Alloy keeps only allowlisted fields:
  `event`, `level`, `route`, `operation`, `outcome`, `errorType`, `errorCode`, `traceId`, …). Traces: OTel → Jaeger.
  Dashboards: `grafana/*.json`.
- Alert rules live in **another repository** (`miniKube`, `deploy/minikube/observability/prometheus/files/alerts.yml`,
  group `jithendar-com`), standard Prometheus rule YAML with `runbook_url` annotations.
- Ingress: Istio gateway + `VirtualService` (`minikube/60-istio-routing.yaml`). Not touched.

## Minikube capacity (read-only `kubectl`, 2026-11-09)

8 nodes × 16 CPU / ~30 GiB allocatable. Requests per node: 0.8–1.3 CPU (5–8 %), 1.3–3.8 GiB (4–12 %).
Limits are overcommitted on CPU (up to 178 %) but not on memory (≤ 30 %). Namespace `jithendar`: Deployments
`jithendar-com` (2 replicas, 250m/512Mi requests, 2 CPU/1Gi limits), `practice-dispatcher`, `practice-executor-api`.
No CronJobs. **Budget:** ample, but the platform adds no new workloads (D-02), so the only cost is work inside
the existing pods (bounded by job concurrency and batch sizes).

## UI

- Design tokens: CSS variables / Tailwind theme (`bg-surface`, `text-fg`, `border-line`, `accent`…) in
  `src/app/globals.css`; **dark mode** supported (`ThemeToggle`, `dark:` variants).
- Admin shell: `src/app/admin/layout.tsx` (sidebar sections Overview/Content/Community/Account/Site/Operations,
  role-filtered) and `src/components/admin/AdminNav.tsx`.
- Components: `AdminHeader`, `Card`, `Stat`, `StatusPill`, `Table`, `th`/`td` (`src/components/admin/ui.tsx`),
  `Dialog`, `Flash`, form helpers.
- Charts: **no chart library**; small dependency-free SVG charts in `src/components/practice/Charts.tsx`
  (accessible: `role="img"`, labels, text equivalents). The SEO dashboard follows that pattern.
- PDF: no PDF generation path exists in the repo.
- Email: `sendMail(to, subject, text)` in `src/lib/mail.ts` (SMTP / Mailgun / SES, configured in Admin → Storage & email).

## Baseline checks

Recorded in PROGRESS.md under "Baseline" once the pre-change test run finishes.

## Repository rules that matter here (`www/AGENTS.md`)

- AI never publishes; AI output must land as a draft for human review. → consistent with this brief.
- "Agents do not commit or push." → conflicts with this brief's per-phase commits and PR; see DECISIONS.md D-01.
- Prefer existing dependencies; no new microservices without written justification.
