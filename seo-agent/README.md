# seo-agent

The SEO agent of moks-cms. It's written in Python and runs CrewAI Flows and Crews as the only job engine. It also hosts
the MCP servers, pgvector retrieval, Ask the Blog and report PDFs. It reads and writes the web app's PostgreSQL
database and calls the web app's internal callback API.

**Part of moks-cms since 2026-11-26 (D-105).** It lived in its own repository, mrjithendar/moks-seo-agent, from
2026-11-18 (split out of `services/seo-agent`) until it was merged back here with its history. So `moks-seo-agent#N` in
docs and old commit messages refers to that repository's pull requests, and `moks-tech/moks-cms#N` in its old commit
messages to this repository's. There is one image, `moks-cms`, built from the repository's one `Dockerfile`: the web app
and this agent. A site's pod runs it as two containers: the site (`node server.js`) and the agent
(`python -m app.main` in `/srv`).

| Path | What |
|---|---|
| `app/` | The service: internal API on port 8080 (`app/main.py`), MCP edge on port 8090 (`app/mcp`), flows, crews, tools |
| `tests/` | pytest; `tests/moks_cms.py` points the contract tests at the web app (the parent folder) |
| `scripts/` | RAG eval and calibration, the reranker's PyTorch tooling (`reranker_model.py`), the database role (`db-role.sql`) |
| `../Dockerfile` | The image (stages `agent-build` and `runtime`): locked dependencies, the bge-small-en-v1.5 ONNX model and the reranker's int8 ONNX model (checksums verified in the build) |

The design docs are in `../docs/seo/` (FLOWS, CREWS, RAG, MCP, ML, OPERATIONS, SECURITY, MANUAL_SETUP, DECISIONS) and
`../docs/news/`. A path written as `moks-cms/<path>` in code comments means that file in this repository (`../<path>`
from here).

## Local development

```bash
uv sync --frozen
uv run ruff check app tests
uv run mypy app
uv run pytest -q -rs
```

Run these in `seo-agent/`. Some tests check that the agent and the web app still agree: they read the web app's
migrations, the callback server's route table and a few shared constants from the parent folder, so they run
everywhere, CI included (`$MOKS_CMS_DIR` points them at another moks-cms checkout).

The Postgres tests need `SEO_AGENT_TEST_DATABASE_URL` (pgvector, PostgreSQL 18) or Docker for testcontainers. The CronJob test reads jithendar.com's
`kubernetes/seo-agent-*.yaml` (`$SEO_AGENT_K8S_DIR`, or jithendar.com checked out next to moks-cms): one dispatcher CronJob, every minute.

## Several agents at once

Since D-105 every site pod has an agent container, so there are as many agents as the site has pods (KEDA scales them).
A flow run executes in the agent that started it; the run's Postgres advisory lock says that agent is alive.
`app/runs.py` makes this safe: each agent sweeps, at start-up and every minute, only the queued/running runs whose lock
nobody holds (or that are older than the flow wall-clock limit plus 5 minutes), never rows younger than 30 seconds,
and stops within 5 seconds a run of its own that another agent cancelled or swept, keeping the status that agent wrote.
The schedule dispatcher already claims each time slot in the database, so a second agent starts nothing twice. The site
talks to its own pod's agent (`SEO_AGENT_URL=http://127.0.0.1:8080`), so the LLM budget holds it takes are settled by
the same process. Budget reservations are per agent: with N pods, calls that start at the same moment in different pods
can go over the budget by at most N-1 calls' estimates (`app/llm.py` BudgetGuard).

## The LLM budget

One budget for everything (`app/llm_budgets.py`): an optional daily limit and an optional monthly limit in USD, by UTC
day and month. It counts every provider, model and purpose together (drafts, crews, the news desk, Ask the Blog, and
the web app's own calls). An empty limit is no limit, and **nothing is preset**: until a budget is saved, only the
provider's own spend limit stops spending.

- `GET /llm-budget?scope=day|month`: spent, limit, remaining, calls in flight, a month-end forecast, and the period's
  spend by provider, by model and by purpose (for reading; they limit nothing). `PUT /llm-budget`
  `{daily_usd, monthly_usd, actor}` saves it.
- `BudgetGuard` checks it before every call and holds the call's upper-bound estimate while it runs, so concurrent
  calls cannot overspend together.
- The web app's own LLM calls use `POST /llm-budget/reserve` `{max_usd, purpose}` (402 when it does not fit) and
  `POST /llm-budget/settle` `{id}`. A hold that is never settled lapses after 15 minutes.
- Still apart: Ask the Blog's own daily limit (`ASK_BLOG_DAILY_BUDGET_USD`, a guard against readers running up spend)
  and, until the news desk moves over, the news desk's own caps.
- Gone: `SEO_LLM_MONTHLY_BUDGET_USD` (ignored if still set) and the limits per model and per provider. Their rows in
  `seo_agent_llm_budgets` are left in place and shown read-only as `legacy_limits`; `GET /llm-budgets` still answers
  an older web app with spend and no limits, and `PUT /llm-budgets` answers 409.


## LLM providers and models

`app/llm_providers/`: which providers exist (`catalog.py`) and what an admin has set up (`store.py`, tables
`seo_agent_llm_providers` and `seo_agent_llm_models`, created at start-up).

- **Catalog.** Anthropic, OpenAI, Google Gemini, Azure OpenAI, AWS Bedrock, Mistral, xAI and "Custom
  OpenAI-compatible". Each entry was checked against the provider's own docs and cites the page and the date. The
  catalog holds no model list and no price. Named in the plan and not yet checked, so reachable only through
  "Custom" for now: DeepSeek, Groq, Cohere, Perplexity, Together AI, Fireworks AI, OpenRouter, Ollama.
- **Keys.** Sealed with `SEO_AGENT_SETTINGS_KEY` (AES-256-GCM). Write-only: a key is never returned, logged or sent
  to the browser; the API says `saved`, `env`, `none` or `not_needed`. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the
  environment are used when no key is saved.
- **Prices.** Never invented. A model cannot be switched on until its input and output prices (USD per million
  tokens) are entered, unless it is a Claude model with a built-in price (`app/llm.py` `PRICES`) or it is marked free.
- **API.** `GET /llm-providers`, `PUT /llm-providers` (one provider and, when `models` is sent, all of its models;
  validated, all or nothing), `GET /llm-models` (models that are on, for pickers).
- **Fetch models.** `POST /llm-providers/{id}/discover` asks the provider for its model list (Anthropic and the
  OpenAI-compatible kinds) and marks which ones are already listed. Nothing is saved or switched on, and it costs
  nothing. Gemini, Azure OpenAI and Bedrock models are added by hand for now.
- **Not yet.** Nothing calls a provider from these tables: every job still calls Anthropic as before. The adapters,
  "Fetch models", "Test", and the model for each job come in later changes; until then Anthropic cannot be switched
  off here.

## LLM adapters

`app/llm_adapters/`: thin `httpx` clients for providers other than Anthropic (no LiteLLM, no vendor SDKs). An adapter
knows one API shape and nothing about the budget, prices or usage rows; the caller books what it returns.

- `openai_compat.py`: Chat Completions for OpenAI and every compatible server (`Authorization: Bearer`, Azure's
  `api-key` header, or no key for a local server). Structured answers use `response_format` `json_schema` where the
  endpoint supports it, else JSON mode, else plain text; every answer is validated against the Pydantic model here
  and gets one repair request before it is refused. Retries 408/409/429/5xx and connection errors twice. Errors
  carry the provider's message and code, never the key or the prompt. `list_models()` reads `GET /models`.
- Not yet: images, streaming, tools; and **nothing calls an adapter yet**. Wiring behind the budget guard, with the
  admin's prices, is a later change.

## Settings an admin can change

Some settings can be changed from the web app (Admin → AI & SEO → Settings) instead of the deployment's environment.
They live in `app/admin_settings/`:

- **Precedence**: the admin's saved value, then the environment variable, then the default in `app/config.py`. With
  nothing saved, the agent behaves exactly as before.
- **Storage**: the agent's own table `seo_agent_settings` (key = the environment-variable name), created at start-up
  like `seo_agent_llm_budgets`. No moks-cms migration.
- **API** (internal token): `GET /admin-settings` returns every group with its fields, the effective value, where it
  comes from (`admin`, `deployment`, `default`) and whether a restart is pending. `PUT /admin-settings/{group}` takes
  `{"values": {"ENV_NAME": value}, "actor": "..."}`; a field that is not sent stays as it is, and `null`, `""` or `[]`
  clears it. One invalid field refuses the whole save (422 with `issues`).
- **Live or restart**: a `live` field applies at once in this process and within 30 seconds in any other. A `restart`
  field is stored and reported as "restart pending" until the agent restarts.
- **Secrets** are sealed with `SEO_AGENT_SETTINGS_KEY` (32 characters or more; `openssl rand -base64 32`) using the
  same scheme as moks-cms `src/lib/secrets.ts`, with its own key. They are never returned: the API says only whether
  one is set. Without the key, secret fields cannot be saved ("Requires manual configuration"). Rotating the key
  makes stored secrets unreadable.
- **Never registered** (the agent could not start, or the admin could lock itself out): `DATABASE_URL`,
  `SEO_AGENT_DATABASE_URL`, `SEO_AGENT_TOKEN`, `SEO_AGENT_CALLBACK_TOKEN`, `SEO_AGENT_CALLBACK_URL`,
  `SEO_AGENT_SETTINGS_KEY`, `OTEL_*`, `SITE_URL`. The registry refuses them and a test checks it.

### How to add a settings group

1. Add `app/admin_settings/groups/<group>.py` with one `GROUP = Group(id, title, description, fields=(...))`. Each
   `Field` names the environment variable, the `Settings` attribute it feeds (`attr`), a label, a plain hint, a type
   (`text`, `integer`, `number`, `boolean`, `select`, `list`, `secret`), and where they apply a unit, `min`/`max`,
   `options` or a `pattern`. Ranges should match the clamps in `app/config.py`: they refuse a value, they do not set
   one.
2. Append the group to `GROUPS` in `app/admin_settings/groups/__init__.py` (append only: one module per group so
   parallel changes do not collide).
3. Decide `apply` by reading the code: `live` only if every reader takes the value from the shared `Settings` object
   at the time it uses it (`deps.settings.x`, `c.settings.x`). If anything copies it when it is built (a client's
   timeout, a pool size), use `restart`.
4. Nothing else changes: `app/config.py` already parses the variable, and the store lays the saved value over the
   environment before `load_settings` runs.
5. Add the group's fields to `tests/test_admin_settings.py` (which are live, which need a restart).


Groups so far: **Agent limits**; **Embeddings** (the backend's address, key and time limit; the provider and model
stay in the deployment until a guarded re-embed exists); **Retrieval** (passages per answer, lowest similarity, the
reranker's switch and limits, how long questions are kept); **MCP servers** (the two switches, live; their rate limits and
allowed hosts, on restart). It also holds three lists that only take things away: public tools switched off, admin tools switched off (refused at once, out of the tool list after a restart) and flows that may not be started over MCP (narrows the code's allowlist, never widens it). Ask the Blog's own switch, audience, daily limit and cache time stay in Ask the Blog.

## Flows, crews and the flow engine

The admin keeps one catalogue of every flow and crew (moks-cms `crewai_flows` / `crewai_crews`, its docs/seo/CATALOGUE.md).
This service provides what that catalogue runs and shows:

- **`GET /flows` and `GET /crews`** also serve each one's label, description, default categories and how a run may be
  started (`FLOW_INFO` / `CREW_CATEGORIES` in `app/flows/__init__.py`). Categories are organisation only: nothing here
  reads them back.
- **The flow engine** (`app/flows/custom.py`, flow `custom_flow`) runs a flow made of steps: crew (any crew; a code
  crew runs from its defaults plus its active version via `app/crews/custom.py` `materialize`), flow (another flow as a
  child run, within the runner's policy), condition and draft. Each step may have `needs`, `when`, `retry` (attempts,
  delay, backoff), `timeout_seconds` and `on_failure` (stop, continue, fallback). A crew spec has an input schema and an
  optional output schema (checked after each run). A test run (`dry_run`) may carry an unsaved `draft` flow and
  `crew_draft` crew; it never creates drafts or starts other flows.
- **`POST /crews/{crew}/as-spec`** turns a code crew into a spec under a new key (the admin's Duplicate).
- **`GET /config-catalogue`** (`app/config_catalogue.py`): everything code-defined that the web app's CrewAI
  configuration bundle describes (moks-cms docs/seo/CREWCONFIG.md, crewconfig/ in the site repository), read from the
  registries: every crew with its code defaults, every flow with its input schema, every tool (what it tells the model,
  which crews and agents hold it, whether a spec crew may), the guardrail rules every system prompt carries, and the
  priced models. No secrets. Tool descriptions are data (`TOOL_DESCRIPTIONS`, `NEWS_TOOL_DESCRIPTIONS`) so they can be
  listed without a run. `POST /crews/{crew}/validate` accepts a fixed task's expected output when it is unchanged, so a
  crew exported in full imports back as no change.
- **Flow switches**: before every kickoff the runner asks the web app which flows are switched off
  (`GET /internal/seo-agent/flow-switches`, kept 30 s, `app/flows/switches.py`) and refuses them with 409, whoever starts
  them. When the web app cannot be reached the last answer stands (nothing is off until it has said so).
- **Run logs**: each step records attempts, conditions, versions, child runs, tokens, cost and input/output metadata in
  its run-history row; every log line, step detail and transcript is redacted first (`app/redaction.py`, also used by
  the stderr JSON formatter). The web app's Run history settings `logs` and `step_io` (on by default) decide what is kept.

## The reranker and PyTorch

Search can reorder its passages with a cross-encoder (`app/reranker.py`): cross-encoder/ms-marco-MiniLM-L6-v2, int8
ONNX, baked into the image. It is **off** until **Rerank passages** is switched on in Admin → AI & SEO → Settings →
Retrieval, which applies at once. The same group holds its limits, all 0 (no limit) until you set them: passages it
reads, a time limit, and reranks at once; plus its CPU threads (on restart). Whatever goes wrong (no model, too slow,
busy, a failure), the search returns the order it has without it. `seo_rag_rerank_total{outcome}` counts what
happened, and `seo_rag_rerank_seconds` is the model's time per search. The news desk's duplicate check never reranks
(it reads the nearest articles by cosine).

Measured on the 95-question eval set (an M3 Pro, not mk4) with the whole search timed. "All" is every candidate left
after the 3-per-article cap: up to 20 (`RAG_CANDIDATES`), about 10 on average.

| Passages reranked | Threads | Recall@3 | MRR | p95 |
|---|---|---|---|---|
| none (production today) | | 90.5 % | 0.865 | 10 ms |
| all | 2 | 95.2 % | 0.899 | 559 ms |
| all | 4 | 95.2 % | 0.899 | 349 ms |
| 10 | 4 | 92.9 % | 0.894 | 211 ms |
| 6 | 4 | 91.7 % | 0.894 | 108 ms |

That table has no similarity floor, which is how the crews' `vector_search` and MCP search run. **Ask the Blog filters
by its lowest similarity first** (`ASK_BLOG_MIN_SCORE`), and the reranker only reorders what passes. At today's 0.66
it gains less: Recall@3 85.7 % → 88.1 % (+2.4, under the +3 rule). At the calibrated 0.59 the floor removes nothing the
eval needs, and the gain is the full 90.5 % → 95.2 %. So for Ask the Blog the reranker passes its accuracy rule only
together with the floor at 0.59.

Measure on mk4's CPU before switching it on: `rag-eval.yml` with `token-vector-div,token-vector-rerank` and
`--reranker-threads N --reranker-candidates N` gives the same table on a GitHub ARM runner, and the live eval in
`seo_ml_flow` records whether it ran with the reranker (`seo_rag_eval_runs.metrics.reranker`).

**PyTorch** is not in the image or in CI. It is the `train` dependency group (torch from PyTorch's CPU index,
transformers, onnx), for model work outside the service:

```bash
uv sync --group train
uv run --group train python scripts/reranker_model.py download --out /tmp/rr/src
uv run --group train python scripts/reranker_model.py export --src /tmp/rr/src --out /tmp/rr/fp32 --int8 /tmp/rr/int8
uv run --group train python scripts/reranker_model.py verify --src /tmp/rr/src --onnx-dir /tmp/rr/int8 --model-dir /models/bge-small-en-v1.5
```

`verify` scores each eval question's real candidates with PyTorch and with the ONNX file through the service's own code,
and reports the logit differences and how often the rankings agree. Run it before baking a new ONNX file. On
2026-11-22 (959 pairs, the 95 questions' bge-small candidates): the fp32 export matched PyTorch to 0.00002 with the
same order for every question; the baked int8 file differs by 0.16 on average (max 0.85), Kendall τ 0.94, the same
best passage for 93 of 95 questions (ONNX Runtime's own int8 quantization of the export: 89 of 95, so the image keeps
the repository's file). Its timings on macOS say nothing about mk4 (PyTorch uses Apple's Accelerate there).

## Browsing the article index

The web app's **AI & SEO → Article index** page (`/admin/article-index`) reads the pgvector index through this service's
internal API, read-only (`app/chunk_browser.py`, D-103): `GET /chunks` (tables, rows, articles, models, vector type,
size, index method), `GET /chunks/articles` (each article's chunk count, filter by title or slug), `GET /chunks/rows`
(one article's chunks, filter by text) and `GET /chunks/rows/{id}` (one chunk in full, its first vector values and its
five nearest chunks). `table=rebuild` shows `seo_article_chunks_next` while a rebuild after an embeddings model change
runs. Nothing writes: a hand-edited chunk would no longer match its vector, and the next reindex rewrites it anyway.

LanceDB is not used. The copy of the index on R2 and the `/admin/lancedb` browser were removed on 2026-11-26 (D-103),
and `pyproject.toml` overrides CrewAI's requirement on LanceDB away again (D-47).

## The shared knowledge base (moks-rag)

[moks-rag](https://github.com/mrjithendar/moks-rag) runs a hybrid (dense + sparse, RRF) search service, rag-api, in
namespace `rag`. The agent owns one collection there, `seo_intel`, and reads moks-cms's `cms_content`. The agent's own
pgvector index (Ask the Blog, the crews' `vector_search`) is unchanged.

| Variable | Default | |
|---|---|---|
| `RAG_API_URL` | empty (off) | `http://rag-api.rag.svc.cluster.local:8000` on mk4 |
| `RAG_BEARER_TOKEN` | empty (off) | rag-api's shared token, from a Kubernetes Secret |
| `RAG_SEO_COLLECTION` / `RAG_CMS_COLLECTION` | `seo_intel` / `cms_content` | |
| `RAG_TIMEOUT_SECONDS` / `RAG_QUERY_TIMEOUT_SECONDS` | 120 / 20 | per attempt; 3 attempts on connection errors, timeouts, 429 and 5xx |
| `RAG_CANNIBALIZATION_MIN_SIMILARITY` | empty (not used) | Admin → Settings → Shared knowledge base |

Off unless both the URL and the token are set; every feature below then says so (503 from the API, outcome
`not_configured` from the flow) and drafting works as before.

- **Client** (`app/moks_rag.py`): `/ingest`, `DELETE /documents/{doc_id}`, `/query`, with `Authorization: Bearer`,
  `X-Service-Name: moks-seo-agent` and an `X-Request-ID` that stays the same across retries. The token opens every
  collection of every service, so the client refuses, before sending, any write except to `seo_intel`, any query
  except of the two collections above, and it always names the collection on DELETE (rag-api's default is `all`).
  Queries always send `include_answer: false`: rag-api's answer would be a Claude call through its own LiteLLM key,
  outside this service's LLM budget. One JSON log line per request (`event: moks_rag_request`; never the token or the
  text), metrics `seo_moks_rag_requests_total{op,outcome}` and `seo_moks_rag_request_seconds{op}`.
- **seo_intel** (`app/seo_intel.py`): `keyword_cluster` (one per seo_ml query cluster, with 28 days of Search Console
  numbers per query) and `gsc_performance` (one per page) are rebuilt by **`seo_intel_sync_flow`**. It sends only new
  and changed documents and deletes the ones that are gone; schedule it after `seo_ml_flow` in the CrewAI console (no
  built-in schedule). `competitor_brief` and `style_guide` (brand and style guidelines) are sent with
  `POST /seo-intel/documents` `{type, title, text, target_keyword?, source?, doc_id?}`. The site's own style guide
  (`style_guide:site`) is refreshed from each new article's brief. Every chunk's metadata has `type`,
  `target_keyword` and `updated_at`. `GET /seo-intel/documents` lists what the agent sent (table
  `seo_agent_rag_documents`, created at start-up; rag-api cannot list a collection), and `DELETE
  /seo-intel/documents/{doc_id}` removes one. Search Console queries that look like an e-mail address, a phone number
  or a secret are left out.
- **Drafting help** (`app/site_context.py`), no model call: `POST /site-context/internal-links` `{title, headings,
  exclude?}` returns up to 5 existing articles with their URL, anchor suggestions and the draft heading each fits
  under. `POST /site-context/cannibalization` `{keyword, topic?, exclude?}` flags a published article whose title has
  every word of a keyword of two or more words, or which targets the same keyword, or (only when the owner set the
  floor) which is at least that similar. **`new_article_flow`'s `ground` step** runs all three for the brief (target
  keyword: `targetKeyword`, else the first supporting query, else the title). The Editorial crew gets seo_intel, the
  site's articles and the link candidates as data. Each article that may compete becomes a warning on the draft. When
  moks-rag fails, the step records why and the crew drafts without it.
- **What cms_content must carry** (moks-cms writes it): per chunk `url` or `canonical_url` on the site's host (or
  `path`, or `slug` + `collection`) and `title`; optionally `heading`, `target_keyword` and `status` (when present,
  only `published` counts). A chunk without a location, or on another host, is never suggested.

## CI and release

- moks-cms's `.github/workflows/ci-moks-cms.yml` runs the agent's checks as the job `seo-agent` on every pull request:
  ruff, mypy, pytest with a pgvector PostgreSQL (with the contract tests), the RAG eval smoke and pip-audit.
- The `image` job (pull requests) and `release` (merges into the default branch) build the one `moks-cms` image from
  `../Dockerfile` and smoke-test it as the site (`scripts/smoke-site-image.sh`) and as the agent
  (`scripts/smoke-seo-agent-image.sh`: both ports, the guarded endpoints, a PDF and an embedding). `release` pushes
  `registry.jithendar.com/jithendar/moks-cms:pr-<n>` and `:latest`. It tells no site and deploys nothing; the
  `seo-agent:latest` image is no longer built.
- `.github/workflows/seo-agent-rag-eval.yml` is the manual retrieval evaluation with the production embedding model.

Repository settings: moks-cms's own `HARBOR_USERNAME` and `HARBOR_PASSWORD` (the Harbor robot that pushes to project
`jithendar`); the agent needs nothing of its own.
