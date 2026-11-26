# SEO agent settings inventory (moks-cms `seo-agent/`, 2026-11-26)

Read-only research. Code: `seo-agent/app` (paths below are relative to `seo-agent/` unless they start with `src/`,
which is the moks-cms web app). Deployment: jithendar.com `kubernetes/seo-agent-40-seo-agent.yaml` (ConfigMap
`seo-agent-config`, "CM" below), jithendar.com `kubernetes/30-jithendar-com.yaml` (container `seo-agent`, lines 256-302),
jithendar.com `scripts/create-seo-agent-secrets.sh`, `create-seo-agent-rag-secret.sh`, and the image `Dockerfile`
(ENV at lines 117-123). Secret values were never read; only key names.

## How a value reaches the agent

| Layer | Where | Precedence | When it applies |
|---|---|---|---|
| Code default | `app/config.py` Settings (lines 102-185) and module constants | lowest | always |
| Image ENV | `Dockerfile:117-123` (APP_ENV, EMBEDDINGS_MODEL_DIR, RAG_RERANKER_DIR, CREWAI_*, thread limits, GIT_SHA) | over code | pod start |
| Deployment env | CM `seo-agent-config` + Secret `seo-agent-env` (envFrom) + explicit env (DATABASE_URL, SEO_AGENT_DATABASE_URL, RAG_API_URL, RAG_BEARER_TOKEN) in `30-jithendar-com.yaml:268-302` | over image | pod start (`load_settings()` once, `main.py:857`) |
| Admin settings registry | table `seo_agent_settings` (key = env name), 5 groups in `app/admin_settings/groups/` | **admin > env > default** (`admin_settings/store.py:5`, overlay `store.py:145-157`) | "live" fields copied onto the shared Settings object at save (that pod) and every 30 s in every other pod (`store.py:38`, `main.py:394-403`); "restart" fields only when that pod starts (`main.py:247-249`) |
| Agent-owned tables | `seo_agent_llm_budget`, `seo_agent_llm_budgets` (legacy), `seo_agent_llm_providers`, `seo_agent_llm_models` | table only | cached 30 s per pod |
| Web-owned rows the agent reads | `setting` rows `ask_blog`, `news`, `seo` (weights); via callbacks: flow switches, crew configs, skills, run-history switches; tables `seo_flow_schedules`, `news_jobs` | see each row | per use / short TTL |

Registry rules: `admin_settings/registry.py:8-16` ("live" vs "restart"), NEVER list `registry.py:27-36` (DATABASE_URL,
SEO_AGENT_DATABASE_URL, SEO_AGENT_TOKEN, SEO_AGENT_CALLBACK_TOKEN, SEO_AGENT_CALLBACK_URL, SEO_AGENT_SETTINGS_KEY,
SITE_URL, OTEL_*). Secret fields are sealed with SEO_AGENT_SETTINGS_KEY (`admin_settings/secrets.py`).

Admin path shorthand: **S → x** = Admin → AI & SEO → Settings, section x (`/admin/automation?section=<id>`, section list
`src/app/admin/(growth)/automation/sections/index.ts:39-54`). Sections that render agent groups:
Agent limits (`agent-limits.tsx:14`, group `agent-limits`), ML & retrieval (`ml.tsx:17-18`, groups `retrieval`,
`embeddings`), MCP (`mcp.tsx:74`, group `mcp`, card "Server settings"). Group `knowledge-base` is rendered nowhere.
**Console** = `/admin/crewai/...` (CrewAI console).

Column "jithendar.com": `CM <value>` = ConfigMap literal; `Secret <name>/<key>`; `image` = Dockerfile ENV; `not set`;
`DB` = stored in the database (not in Git).

---

## 1. AI & LLM (providers, models, budget)

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| ANTHROPIC_API_KEY | Key for every Claude call; also the env fallback the Anthropic provider card reports | "" | secret | none for calls (a key saved in S → LLM providers is NOT used for calls) | env only | restart | `config.py:267`, `main.py:257`, `llm.py:610-615`; `llm_providers/catalog.py:54`, `store.py:211-218` | Secret seo-agent-env/ANTHROPIC_API_KEY |
| SEO_DRAFT_MODEL | Fallback model for crew agents without one, Ask answers, new-article writer, optimize draft, site-analysis report | claude-sonnet-5-5 | Claude model id | none in the agent (web S → AI & drafts `drafts.draftModel` only drives the web's own v2 drafting, `src/lib/seo-intel/settings.ts:461`) | job/brief model > crew version model > SEO_CREW_MODELS > crew default > this (`crews/common.py:323`) | restart | `config.py:268`; `crews/common.py:323`; `crews/editorial.py:509`; `flows/new_article.py:137`; `flows/optimize_article.py:138`; `services/ask_pipeline.py:321`; `crews/report.py:300` | CM claude-sonnet-5-5 (= default) |
| SEO_CLASSIFY_MODEL | Ask grading and follow-up condensing, weekly/monthly report narrative (analyst default), ML cluster labels | claude-haiku-5-5 | model id | none | env > default | restart | `config.py:269`; `ask_pipeline.py:275,309`; `crews/report.py:273`; `flows/ml.py:63` | CM claude-haiku-5-5 (= default) |
| SEO_CREW_MODELS | Per-agent model JSON `{"crew.agent":"claude-..."}`; malformed entries dropped | {} | JSON | none (Console → Crews agent "model" is the admin equivalent and wins) | crew version > this > crew default > SEO_DRAFT_MODEL | restart | `config.py:212-223,276`; `crews/common.py:323`; `editorial.py:509`; `new_article.py:137` | CM {"optimization.analyst":"claude-haiku-5-5","editorial.writer":"claude-opus-5-5","editorial.reviewer":"claude-opus-5-5"} |
| SEO_LLM_PRICES_JSON | Price override per model for cost booking and budget estimates (keys input, output, cacheRead, cacheWrite) | unset = built-in PRICES (`llm.py:36-41`), dated ids priced as family, unknown = claude-fable-5-1 prices | USD per million tokens | none | env > built-in (admin-entered model prices are NOT consulted) | read per call (env, so restart) | `llm.py:45-62` | not set |
| LLM budget `daily_usd` | The one daily limit: all spend in seo_llm_usage, every purpose/provider, UTC day; calls that could cross it are not sent | null = no limit | USD/day (0-100,000) | S → LLM providers & budget (`?section=llm#llm-budget`) | table | live: the saving pod at once, others within 30 s | `llm.py:340-356`; `llm_budgets.py:44-49,126-160`; `main.py:727-760` | DB `seo_agent_llm_budget` |
| LLM budget `monthly_usd` | Same, UTC month | null | USD/month | same | table | same | same | DB |
| Legacy per-model / per-provider limits | Pre-2026-11-21 limits, shown read-only, enforced by nothing | none | USD | shown in the LLM budget card | none | n/a | `llm_budgets.py:39,168-189` | DB `seo_agent_llm_budgets` (if present) |
| LLM provider rows: kind, name, enabled, base_url, region, deployment, api_version, key (sealed) | Providers an admin set up; Anthropic always listed | none saved | — | S → LLM providers & budget (`#llm-providers`) | saved key > env_key (ANTHROPIC_API_KEY, OPENAI_API_KEY) | **not read at call time** (`llm_providers/store.py:17-18`); used only for display and "Fetch models" | `llm_providers/store.py:43-56`; `discover.py:37-45`; `main.py:80,412,826` | DB `seo_agent_llm_providers` |
| LLM model rows: enabled, free, input/output/cache_read/cache_write USD, context_window, max_output, structured_output, tools, vision | Per-model switch and admin prices | off; prices null | USD per million tokens (0-10,000) | same card | table | **not read at call time**; costs use PRICES/SEO_LLM_PRICES_JSON; crew models are limited to PRICES keys (`crews/config.py:47,123-125`) | `store.py:57-75,189-209`; GET /llm-models `main.py:826` (only web consumer `src/components/seo/ModelPicker.tsx`, which no page imports) | DB `seo_agent_llm_models` |
| OPENAI_API_KEY | Env fallback key for an OpenAI provider row; OpenAI cover images | "" | secret | none | env | restart | `catalog.py:68`; `store.py:218`; `discover.py:45`; `news/desk.py:767` | not in seo-agent-env per `create-seo-agent-secrets.sh:6` (unverified live) |
| SEO_LLM_MONTHLY_BUDGET_USD | Nothing: replaced by the one budget (`llm.py:5-6`) | — | USD | — | — | — | **0 readers** in `seo-agent/app` and `src/` | CM "15" (dead) |
| FALLBACK_MODELS (code) | Models sent with the server-side refusal fallback beta | sonnet-5-5, opus-5-5, opus-5, fable-5-1 | — | none | code | — | `llm.py:580-581,628-631` | — |
| Anthropic SDK retries (code) | Retries per request; SEO_LLM_TIMEOUT_SECONDS is per attempt | 2 | retries | none | code | — | `llm.py:615` | — |
| HOLD_SECONDS (code) | A POST /llm-budget/reserve hold that is never settled lapses after | 900 | s | none | code | — | `llm.py:295,420` | — |

## 2. Crews & flows

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| CREW_MAX_ITER | Turns per crew agent when nothing more specific is set | 4 | turns (admin 1-20) | S → Agent limits "Turns per agent" | admin > env > default; per agent: crew version max_iter > SEO_CREW_MAX_ITERS > this (`crews/common.py:338`) | live | `config.py:274`; `crews/common.py:338` | CM "4" |
| SEO_CREW_MAX_ITERS | Per-agent turns JSON `{"crew.agent": n}` (1-20) | {} | turns | none (Console → Crews agent "iteration limit", 1-25, wins) | crew version > this > CREW_MAX_ITER | restart | `config.py:226-237,277`; `crews/common.py:338` | CM {"editorial.researcher":10,"editorial.writer":6,"editorial.reviewer":8} |
| SEO_AGENT_FANOUT_CONCURRENCY | Articles the weekly flow drafts at once (per pod) | 2 (min 1) | articles (admin 1-16) | S → Agent limits "Articles worked on at once" | admin > env > default | live | `config.py:279`; `flows/weekly.py:38` | CM "2" |
| SEO_AGENT_WEEKLY_MAX_ARTICLES | Articles per weekly run unless the run names a limit | 10 | articles (admin 1-25) | S → Agent limits "Articles per weekly run" | run input `limit` > admin > env > default | live | `config.py:280`; `flows/weekly.py:30` | CM "10" |
| SEO_AGENT_DOCS_ALLOWLIST | Documentation hosts (plus subdomains) crew agents may fetch; also Ask citation hosts and news researcher hosts | 45 built-in hosts (`config.py:28-74`) | host list | S → Agent limits "Documentation sites agents may read" | admin > env > built-in, **agent side only**: the web fetcher checks its own env/default list (`src/lib/seo-agent/config.ts:102-105`, `src/lib/seo-agent/callbacks.ts:340`) | live | `config.py:256,289`; `tools/__init__.py:62-67,244`; ToolContext in `crews/editorial.py:456`, `optimization.py:106`, `promotion.py:218,246`, `report.py:269,294`, `custom.py:257`; `news/desk.py:624`; `ask_pipeline.py:285` | not set (agent or web) |
| SCHEDULE_CATCHUP_MINUTES | How late a missed schedule or content-flow time still starts | 60 (clamp 2-1440) | minutes | S → Agent limits "Run a missed schedule up to" | admin > env > default | live | `config.py:316`; `main.py:542,552` | not set |
| Crew configuration versions (web table seo_crew_configs) | Per agent: role, goal, backstory, model (claude-* with a built-in price), max_tokens 256-64,000, max_iter 1-25, tools; per task: instructions, expected_output | code defaults | — | Console → Crews (`/admin/crewai/crews/<crew>`) | test-run override > active version > code (`crews/config.py:13-17`) | live (fetched before every crew run, 5 s timeout; outage = code defaults) | `crews/config.py:91-101,184,343`; `webapp.py:287-289` | jithendar.com `crewconfig/` restored on deploy (D-101) |
| Flow switches (web crewai_flows enabled + reason) | A switched-off flow is refused 409 at every kickoff (people, schedules, MCP, approvals) | on | bool | Console → Flows (`/admin/crewai/flows/<name>`) | web | live, cached 30 s per pod; outage keeps last answer | `flows/switches.py:23,36-59`; `webapp.py:295-297` | DB (crewconfig/flows: unverified whether `enabled` is in the bundle) |
| Flow schedules (web table seo_flow_schedules: enabled, cron, timezone, inputs, flow_name) | When a schedulable flow starts; claimed once per slot across pods | — | cron + tz | Console → Schedules (`/admin/crewai/schedules`) | rows | live (read on each dispatch tick) | `schedules.py:52-80`; `main.py:534-557` | crewconfig/schedules |
| Agent skills (web data, D-96) | Text added to agent system prompts | — | — | `/admin/automation/skills` (folder exists; label unverified) | web | live (before every crew run) | `webapp.py:283-285`; `crews/skills.py:38` (20,000 chars per agent) | crewconfig/skills |
| Custom crews and flows (web data) | Spec crews and step flows built in the console | — | — | Console → Crews/Flows → custom | web | live | `webapp.py` custom_crews/custom_flows; `crews/custom.py`; `flows/custom.py` | crewconfig/crews, flows |
| SEO scoring weights (`setting` row `seo`, key `weights`) | Weights of the recommendation priority model (seo_ml_flow) | DEFAULT_WEIGHTS (seo_ml) | relative | S → Scoring & rules | row > code defaults | live (per ML run) | `seo_ml/store.py:146-149` | DB |

## 3. Limits & timeouts

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| CREW_MAX_TOKENS_PER_RUN | A crew run stops incomplete after this many tokens | 150,000 | tokens (admin 1,000-10,000,000) | S → Agent limits "Tokens per crew run" | admin > env > default; content flows replace it with the job's budget.max_tokens_per_draft (`news/crew.py:125`) | live | `config.py:272`; `crews/common.py:446` | CM "300000" |
| CREW_MAX_RPM | Model requests per minute per crew (per pod) | 20 (min 1) | requests/min (admin 1-600) | S → Agent limits "Model requests per minute, per crew" | admin > env > default | live | `config.py:275`; `crews/common.py:339,351` | CM "20" |
| CREW_TIMEOUT_SECONDS | Crew wall clock; each agent gets half (min 30 s) | 600 | seconds, integer (admin 60-7200) | S → Agent limits "Crew run time limit" | admin > env > default | live | `config.py:273`; `crews/common.py:340,479-482` | CM "1200" |
| SEO_FLOW_TIMEOUT_SECONDS | Wall clock per flow run; also the default step timeout of custom step flows | 1800 (min 60) | seconds, integer (admin 60-86,400) | S → Agent limits "Flow run time limit" | admin > env > default | registry says restart (FlowRunner copies it, `main.py:278`) but `flows/custom.py:523` reads it live | `config.py:315`; `main.py:278`; `flows/custom.py:523` | CM "2700" |
| SEO_LLM_TIMEOUT_SECONDS | Anthropic request timeout per attempt (SDK retries twice) | 120 (clamp 30-900) | seconds, number (admin 30-900) | S → Agent limits "Model request time limit" | admin > env > default | restart | `config.py:278`; `main.py:257`; `llm.py:615` | CM "240" |
| CREW_LONG_OUTPUT_MAX_TOKENS | Output-token cap of writer, reviewer, editor agents | 16,000 (outside 1,024-64,000 = 16,000) | tokens | none (Console → Crews agent "output-token limit" wins) | crew version max_tokens > env > 16,000 | restart (env, read per crew build) | `crews/common.py:59-73,324` | not set |
| DEFAULT_MAX_TOKENS (code) | Output cap of other crew agents | 4096 | tokens | none (crew version max_tokens) | code | — | `crews/common.py:59,324` | — |
| Crew wait per model call (code) | The crew thread gives up on one model call after this, whatever SEO_LLM_TIMEOUT_SECONDS says | 300 | s | none | code | — | `crews/common.py:216` | — |
| Crew wait per tool call (code) | Same for one tool call | 60 | s | none | code | — | `crews/common.py:277` | — |
| Web callback client timeout (code) | Default per call to the web app's internal API (some calls pass 120) | 60 | s | none | code | — | `webapp.py:91,302` | — |
| Callback fetch timeouts (code) | Flow switches, crew configs, run-history switches | 5 | s | none | code | — | `flows/switches.py:24`; `crews/config.py:43`; `run_history.py:404` | — |

## 4. Retrieval & knowledge base

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| ASK_BLOG_TOP_K | Most passages retrieved per Ask question | 6 (clamp 1-12) | passages | S → ML & retrieval → Retrieval "Passages per answer" | admin > env > default | live | `config.py:291`; `services/ask_pipeline.py:298` | not set |
| ASK_BLOG_MIN_SCORE | Cosine floor for Ask passages | calibrated per embeddings model: 0.66 bge-small, 0.52 bge-m3 (`calibration.py:33,44`, interim); dataclass default 0.66 (`config.py:142`) | cosine (clamp 0-0.95) | Retrieval "Lowest similarity" | admin > env > calibrated | live | `config.py:260,292`; `ask_pipeline.py:296-298` | not set (CM comment 67-69: deliberately) → 0.52 with bge-m3 |
| RAG_RERANKER_ENABLED | Cross-encoder reorders passages that passed the floor | false | bool | Retrieval "Rerank passages" | admin > env > default | live (loads at start if on, else on first use) | `config.py:294`; `reranker.py:113`; `main.py:262-266` | CM "false" |
| RAG_RERANKER_CANDIDATES | How many retrieved passages the reranker reads | 0 = all (clamp 0-100) | passages | Retrieval "Passages the reranker reads" | admin > env > default | live | `config.py:297`; `reranker.py:120` | not set |
| RAG_RERANKER_TIMEOUT_MS | Search waits this long for the reranker | 0 = none (clamp 0-30,000) | **ms** | Retrieval "Reranker time limit" | admin > env > default | live | `config.py:298`; `reranker.py:163-166` | not set |
| RAG_RERANKER_MAX_CONCURRENT | Reranks at once; beyond it a search skips reranking (per pod) | 0 = none (clamp 0-64) | searches | Retrieval "Reranks at once" | admin > env > default | live | `config.py:299`; `reranker.py:156-158` | not set |
| RAG_RERANKER_THREADS | ONNX threads per rerank | 2 (clamp 1-16) | threads | Retrieval "Reranker CPU threads" | admin > env > default | restart | `config.py:296`; `reranker.py:131` | not set |
| RAG_RERANKER_DIR | Reranker model folder | "" (image: /models/ms-marco-MiniLM-L6-v2) | path | none (deliberately, `groups/retrieval.py:9-10`) | env | restart | `config.py:295`; `reranker.py:109` | image `Dockerfile:120` |
| RAG_MODE | Local pgvector retrieval: vector only or hybrid (RRF with full text) | vector (`retrieval.py:63`) | enum | none | env | restart (index built once, `index.py:228`) | `retrieval.py:50-52` | CM "vector" |
| RAG_CANDIDATES | Candidates per list | 20 (clamp 5-100) | chunks | none | env | restart | `retrieval.py:53` | not set |
| RAG_RRF_K | RRF constant | 60 (clamp 1-1000) | — | none | env | restart | `retrieval.py:54` | not set |
| RAG_IDENTIFIER_BOOST | Boost per exact identifier match | 1/61 (clamp 0-1) | score | none | env | restart | `retrieval.py:55` | not set |
| RAG_MAX_PER_ARTICLE | Diversification: chunks per article | 3 (0 = off; clamp 0-20) | chunks | none | env | restart | `retrieval.py:56` | CM "3" (= default) |
| RAG_CANNIBALIZATION_MIN_SIMILARITY | moks-rag cannibalization check: an article at least this similar to a new article's keyword is flagged | empty = not used (valid 0 < v <= 1) | cosine (admin 0.05-1) | group "Shared knowledge base" is registered (`groups/__init__.py:14`) but **no web page renders it**; README:256 points to a page that does not exist | admin > env > none | live | `config.py:323,335-341`; `main.py:720`; `flows/new_article.py:60` | not set → only keyword checks |
| Calibration constants (code) | Per-model cosine cutoffs: cluster_join, cluster_entity, dedupe_semantic, paragraph | bge-small / bge-m3 sets | cosine | none | code (news quality `max_paragraph_cosine` mapped when equal to bge-small's, `calibration.py:65`) | — | `calibration.py:33,44,58-65`; `news/desk.py:256-257` | — |
| RAG_EVAL_BLOG_DIR | Corpus folder of the rag_eval CLI | tests/fixtures/rag_corpus | path | none | env | per CLI run | `rag_eval.py:51` | not set (dev only) |

## 5. Embeddings

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| EMBEDDINGS_PROVIDER | onnx, ollama, api or hash | onnx | enum | none (deliberately, `groups/embeddings.py:3-7`) | env | restart; a model change builds seo_article_chunks_next | `config.py:257`; `embeddings.py:244-254` | CM "ollama" |
| EMBEDDINGS_MODEL_DIR | ONNX model folder | /models/bge-small-en-v1.5 | path | none | env | restart | `config.py:258`; `embeddings.py:247` | image `Dockerfile:120` (= default) |
| OLLAMA_URL | Ollama base URL | "" | URL | S → ML & retrieval → Embeddings "Ollama address" | admin > env > default | restart | `config.py:283`; `embeddings.py:249` | CM http://bge-m3.rag.svc.cluster.local:11434 |
| OLLAMA_EMBED_MODEL | Ollama model name:tag | nomic-embed-text | name | none (deliberately) | env | restart | `config.py:259`; `embeddings.py:249` | CM bge-m3:567m |
| OLLAMA_EMBED_DIM | Vector size for a model not in OLLAMA_MODELS | 0 = known size | dimensions | none | env | restart | `config.py:285`; `embeddings.py:152-155,249` | not set |
| EMBEDDINGS_TIMEOUT_SECONDS | Per Ollama request | 300 (clamp 10-1800) | seconds, number | Embeddings "Embeddings request time limit" | admin > env > default | restart | `config.py:286`; `embeddings.py:249` | not set |
| EMBEDDINGS_API_URL | HTTP embeddings API | "" | URL | Embeddings "Embeddings API address" | admin > env > default | restart | `config.py:287`; `embeddings.py:251` | not set |
| EMBEDDINGS_API_KEY | Key for that API | "" | secret (sealed) | Embeddings "Embeddings API key" (editable only with SEO_AGENT_SETTINGS_KEY) | admin (unsealed) > env | restart | `config.py:288`; `embeddings.py:251`; `admin_settings/store.py:154` | not set |
| Chunker constants (code) | TARGET_TOKENS 350, HARD_MAX_TOKENS 480, CODE_WINDOW_TOKENS 400, CHUNKER_VERSION tok-v1 | — | tokens | none | code | — | `embeddings.py:39-48` | — |

## 6. Ask the Blog

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| ASK_BLOG_ENABLED (agent) | Deployment gate for POST /ask and MCP ask_blog: false = off whatever is saved | false | bool | none | env AND admin `enabled` (`ask.py:156-161`) | restart | `config.py:271`; `main.py:282`; `ask.py:156-158` | CM "true" (the web container has its own ASK_BLOG_ENABLED "true") |
| ASK_BLOG_DAILY_BUDGET_USD | Ask's own daily cap (UTC); ceiling for the admin's daily budget; Ask also counts in the one LLM budget | 1.0 | USD/day | none (ceiling only) | min(env, admin dailyBudgetUsd) (`ask.py:150,163-166`) | restart | `config.py:270`; `main.py:254`; `llm.py:358-369`; `main.py:375` | CM "1" |
| ASK_BLOG_CACHE_TTL_SECONDS | Answer cache TTL when the admin set none (cache is per pod) | 900 | seconds | none (admin cacheTtlSeconds replaces it) | admin > env > default (`ask.py:164`) | restart (env) | `config.py:290`; `ask.py:152,164` | not set |
| ASK_BLOG_RETENTION_DAYS | Logged questions older than this are deleted (prune every 60 s, every pod) | 30 | days (admin 1-3650) | S → ML & retrieval → Retrieval "Keep questions for" | admin > env > default | live | `config.py:293`; `main.py:387-388` | not set |
| `ask_blog`.enabled | Admin switch | false (fail closed) | bool | S → Ask the Blog | AND with env | live, 30 s TTL per pod | `ask_runtime.py:72,95-114` | DB `setting` row ask_blog |
| `ask_blog`.audience | members or everyone; MCP ask_blog needs everyone | members | enum | S → Ask the Blog "Who can use it" | row | live | `ask_runtime.py:73`; `ask.py:168-171` | DB |
| `ask_blog`.dailyBudgetUsd | Admin daily budget (web form 0.05-50, web default 1) | agent: None = env value | USD/day | S → Ask the Blog "Daily budget (USD)" | capped at ASK_BLOG_DAILY_BUDGET_USD | live (applied at each question) | `ask_runtime.py:74`; `ask.py:166` | DB |
| `ask_blog`.cacheTtlSeconds | Reuse an answer for (0-86,400) | agent None; web default 900 | seconds | S → Ask the Blog "Reuse an answer for (seconds)" | over env | live | `ask_runtime.py:75`; `ask.py:164` | DB |
| `ask_blog`.answerLength | short, standard, detailed | standard | enum | S → Ask the Blog "Answer length" | row | live | `ask_runtime.py:76` | DB |
| `ask_blog`.fallbackMessage | Text when no article answers (200 chars) | "" = DEFAULT_FALLBACK | text | S → Ask the Blog "When no article answers the question" | row | live | `ask_runtime.py:77`; `ask_pipeline.py:98` | DB |
| `ask_blog`.conversation.followUps | Rewrite follow-ups with earlier turns | true | bool | S → Ask the Blog (conversation block) | row | live | `ask_runtime.py:68`; `ask.py:194-200` | DB |
| `ask_blog`.conversation.turns | Earlier turns sent (1-5) | 3 | turns | S → Ask the Blog "Earlier turns to send" | row | live | `ask_runtime.py:69` | DB |
| `ask_blog`.conversation.pageContext | Rank the open article higher (boost 0.05, code) | true | bool | S → Ask the Blog | row | live | `ask_runtime.py:70`; `ask_pipeline.py:40` | DB |
| `ask_blog`.conversation.feedback | Offer Helpful / Not helpful | true | bool | S → Ask the Blog | row | live | `ask_runtime.py:71`; `ask.py:205` | DB |
| Web-only Ask fields (limits.perMinute, perDay, maxQuestion, launcher, hideOn, button, placeholder, intro, disclaimer, examples, keepThread) | Enforced or shown by the web app only; the agent has its own MAX_QUESTION 500 (code) | web defaults | — | S → Ask the Blog | web | — | not read by the agent; `ask_pipeline.py:41` | DB |

## 7. MCP

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| PUBLIC_MCP_ENABLED | Public server on/off (404 while off) | false | bool | S → MCP → Server settings "Public MCP server" | admin > env > default | live | `config.py:304`; `mcp/__init__.py:126` | CM "false" |
| ADMIN_MCP_ENABLED | Admin server on/off | false | bool | S → MCP "Admin MCP server" | admin > env > default (an admin can switch it on over the CM's "false") | live | `config.py:305`; `mcp/__init__.py:126` | CM "false" |
| PUBLIC_MCP_RPM_PER_IP | Calls per minute per client IP (per pod) | 30 (min 1) | calls/min (admin 1-6000) | S → MCP "Public: calls per minute, per address" | admin > env > default | restart | `config.py:308`; `mcp/__init__.py:109`; `mcp/common.py:182` | CM "30" |
| PUBLIC_MCP_DAILY_CALLS | Global daily backstop (per pod) | 5000 | calls/day (admin 1-10,000,000) | S → MCP "Public: calls per day, all addresses" | admin > env > default | restart | `config.py:309`; `mcp/__init__.py:109` | CM "5000" |
| PUBLIC_MCP_DAILY_CALLS_PER_IP | Daily cap per client IP (per pod) | 500 (0 = off) | calls/day | none | env | restart | `mcp/__init__.py:32-43,109` | not set |
| ADMIN_MCP_RPM_PER_TOKEN | Calls per minute per token (per pod) | 120 (min 1) | calls/min (admin 1-6000) | S → MCP "Admin: calls per minute, per token" | admin > env > default | restart | `config.py:310`; `mcp/__init__.py:110` | CM "120" |
| ADMIN_MCP_KICKOFFS_PER_HOUR | Flow starts per hour, counted separately for kickoff_flow and run_content_flow (per pod) | 10 (min 1) | starts/hour (admin 1-1000) | S → MCP "Admin: flow starts per hour" | admin > env > default | restart | `config.py:311`; `mcp/__init__.py:110` | CM "10" |
| MCP_PUBLIC_TOOLS_OFF | Public tools refused | () | tool names | S → MCP "Public tools switched off" | admin > env | refusal live; tool list at restart | `config.py:313`; `mcp/__init__.py:109,112` | not set |
| MCP_ADMIN_TOOLS_OFF | Admin tools refused (old names mapped, `config.py:204-209`) | () | tool names | S → MCP "Admin tools switched off" | admin > env | same | `config.py:312`; `mcp/__init__.py:110,113` | not set |
| MCP_KICKOFFS_OFF | Flows that may not be started over MCP (narrows the code allowlist) | () | flow names | S → MCP "Flows that may not be started over MCP" | admin > env | live | `config.py:314`; `mcp/admin.py:213` | not set |
| MCP_ALLOWED_HOSTS | Host/Origin allowlist (DNS-rebinding protection) | jithendar.com, www.jithendar.com | hosts | S → MCP "Host names the servers answer to" | admin > env > default | restart | `config.py:307`; `mcp/__init__.py:48-54` | CM jithendar.com,www.jithendar.com |
| SEO_AGENT_EDGE_PORT | MCP listener port | 8090 | port | none | env | restart | `config.py:306`; `main.py:865` | CM "8090" (= containerPort agent-mcp) |
| Admin MCP resource / issuer (derived) | `{SITE_URL}/mcp/admin`, issuer SITE_URL | derived | URL | none | from SITE_URL | restart | `config.py:191-194`; `mcp/admin.py:68,81` | via SITE_URL |
| Extra allowed origins (code) | https://claude.ai, https://claude.com | — | — | none | code | — | `mcp/__init__.py:53` | — |

## 8. News desk (content flows)

Environment:

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| NEWS_DESK_ENABLED | "false" forces content flows off (emergency); "true" keeps them on until the admin first saves the switch | unset | bool | none | env false > admin switch > env true (`news/config.py:227-236`) | restart | `news/config.py:239-247,262`; `main.py:551`; `flows/news.py:175` | not set in CM (web container's own value: unverified) |
| NEWS_IMAGE_PROVIDER | Overrides the row's image_provider when template, gemini or openai | unset | enum | none; **overrides** S → AI & drafts "Cover image provider" | job image.provider / image profile > env > row (`news/config.py:255-257`, `news/desk.py:791`) | restart | `news/config.py:255-257` | CM "template" |
| NEWS_OPENAI_IMAGE_MODEL | OpenAI image model | gpt-image-1 | model | none | env | restart (env, read per call) | `news/desk.py:767` | CM gpt-image-1 |

`setting` row `news` (read on every content-flow run `flows/news.py:175` and dispatch `main.py:551`, so live).
Fields defined at `news/config.py:190-225`, web field map `src/lib/news/settings-fields.ts`:

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| enabled | Content flows on (admin switch) | None until saved | bool | Console → Flows → a content flow, "Content flows on" (JobsSwitch) | see NEWS_DESK_ENABLED | live | `news/config.py:253,262` | DB |
| paused | Earlier pause box, still honoured | false | bool | none | row | live | `news/config.py:197,235-236` | DB |
| llm_daily_usd / llm_monthly_usd | **Not read** (one LLM budget) | 2.0 / 20.0 | USD | none | — | — | `news/budget.py:3-6,56` | DB (dead) |
| image_daily_usd | Global cover-image cap per UTC day | 1.0 | USD/day | S → Agent limits → Content flow limits "Cover images per day (USD)" | row; job caps also apply | live | `news/budget.py:56,66-77` | DB |
| image_monthly_usd | Same per month | 10.0 | USD/month | same card "Cover images per month (USD)" | row | live | same | DB |
| max_drafts_per_day | Drafts per day, all content flows | 10 | drafts | same card "Drafts per day (all content flows)" | row | live | `news/desk.py:571` | DB |
| draft_concurrency | Drafts in parallel per run (per pod) | 2 (no bound in the agent; web hint 1-4) | drafts | same card "Drafts in parallel" | row | live | `flows/news.py:308` | DB |
| image_provider | Global cover provider | template | enum | S → AI & drafts → Content flow models "Cover image provider" | overridden by NEWS_IMAGE_PROVIDER | live | `news/desk.py:791` | DB |
| writer_model | Labelled "Writer model", but used only for the style-learning call and recorded as the draft's model; the crew writer uses job models > crew version > SEO_CREW_MODELS > writing profile > SEO_DRAFT_MODEL | claude-sonnet-5-5 | model | S → AI & drafts "Writer model" | row | live | `news/desk.py:735,1039`; crew: `news/crew.py:126`, `crews/common.py:323` | DB |
| fast_model | Topic classification fallback | claude-haiku-5-5 | model | S → AI & drafts "Fast model" | row | live | `news/desk.py:434` | DB |
| vision_model | Cover safety and alt text | claude-haiku-5-5 | model | S → AI & drafts "Vision model" | row | live | `news/desk.py:773` | DB |
| classifier_threshold | Below this the fast model is asked | 0.55 | probability | S → ML & retrieval → Content topics and ranking "Topic classifier confidence" | row | live | `news/desk.py:360-362` | DB |
| claude_topic_p | Probability recorded for a Claude-assigned topic | 0.6 (0-1) | probability | none | row | live | `news/desk.py:401-402` | DB |
| ranker_min_feedback | Review decisions before the ranker trains | 100 | decisions | S → ML & retrieval "Review decisions before the ranker trains" | row | live | `news/desk.py:947-948` | DB |
| explore_rate | Share of below-threshold candidates made eligible | 0.0 (0-0.2) | share | none | row | live | `news/desk.py:571` | DB |
| cve_roundup_max | Items naming more CVEs skip the shared-CVE cluster rule | 5 (1-100) | CVEs | none | row | live | `news/desk.py:257` | DB |
| near_dup_min_tokens | Shorter texts skip MinHash near-dedupe | 30 (0-500) | words | none | row | live | `news/desk.py:256` | DB |
| log_retention_days | Content-flow run logs kept | 90 | days | S → Run history "Keep content flow run logs (days)" | row | live | `flows/news.py:419` | DB |
| item_retention_days | Unused source items kept | 180 | days | AI & SEO → Content sources (`/admin/content/sources`) → Fetching | row | live | `flows/news.py:419` | DB |
| max_items_per_source | Items per source per fetch | 50 | items | Content sources → Fetching | row | live | `news/desk.py:118` | DB |
| paywalled_hosts | Never fetched (web fetcher enforces too) | [] | hosts | Content sources → Fetching | row | live | `news/desk.py:625` | DB |
| primary_source_hosts | Extra hosts the researcher may fetch | [] | hosts | Content sources → Fetching | row | live | `news/desk.py:624` | DB |
| image_prices | Price per generated image by provider | template 0, gemini 0.04, openai 0.04 | USD/image | none | row | live | `news/desk.py:763,799` | DB |
| quality.ngram | n of the n-gram overlap gate | 8 (5-15) | words | none | row; job quality overrides | live | `news/config.py:176`; `news/quality.py` | DB |
| quality.max_ngram_overlap, max_shared_run_words, max_paragraph_cosine, max_quote_words, min_analysis_share, readability_min, readability_max, title_max, max_internal_links | Quality gates (9 fields) | 0.12, 25, 0.93, 25, 0.25, 25, 75, 60, 3 | share / words / cosine / Flesch / chars / links | S → AI & drafts → Quality gates | row; job `quality` overrides per field | live | `news/config.py:172-187`; `news/quality.py:362-391` | DB |
| quality.meta_min, quality.meta_max | Meta description length gate | 110, 160 | chars | none | row; job overrides | live | `news/quality.py:391` | DB |

Per content flow (`news_jobs` row; edited at Console → Flows → Content flows `/admin/crewai/flows/content/<id>`; model
`news/config.py:57-169`; data rather than global settings, listed because each holds knobs):

| Field | Default | Unit / range | Note |
|---|---|---|---|
| enabled, cron, timezone | false, "0 7 * * *", Asia/Kolkata | — | dispatched by `news/dispatch.py` from the same tick as schedules |
| mode | single_stories | single_stories, daily_digest, both | |
| writing_profile_key, image_profile_key, review_priority | news-default, cover-template, 50 | — | profiles at `/admin/content/profiles` |
| config.source_ids, include/exclude_keywords, include/exclude_entities, topics | [] | lists | |
| config.max_articles_per_run / max_articles_per_day | 3 / 5 | 0-20 / 0-40 | |
| config.min_score | 0.45 | 0-1 | |
| config.dedupe_window_days | 7 | 1-60 days | |
| config.language, length_min_words, length_max_words | en, 350, 1200 | words | |
| config.author, default_categories, writing/image_profile_version | none | — | |
| config.models | {} | researcher, analyst, writer, fact_checker, seo_editor, art_director → claude-* | wins over every other model source (`crews/common.py:323`) |
| config.budget.llm_daily_usd / llm_monthly_usd | 1.0 / 15.0 | USD | **dead** (`news/budget.py:3-6,62`) |
| config.budget.image_daily_usd / image_monthly_usd | 0.5 / 5.0 | USD | per job, job time zone |
| config.budget.max_tokens_per_draft | 120,000 | 10,000-400,000 tokens | replaces CREW_MAX_TOKENS_PER_RUN for the news crew (`news/crew.py:125`, `news/desk.py:686`) |
| config.diversity.max_per_topic_per_day / max_per_source_per_day | 2 / 2 | 1-20 | |
| config.image.enabled / provider / variants | true / profile's / none | 1-4 | provider wins over NEWS_IMAGE_PROVIDER |
| config.digest_size | 5 | 2-12 | |
| config.recency_half_life_hours / max_age_hours | 36 / 96 | **hours** | |
| config.weights | {} over DEFAULT_WEIGHTS | 9 features, 0-1 | `news/config.py:19-29` |
| config.expiry_days, publishing_slots, notify | none, [], true | days, HH:MM | |
| config.output, intake, quality | news, [sources], {} | — | |

## 9. Reports

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| Weekly/monthly narrative model (derived) | Report crew analyst model when the crew version names none | SEO_CLASSIFY_MODEL | model | Console → Crews → report, agent "analyst" | crew version > SEO_CREW_MODELS > SEO_CLASSIFY_MODEL | live via crew version | `crews/report.py:142,273` | via CM SEO_CLASSIFY_MODEL |
| Console site-analysis model (derived) | site_analyst model | SEO_DRAFT_MODEL | model | Console → Crews → report, agent "site_analyst" | crew version > SEO_CREW_MODELS > SEO_DRAFT_MODEL | live | `crews/report.py:300` | via CM SEO_DRAFT_MODEL |
| Report crew configuration | Agents analyst, site_analyst; their tasks | code | — | Console → Crews → report | as section 2 | live | `crews/report.py:269,293`; `crews/config.py:343` | crewconfig/ |
| Web report delivery settings (`seo` settings `reports.attachMaxMb`, `linkHours`, `keepDays`) | Email attachments, link lifetime, console report retention | web defaults | MB / hours / days | S → Reports | web | — | **not read by the agent** (it hands the PDF to the web: `webapp.py:59,63`) | DB |

## 10. Integrations (moks-rag, web app link)

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| SEO_AGENT_TOKEN | Bearer the web app and the dispatcher send to the internal API (32+ chars in production) | "" | secret | none (NEVER) | env | restart | `config.py:264`; `main.py:475,858`; `trigger.py:39` | Secret seo-agent-env/SEO_AGENT_TOKEN (copy in jithendar-com-env; must match) |
| SEO_AGENT_CALLBACK_TOKEN | Bearer the agent sends to the web callback API (32+ chars) | "" | secret | none (NEVER) | env | restart | `config.py:265`; `main.py:255,858` | Secret seo-agent-env/SEO_AGENT_CALLBACK_TOKEN (copy in jithendar-com-env) |
| SEO_AGENT_CALLBACK_URL | Web callback base (+ /internal/seo-agent) | http://jithendar-com-internal.jithendar:9465 | URL | none (NEVER) | env | restart | `config.py:109,266`; `main.py:255`; `webapp.py:91-93` | CM http://127.0.0.1:9465 |
| SEO_AGENT_URL (trigger) | Where `python -m app.trigger dispatch` posts /schedules/dispatch | http://seo-agent.jithendar:8080 | URL | none | env (dispatcher CronJob) | per run | `trigger.py:38` | `seo-agent-60-dispatcher.yaml:55` (Service → any site pod) |
| RAG_API_URL | moks-rag rag-api; moks-rag is off unless URL and token are both set | "" | URL | none (deliberately, `groups/knowledge_base.py:7-8`) | env | restart | `config.py:187-189,317`; `moks_rag.py:118-126`; client built `main.py:276` | Secret seo-agent-rag/RAG_API_URL (optional) |
| RAG_BEARER_TOKEN | Agent's rag-api token | "" | secret | none | env | restart | `config.py:318`; `moks_rag.py:122` | Secret seo-agent-rag/RAG_BEARER_TOKEN (optional) |
| RAG_SEO_COLLECTION | Collection the agent writes | seo_intel | name | none | env | restart | `config.py:319,327-332`; `moks_rag.py:123`; `main.py:690-691` | CM seo_intel (= default) |
| RAG_CMS_COLLECTION | Collection the agent reads (web articles) | cms_content | name | none | env | restart | `config.py:320`; `moks_rag.py:124` | CM cms_content (= default; web uses RAG_COLLECTION) |
| RAG_TIMEOUT_SECONDS | moks-rag ingest per attempt | 120 (clamp 5-600) | seconds, number | group knowledge-base "Upload time limit" (unit "s"), **not rendered** | admin > env > default | restart | `config.py:321`; `moks_rag.py:125` | not set |
| RAG_QUERY_TIMEOUT_SECONDS | moks-rag query per attempt | 20 (clamp 2-120) | seconds, number | group knowledge-base "Search time limit", **not rendered** | admin > env > default | restart | `config.py:322`; `moks_rag.py:126` | not set |
| moks-rag service name (code) | Name sent to rag-api | moks-seo-agent | — | none | code | — | `moks_rag.py:49` | — (web uses RAG_SERVICE_NAME=moks-cms) |

## 11. Runtime & observability

| Name/key | What | Default | Unit | Admin path | Precedence | Live/restart | Read by | jithendar.com |
|---|---|---|---|---|---|---|---|---|
| APP_ENV | "production" enables the 32-character token check | "" | — | none | env > image | restart | `config.py:300`; `main.py:858` | CM production; image `Dockerfile:117` |
| DATABASE_URL | Shared Postgres via PgBouncer (session) | "" | URL (secret) | none (NEVER) | SEO_AGENT_DATABASE_URL wins when set | restart | `config.py:263`; `main.py:239-241,278` | Secret postgres-db-credentials/uri |
| SEO_AGENT_DATABASE_URL | The agent's own narrower role | "" | URL (secret) | none (NEVER) | over DATABASE_URL | restart | `config.py:263` | Secret seo-agent-db-credentials/uri (optional) |
| SEO_AGENT_SETTINGS_KEY | Seals secret admin settings and provider keys (AES-256-GCM, 32+ chars) | unset = secret fields read-only | secret | none (NEVER) | env | restart | `admin_settings/secrets.py:22-38`; `store.py:196,261` | **not** written by `create-seo-agent-secrets.sh` (unverified live) |
| SITE_URL | Canonical site: MCP issuer/resource, site paths for moks-rag and seo_intel | https://jithendar.com | URL | none (NEVER) | env > default | restart | `config.py:303`; `mcp/public.py:27`; `mcp/admin.py:68`; `site_context.py:69-132`; `seo_intel.py:109-186`; `main.py:713,720`; `flows/seo_intel.py:43` | CM https://jithendar.com (web container sets the same) |
| PORT | Internal API port | 8080 | port | none | env | restart | `main.py:863` | not set (image sets none on purpose, `Dockerfile:112-113`) |
| LOG_LEVEL | Python log level | INFO | — | none | env | restart | `logs.py:61` | CM INFO (web container: info) |
| OTEL_EXPORTER_OTLP_ENDPOINT | OTLP endpoint; empty = tracing off | "" | URL | none (NEVER) | env | restart | `config.py:301`; `main.py:451,860` | CM http://otel-collector.observability:4318 |
| OTEL_SERVICE_NAME | service.name of spans | seo-agent | — | none (NEVER) | env | restart | `config.py:302`; `tracing.py:25` | CM seo-agent (web: jithendar-com) |
| GIT_SHA | Version on /healthz and spans | dev | — | none | image | restart | `main.py:104` | image (build arg) |
| CREWAI_DISABLE_TELEMETRY, CREWAI_DISABLE_TRACKING, CREWAI_TRACING_ENABLED, CREWAI_DISABLE_VERSION_CHECK | CrewAI telemetry off | true, true, false, true (setdefault) | bool | none | env > setdefault | import | `config.py:18-25` | image `Dockerfile:122` |
| CREWAI_STORAGE_DIR | CrewAI local storage (nothing should write) | /tmp/crewai | path | none | env > setdefault | import | `config.py:23` | CM /tmp/crewai; image `Dockerfile:123` |
| OMP_NUM_THREADS, RAYON_NUM_THREADS, TOKENIZERS_PARALLELISM, MALLOC_ARENA_MAX, HOME/XDG_* | Library thread and memory limits, writable /tmp | 2, 1, false, 2, /tmp | — | none | image | restart | libraries (not app code) | image `Dockerfile:117-121` |
| Run history switches (`seo` settings runHistory.transcripts, logs, stepIo) | Whether model-call transcripts, structured run logs, step I/O are recorded | on | bool | S → Run history | web (served at /internal/seo-agent/run-history/settings) | live, fetched at most once a minute per pod | `run_history.py:69,397-409`; `webapp.py:291-293` | DB |
| Admin settings refresh (code) | Period at which every pod re-reads seo_agent_settings | 30 | s | none | code | — | `admin_settings/store.py:38`; `main.py:394-403` | — |
| DB pool sizes (code) | async 1-6, sync (CrewAI persistence) 1-2, per pod | — | connections | none | code | — | `main.py:239-241` | — |

---

## Flags

### F1. Two places for one knob: 17 ConfigMap keys are also admin settings, and the admin wins
`admin_settings/store.py:5` and `overlay` (`store.py:145-157`): saved value > env > default. Keys set in CM and also
registered: CREW_MAX_ITER "4", CREW_MAX_RPM "20", CREW_MAX_TOKENS_PER_RUN "300000", CREW_TIMEOUT_SECONDS "1200",
SEO_FLOW_TIMEOUT_SECONDS "2700", SEO_LLM_TIMEOUT_SECONDS "240", SEO_AGENT_FANOUT_CONCURRENCY "2",
SEO_AGENT_WEEKLY_MAX_ARTICLES "10" (`groups/agent_limits.py`), OLLAMA_URL (`groups/embeddings.py:23`),
RAG_RERANKER_ENABLED "false" (`groups/retrieval.py:35-41`), PUBLIC_MCP_ENABLED "false", PUBLIC_MCP_RPM_PER_IP "30",
PUBLIC_MCP_DAILY_CALLS "5000", ADMIN_MCP_ENABLED "false", ADMIN_MCP_RPM_PER_TOKEN "120", ADMIN_MCP_KICKOFFS_PER_HOUR
"10", MCP_ALLOWED_HOSTS (`groups/mcp.py:25-34`). After a save the CM value is only the "if cleared" fallback.
**Inconsistent precedence model:** for these the env is a soft default, but ASK_BLOG_ENABLED=false (`ask.py:156-158`),
NEWS_DESK_ENABLED=false (`news/config.py:232-233`) and ASK_BLOG_DAILY_BUDGET_USD (ceiling, `ask.py:166`) are hard
deployment gates. The CM comment "the admin server only after the OAuth flow is verified" (CM:77) reads like a gate,
but the admin switch overrides ADMIN_MCP_ENABLED=false.

### F2. Documentation allowlist: the admin field can narrow but not widen
The agent checks its own list (`tools/__init__.py:244`, admin field `groups/agent_limits.py:110-118`), but every fetch
goes through the web app's fetcher, which checks the web container's own SEO_AGENT_DOCS_ALLOWLIST or its copy of the
default list (`src/lib/seo-agent/config.ts:43,102-105`, `src/lib/seo-agent/callbacks.ts:340`, also news
`src/lib/news/callbacks.ts:76`). A host added in S → Agent limits passes the agent and is refused by the web. The
default list is also kept in two files by hand (`config.py:27` "Keep equal to moks-cms/src/lib/seo-agent/config.ts").

### F3. Group "Shared knowledge base" has no admin page
Registered (`groups/__init__.py:14`, `groups/knowledge_base.py`), editable through PUT /admin-settings/knowledge-base,
but only agent-limits, mcp, retrieval and embeddings are rendered (`agent-limits.tsx:14`, `mcp.tsx:74`,
`ml.tsx:17-18`; no `knowledge-base` string in `src/`). README:256 names "Admin → Settings → Shared knowledge base".
So RAG_CANNIBALIZATION_MIN_SIMILARITY (semantic cannibalization, off), RAG_TIMEOUT_SECONDS and
RAG_QUERY_TIMEOUT_SECONDS have no UI.

### F4. NEWS_IMAGE_PROVIDER=template silently overrides the admin's cover provider
`news/config.py:255-257` puts the env value over the row's `image_provider`. The web shows an override hint only from
its own process env (`src/app/admin/(growth)/automation/sections/seo-ai.tsx:11-15`), and the `web` container does not
get `seo-agent-config` (`30-jithendar-com.yaml:160-164`), so an admin choosing Gemini sees no warning and still gets
template (unless jithendar-com-public also sets it: unverified). Per-flow `config.image.provider` and the image
profile still win (`news/desk.py:791`).

### F5. Dead keys and dead fields
- CM `SEO_LLM_MONTHLY_BUDGET_USD: "15"` (CM:30): no reader in `seo-agent/app` or `src/`; `llm.py:5-6` says it is gone.
  The CM comment "keep equal to the site's SEO_LLM_MONTHLY_BUDGET_USD" is stale.
- `news` row `llm_daily_usd`/`llm_monthly_usd` and per-flow `config.budget.llm_daily_usd`/`llm_monthly_usd`: stored,
  validated, never enforced (`news/budget.py:3-6,56,62`).
- `news` row `paused`: legacy, still honoured (`news/config.py:197,235`), no UI.
- Legacy table `seo_agent_llm_budgets`: read-only (`llm_budgets.py:39`).

### F6. Ask the Blog money: three layers, and the admin's number is silently capped
1) ASK_BLOG_DAILY_BUDGET_USD "1" (CM:31) is the ceiling captured at start (`ask.py:150`); 2) the admin's
"Daily budget (USD)" accepts 0.05-50 (`src/lib/seo-agent/ask-settings.ts:90`) but `min(ceiling, saved)` applies
(`ask.py:166`), so anything above 1 does nothing and the form only hints at it; 3) Ask spend also counts in the one LLM
budget (`llm.py:358-369`). ASK_BLOG_DAILY_BUDGET_USD=0 blocks every question (`llm.py:367`). Cache TTL is likewise in
two places (ASK_BLOG_CACHE_TTL_SECONDS vs `cacheTtlSeconds`, `ask.py:164`).

### F7. Models: five sources, and the provider/model tables are not used for calls
Model for a crew agent = per-flow job models > crew version (console) > SEO_CREW_MODELS (CM) > crew/profile default >
SEO_DRAFT_MODEL (CM) (`crews/common.py:323`). Separately: the web's S → AI & drafts `drafts.draftModel` and its own
SEO_DRAFT_MODEL env drive only the web's v2 drafting (`src/lib/seo-intel/settings.ts:461`); the news row's "Writer
model" is used only for the style-learning call and is written onto the draft as its model even when the crew used
another (`news/desk.py:735,1039`). The LLM providers/models tables are "not read at call time" (`llm_providers/store.py:17-18`):
a model switched off there still runs, a key saved there is unused (`main.py:257` uses ANTHROPIC_API_KEY), admin
prices are ignored by costing (`llm.py:45-62`) although the catalog says "an admin may override them per model"
(`catalog.py:57`), crew models are limited to the built-in PRICES list (`crews/config.py:123-125`), and the only picker
reading GET /llm-models (`ModelPicker.tsx`) is used by no page.

### F8. Timeouts that do not compose
- S → Agent limits allows "Model request time limit" up to 900 s (`groups/agent_limits.py:69-79`), but a crew waits at
  most 300 s for one model call (`crews/common.py:216`), and the SDK retries twice per attempt timeout (`llm.py:615`),
  so the real wait is up to 3x the setting outside crews and capped at 300 s inside them.
- CREW_TIMEOUT_SECONDS (up to 7200) may exceed SEO_FLOW_TIMEOUT_SECONDS (down to 60): no cross-check. The CM sizes
  flow = 2 x crew + retry by hand (CM:53).
- SEO_FLOW_TIMEOUT_SECONDS is "restart" in the registry (`groups/agent_limits.py:64`) but `flows/custom.py:523` reads
  it live, so step flows and the runner disagree until a restart.

### F9. Per-process state now that every site pod runs an agent (KEDA 2-8, `35-autoscaling.yaml:30,34`)
- MCP limits are in-memory per pod (`mcp/common.py:46-49,182`): PUBLIC_MCP_DAILY_CALLS 5000 becomes up to 40,000/day,
  per-IP rpm/day, admin rpm and kickoffs/hour are all multiplied by the pod count (Kong → Service seo-agent-mcp).
- Budget reservations are per pod (`llm.py:312-317,336-337`); documented overshoot of N-1 in-flight estimates. Ask's
  pending spend and its effective cap (`guard.ask_daily_usd` is rewritten on each question, `ask.py:163-166`) are per
  pod; the gauge reads it (`main.py:375`).
- Ask answer cache is per pod (`ask.py:103,152`): hit rate drops with more pods.
- RAG_RERANKER_MAX_CONCURRENT is per pod (`reranker.py:156-158`); reindex lock is an asyncio.Lock per pod
  (`main.py:173,183`).
- A save applies at once only on the pod that served the admin request (the web calls 127.0.0.1:8080,
  `30-jithendar-com.yaml` SEO_AGENT_URL); others follow within TTLs of 30 s (admin settings `store.py:38`, LLM budget
  `llm_budgets.py:127`, Ask options `ask_runtime.py:96`, flow switches `flows/switches.py:23`) or 60 s (run history
  `run_history.py:69`).
- "Restart pending" is computed against the answering pod only (`store.py:224`); a KEDA scale-up starts pods with the
  new values while older pods keep the old ones, so pods can run different timeouts, MCP limits or embeddings settings.
- DB-derived gauges are set by every pod (`main.py:367-389`): sum() over pods multiplies them (dashboards unverified);
  the Ask log prune runs in every pod every 60 s.
- DB pools 6 + 2 per pod (`main.py:239-241`): up to 64 agent connections at 8 pods (PgBouncer limit unverified).
- SEO_AGENT_FANOUT_CONCURRENCY, `draft_concurrency` and CREW_MAX_RPM are per pod, not global.

### F10. Same names as the web container
They are separate containers, so no runtime clash today, but the same names carry separate values from separate
sources: ASK_BLOG_ENABLED (two independent gates, both "true"), APP_ENV (both production, plus image ENV), SITE_URL,
LOG_LEVEL (info vs INFO), OTEL_SERVICE_NAME (jithendar-com vs seo-agent), OTEL_EXPORTER_OTLP_ENDPOINT,
DATABASE_URL, RAG_API_URL (web literal vs agent Secret), RAG_BEARER_TOKEN (Secret jithendar-com-rag/token vs
seo-agent-rag/RAG_BEARER_TOKEN), RAG_COLLECTION vs RAG_CMS_COLLECTION, SEO_DRAFT_MODEL/SEO_CLASSIFY_MODEL,
NEWS_DESK_ENABLED, NEWS_IMAGE_PROVIDER, SEO_AGENT_DOCS_ALLOWLIST, ANTHROPIC_API_KEY, SEO_AGENT_TOKEN and
SEO_AGENT_CALLBACK_TOKEN (two Secrets that must match). PORT is safe only because neither container nor the image
sets it (`Dockerfile:112-113`): the agent defaults to 8080, Next to 3000.

### F11. Mixed units and naming
Seconds as integer (CREW_TIMEOUT_SECONDS, SEO_FLOW_TIMEOUT_SECONDS, ASK_BLOG_CACHE_TTL_SECONDS) and as number
(SEO_LLM_TIMEOUT_SECONDS, EMBEDDINGS_TIMEOUT_SECONDS, RAG_TIMEOUT_SECONDS, RAG_QUERY_TIMEOUT_SECONDS); milliseconds
(RAG_RERANKER_TIMEOUT_MS; web GEMINI_IMAGE_TIMEOUT_MS); minutes (SCHEDULE_CATCHUP_MINUTES); hours (job recency and
max age); days. Unit label "s" (`groups/knowledge_base.py:29-30`) vs "seconds" elsewhere. Money: USD/day, USD/month,
USD per image, USD per million tokens; SEO_LLM_PRICES_JSON uses cacheRead/cacheWrite (`llm.py:55-56`) while PRICES
uses cache_read/cache_write (`llm.py:36-41`). Prefixes: RAG_* covers both local pgvector retrieval (RAG_MODE,
RAG_CANDIDATES, RAG_RERANKER_*) and the moks-rag service (RAG_API_URL, RAG_*_COLLECTION, RAG_TIMEOUT_SECONDS); Ask
knobs live in Retrieval (ASK_BLOG_TOP_K, MIN_SCORE, RETENTION_DAYS) and in Ask the Blog.

### F12. No admin UI where one looks expected
SEO_CREW_MODELS, SEO_CREW_MAX_ITERS, CREW_LONG_OUTPUT_MAX_TOKENS (all duplicate per-agent console fields; candidates
to drop from the CM); RAG_MODE and the fusion knobs; PUBLIC_MCP_DAILY_CALLS_PER_IP (its siblings are in the MCP
group); SEO_LLM_PRICES_JSON (vs model prices in Providers); the knowledge-base group (F3); news row fields
claude_topic_p, explore_rate, cve_roundup_max, near_dup_min_tokens, image_prices, quality.ngram, quality.meta_min,
quality.meta_max; hard-coded 300 s model-call wait, 60 s tool wait, 60 s callback timeout.

### F13. Wrong "default" shown for Lowest similarity
The UI's default is the dataclass value 0.66 (`store.py:186-190,222`), while the effective default with bge-m3 is the
calibrated 0.52 (`config.py:260`, `calibration.py:44`). Once an admin saves a value, the "applies when cleared" text
uses `f.deployment ?? f.default` (`src/components/seo/AgentSettingsGroup.tsx:64`) and shows 0.66.

### F14. Secrets and deployment hygiene
- SEO_AGENT_SETTINGS_KEY is not written by `create-seo-agent-secrets.sh` (keys: ANTHROPIC_API_KEY, SEO_AGENT_TOKEN,
  SEO_AGENT_CALLBACK_TOKEN, `:6,28`), so secret settings and provider keys are read-only unless it was added by hand
  (unverified live). OPENAI_API_KEY likewise.
- Both scripts tell you to restart `deploy/seo-agent` (`create-seo-agent-secrets.sh:37`, `create-seo-agent-rag-secret.sh:41`),
  which is at 0 replicas; the agent now restarts with `deploy/jithendar-com`.
- `seo-agent-40-seo-agent.yaml` is not in `kubernetes/kustomization.yaml` resources and is applied by a person
  (header :9), so live CM values may differ from Git (unverified).
- Stale admin paths in CM comments: "Admin → Automation & AI → Ask the Blog" (CM:33), "Admin → Newsroom → Settings"
  (CM:87), "Admin → Retrieval → Lowest similarity" (CM:69).
- The CM file says bge-m3's NetworkPolicy admits `app=seo-agent` (`seo-agent-40-seo-agent.yaml:218-219`), but the
  agent now runs in pods labelled `app: jithendar-com` (unverified: that policy is in the moks-rag repo).
- Admin settings, the LLM budget and provider tables are not part of crewconfig GitOps (`crewconfig/` has no such
  folder; unverified against the bundle code).

### F15. Clamp gaps outside the admin ranges
`_int`/`_float` turn negatives into the default but accept 0 (`config.py:86-99`): CREW_MAX_ITER=0 or
CREW_TIMEOUT_SECONDS=0 from the environment pass (`config.py:273-274`); only the admin ranges forbid them. The news
row's `draft_concurrency` has no bound in the agent model (`news/config.py:220`); the web hint says 1-4.

---

## Counts per category (rows in the tables above)

| Category | Rows |
|---|---|
| AI & LLM | 15 |
| Crews & flows | 12 |
| Limits & timeouts | 11 |
| Retrieval & knowledge base | 16 |
| Embeddings | 9 |
| Ask the Blog | 15 |
| MCP | 14 |
| News desk | 3 env + 26 row + 20 per-flow = 49 |
| Reports | 4 |
| Integrations | 11 |
| Runtime & observability | 16 |
| Total | 172 |

Rows sometimes group several keys (for example the 9 quality gates, or the 4 CREWAI_* flags), so the number of
individual knobs is higher than the row count. 35 rows are admin-registry fields (agent-limits 10, embeddings 4,
retrieval 8, mcp 10, knowledge-base 3); the rest are env-only settings, agent-owned tables, web-owned rows the agent
reads, and code constants, which are listed only where they limit or contradict a setting.
