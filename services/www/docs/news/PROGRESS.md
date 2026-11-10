# AI News Desk: progress

Re-read this file and DECISIONS.md before continuing after a context reset.

Branch `feature/news-desk`, from `feature/seo-v4-crewai-mcp` @ `0312080` (same tree as `master` @ `13c6099`, where v4 was
merged as #31). Started 2026-11-10.

## Phase status

| Phase | Status | Commit |
|---|---|---|
| 1 Domain model and schema (migration 0017 + rollback) | done; up → down → up tested on PGlite and PostgreSQL 17 | `8544af7` |
| 2 Ingestion + ML pipeline | done (unit + flow tests) | `8544af7` |
| 3 News Desk Crew | done (real CrewAI, scripted model) | `8544af7` |
| 4 Quality gates | done (incl. copied paragraph and unsupported number fixtures) | `8544af7` |
| 5 Cover images + alt text | template verified; Gemini/OpenAI mock-tested | `8544af7` |
| 6 Review, publish, news SEO | done (PGlite end-to-end: save → approve → publish → NewsArticle + news sitemap) | checkpoint 2 |
| 7 Admin UI `/admin/news` | done (Playwright on a production build, desktop + mobile) | checkpoint 2 |
| 8 Learning loop | done (train + style review flows; approval in the UI) | `8544af7` + checkpoint 2 |
| 9 Jobs and scheduling | done (dispatcher flow, slot idempotency, locks, caps; CronJob manifests) | checkpoint 2 |
| 10 MCP, observability, deployment | done (tools, metrics, DB gauges, alerts snippet, dashboard, manifests rendered) | checkpoint 2 |
| 11 Tests, docs, PR | done | checkpoint 2 + PR |

## Validation (2026-11-10, this Mac, Node 26, Python 3.13.17)

| Check | Result |
|---|---|
| seo-agent `ruff check app tests` · `mypy app` | pass · pass (61 files) |
| seo-agent `pytest` | **215 passed, 1 skipped** with `SEO_AGENT_TEST_DATABASE_URL` → scratch PostgreSQL 17 (the skip is v4's pgvector test); without it 208 passed, 8 skipped. v4 baseline: 124 + 6 |
| web `npm run lint` · `npm run typecheck` | pass · pass |
| web `npm test` | **757 passed** in 65 files (v4 baseline 740 in 64; +17 news) |
| web `APP_ENV=production npm run build` | pass; only the pre-existing Edge-runtime warning (`request-log.ts`) |
| Playwright `e2e/news-desk.spec.ts` (production build, seeded PGlite) | desktop 4/4, mobile 3/3 run (the review test was run on desktop only: it rejects the one seeded draft) |
| `scripts/check-dashboards.py` | 6 dashboards OK |
| `scripts/manifests.sh seo-agent` → `ci-app-manifests.py` | 19 objects; 3 news CronJobs classified manual |
| `kubectl kustomize minikube` | pass |
| `kubectl create --dry-run=client` | **not run**: no cluster context on this machine (not touched on purpose) |
| alerts YAML | parses (6 rules); promtool not installed |
| Docker image build | **not run** (no container runtime); CI builds it |
| Live Claude / Gemini / OpenAI / cluster | **not run** (credentials / production) |
| Memory | ML libraries +≈ 70 MiB (lazy, first news run); classifier/ranker training ≈ 0.1 s; template cover ≈ 0.2 s. Current requests/limits kept |

## Bugs found by the new tests and checks, fixed before commit

- Version regex swallowed a sentence-final period ("1.35." → unsupported).
- MinHash LSH missed a true near-duplicate at Jaccard 0.84 (candidate threshold now below the decision threshold).
- datasketch 2.0 needs an explicit hashing scheme to rebuild a stored MinHash.
- A draft that crashed left its story "drafting", blocking retries (now marked `failed`).
- `job` as a metric label collides with Prometheus's scrape label → `news_job`.
- GitHub `.atom` release feeds are disallowed by github.com's robots.txt → the REST API; the Azure blog feed is
  disallowed for generic crawlers → not a starter source. Found by checking every starter URL against robots.txt.
- robots.txt 429 must count as "disallowed for now" (Google's rules), not "no restrictions".
- Mobile: the job editor's scrolling tab strip hid tabs at its clipped edge; analytics tables pushed the page sideways.
- Cover template broke "in-place" at the hyphen.
- The E2E seed script was not a module (top-level await broke the production type check).

## Owner-visible changes to existing code

- `seo-intel/publish.ts#publishNewArticle`: news drafts also apply their reviewed category/tags/sources/cover; news
  bookkeeping after success. Still only reachable from a verified approval.
- `seo-intel/drafts.ts#reviewQueue` + `ReviewQueue.tsx`: News badge, job, score, age; news priority = score × freshness ×
  job review priority.
- `seo-intel/claude.ts` and `app/llm.py`: news spend excluded from the SEO admin monthly cap (N-07).
- `seo-intel/crawler.ts`: `headerFetcher` (same guarded path, optional request headers).
- `pages/article.tsx`: optional "This news may be outdated" notice for news with an expiry.
- Admin sidebar: "News desk". `globals.css`: news admin excluded from the public stylesheet (D-37).
- seo-agent tests: `test_mcp.py` lists the two new non-read-only admin tools; `test_contract.py` covers the news calls.

## Open issues / needs a person

- Live behaviour with real Claude, Gemini/OpenAI, feeds and the cluster is not verified (MANUAL_SETUP.md).
- Per-article costs in COSTS.md are estimates until real runs are measured.
- Alert rules must be copied into the miniKube repo; dashboard loads after an Argo CD sync.
- No single cross-process E2E (agent + web) was built: as in v4, each half is tested end to end with the other mocked.
