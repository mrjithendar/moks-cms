# AI News Desk: progress

Re-read this file and DECISIONS.md before continuing after a context reset.

Branch `feature/news-desk`, from `feature/seo-v4-crewai-mcp` @ `0312080` (identical tree to `master` @ `13c6099`, where v4
was merged as #31). Started 2026-11-10.

## Phase status

| Phase | Status | Commit |
|---|---|---|
| 1 Domain model and schema (migration 0017 + rollback) | done; up → down → up tested on PostgreSQL 17 | checkpoint 1 |
| 2 Ingestion + ML pipeline | done (unit + flow tests) | checkpoint 1 |
| 3 News Desk Crew | done (real CrewAI, scripted model) | checkpoint 1 |
| 4 Quality gates | done (unit tests incl. copied paragraph, unsupported number) | checkpoint 1 |
| 5 Cover images + alt text | done (template verified; Gemini/OpenAI mock-tested) | checkpoint 1 |
| 6 Review, publish, news SEO | in progress | |
| 7 Admin UI `/admin/news` | in progress | |
| 8 Learning loop | flows done (train, style review); UI approval in progress | checkpoint 1 |
| 9 Jobs and scheduling | dispatcher flow + locks + caps done; CronJob manifests pending | checkpoint 1 |
| 10 MCP, observability, deployment | metrics done; MCP tools, alerts, manifests pending | |
| 11 Tests, docs, PR | pending | |

## Checkpoint 1 (agent side + callbacks)

- `services/seo-agent/app/news/`: text, feeds, dedupe, cluster, classifier, scoring, select, config, cron, store (Pg +
  memory), runlog, budget, quality, images, schemas, tools, crew, desk. `app/flows/news.py`: 8 flows.
- New pinned dependencies: scikit-learn 1.9.1, lightgbm 4.7.0, datasketch 2.0.0 (+ scipy 1.18.1, joblib,
  threadpoolctl, narwhals). Image: `libgomp1` (LightGBM's OpenMP). On macOS, LightGBM needs libomp: tests run with
  `DYLD_FALLBACK_LIBRARY_PATH=.venv/lib/python3.13/site-packages/sklearn/.dylibs` (sklearn bundles one).
- Web: migration `0017_news_desk.sql` + rollback, `src/lib/news/{schema,cron,service,callbacks}.ts`, 8 callback
  routes, header-capable SSRF-safe fetcher (`headerFetcher`), news spend excluded from the SEO admin cap.
- Results (this Mac, Python 3.13.17): `ruff check` pass, `mypy app` pass (60 files), `pytest` **213 passed, 1 skipped**
  (with `SEO_AGENT_TEST_DATABASE_URL` → a scratch PostgreSQL 17; the skip is v4's pgvector test).
- Bugs found by the new tests and fixed: version regex swallowed sentence-final periods ("1.35." unsupported); MinHash
  LSH missed true near-duplicates at Jaccard 0.84 (candidate threshold now lower than the decision threshold);
  datasketch 2.0 requires an explicit hashing scheme; a crashed draft left its story "drafting" and blocked retries.

## Open issues

- (filled in as the work goes)
