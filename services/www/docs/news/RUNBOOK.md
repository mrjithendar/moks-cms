# News desk runbook

## Where to look

- **Run history** (Admin → News desk → Run history) and **run detail**: timeline, live log, candidates with reasons,
  drafts, errors. Every run, including dry runs, image regenerations, training and style reviews.
- **Grafana** "Jithendar.com · News desk" (`services/grafana/jithendar-com-news.json`).
- **Loki**: `{app="seo-agent"} | json | operation=~"news_.*"` (log lines carry `operation=news_<step>` and `outcome`;
  the run id is in the database row the UI links to, D-19).
- **Agent API**: `GET /flows/runs?flow=news_job_flow` (internal).

## Kill switch and rollback

1. Fastest: Admin → News desk → Settings → **Paused** (no deploy). The dispatcher and every job skip.
2. `NEWS_DESK_ENABLED=false` in ConfigMap `seo-agent-config` (and the web app's `jithendar-com-public`), restart.
3. Suspend the CronJobs: `kubectl -n jithendar patch cronjob news-dispatch -p '{"spec":{"suspend":true}}'`
   (same for `news-train`, `news-style-review`).
4. Code rollback: redeploy the previous image tag / `git revert` the merge; the migration is additive and can stay.
   Removing the tables is a manual, owner-approved step: `src/db/rollback/0017_news_desk.down.sql` (deletes all news
   desk data; CMS posts and drafts are untouched).

## Metrics

| Metric | Labels |
|---|---|
| `news_runs_total` | news_job, status |
| `news_run_duration_seconds` | news_job |
| `news_items_fetched_total`, `news_source_errors_total` | source_type |
| `news_candidates_total` | decision |
| `news_drafts_total` | status |
| `news_quality_failures_total` | gate |
| `news_images_generated_total` | provider, status |
| `news_cost_usd_total` | kind (llm, image) |
| `news_model_auc` | model (ranker = AUC, classifier = macro F1) of the **serving** model; kept for the dashboard |
| `news_model_macro_f1`, `news_model_holdout_auc` | model: the same numbers under correct names (classifier, ranker) |
| `news_model_score_psi` | model: score drift of the serving model vs its training rows (> 0.25: drift; docs/news/ML.md "Monitoring") |
| `news_topic_assignments_total` | method (model, model_low_conf, claude, rules) |
| `news_budget_used_ratio` | scope (global/job × llm/image × day/month) |
| `news_job_consecutive_failures`, `news_job_last_draft_timestamp_seconds` | news_job (DB-computed) |
| `news_source_failing_seconds`, `news_quality_failure_ratio_7d` | — (DB-computed) |

`news_job` is the job id; the web app refuses more than 25 jobs, so it is bounded. (`job` is Prometheus's scrape label.)

## Alerts (`docs/news/prometheus-alerts.yml`, add to the miniKube repo)

### job-failing
Two failed runs in a row. Open the last run: a failed step shows its error. Common: the web callback unreachable (the
web pods or their callback listener down), Anthropic errors (status page), a bad job config after an edit (roll back the
version). Retry with *Retry failed drafts* or *Rerun job*.

### source-failing
An enabled source has not fetched for 24 h. Sources page: last status and HTTP code. 404/410 = moved (find the new feed);
"robots.txt … does not allow" = the publisher disallowed it (disable the source); 429/5xx = their problem (wait); "not on
the allowlist" = the URL redirects to another host (update the URL).

### quality-failures
Over half of the drafts in 7 days failed the gates. Run detail → article → failed gates. `source_similarity` across many
drafts: the writing profile encourages close paraphrase (strengthen "in your own words", add examples); `grounding`: the
researcher is not capturing numbers (check the fact sheet) or the writer adds context numbers (banned via profile);
`value`: the structure template lacks analysis sections.

### budget
80 % or 100 % of a cap. Runs pause with "paused (budget)". Raise the job's or the global cap (Settings) or wait for the
period to reset; check the run detail for an unusually expensive run (token cap per draft).

### no-drafts
A job produced nothing for review in 3 days. Open its last runs: every candidate has a reason (threshold too high,
keyword filters too narrow, everything already covered, sources failing).

## Common tasks

- **Rerun a run**: run detail → *Rerun job* (idempotent: covered stories are skipped). *Retry failed drafts* redrafts only
  the stories that did not reach review.
- **A draft is stuck "drafting"**: the agent restarted mid-run; runs are failed on start-up (v4 D-57) and the article is
  marked failed; retry from the run.
- **Wrong category**: fix it in review; it becomes a human label for the next training.
- **Model rollback**: list versions with the MCP tool `list_news_models` (read-only) or
  `select kind, version, active, metrics->>'macro_f1', notes, trained_at from news_models order by trained_at desc`.
  Activate an earlier version (it must have an artefact) with `NewsStore.activate_model(kind, version)` /
  `app.news.desk.activate_model_version`, or in SQL, in one transaction:
  `begin; update news_models set active = false where kind = 'ranker' and active; update news_models set active = true where kind = 'ranker' and version = '<version>'; commit;`
  The gauges follow within 15 minutes (dispatcher). There is no MCP tool that changes the serving model: like
  approval, it stays an owner action.
- **A correction**: review page of the published draft → *Add correction / update*.
- **Retention**: logs 90 days, unused items/candidates 180 days (Settings); pruned daily at 03:00 UTC by the dispatcher.
- **Source test**: Sources → *Test now* (a `news_ingest_flow` run for that source).

## Postgres test database (developers)

`services/seo-agent/tests/test_news_postgres.py` runs the store against the real migration when
`SEO_AGENT_TEST_DATABASE_URL` is set. On macOS, LightGBM needs an OpenMP runtime: run pytest with
`DYLD_FALLBACK_LIBRARY_PATH=.venv/lib/python3.13/site-packages/sklearn/.dylibs` (scikit-learn bundles libomp), or
`brew install libomp`. The image installs `libgomp1`.
