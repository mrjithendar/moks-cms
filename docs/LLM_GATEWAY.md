# LiteLLM: the only LLM gateway

Every chat-model call moks-cms makes goes to one LiteLLM proxy (D-110, since 2026-11-28). LiteLLM is the single source of
truth for providers, models, provider API keys, routing, fallbacks and budgets. moks-cms knows an endpoint, its virtual
keys and alias names, nothing else. It never calls Anthropic, OpenAI, Gemini, Bedrock, Ollama or Perplexity for a chat
model, and it keeps no price table and no budget of its own.

## The two clients

| Runtime | Client | Calls |
|---|---|---|
| Web app | `src/lib/llm/client.ts` | SEO drafts and keyword intents (`src/lib/seo-intel/model-calls.ts`), SEO enrichment (`seo-intel/llm.ts`), AI visibility (`seo-intel/ai-visibility.ts`), the Python practice tutor (`practice/ai/tutor.ts`) |
| SEO agent | `seo-agent/app/llm_gateway.py` | every flow, crew, content flow, report, and Ask the Blog |

Both speak LiteLLM's OpenAI-compatible Chat Completions API, because an alias may point at any provider and that is
the shape LiteLLM translates for all of them. Both clients provide:

- system blocks, with the stable ones marked for prompt caching (`cache_control`);
- structured output (`response_format` `json_schema`, or `json_object`), validated by the caller;
- tool calling;
- web search (`web_search_options`);
- streaming;
- timeouts, and retries with backoff on 408, 409, 429, 5xx and lost connections (honouring `Retry-After`);
- one error type with a code:
  - `not_configured`;
  - `budget` (HTTP 422 `budget_exceeded`, for the key or for its team);
  - `model_access` (the key may not use the alias, or LiteLLM has no such alias);
  - `auth`, `rate_limited`, `timeout`, `unavailable`, `bad_request`, `bad_response`, `refusal`.

Keys never reach a message, a log line, an error or the browser. LiteLLM's own auth errors are redacted before they go
anywhere.

## Configuration: environment only

| Variable | Where | Meaning |
|---|---|---|
| `LITELLM_BASE_URL` | both containers | LiteLLM's API, e.g. `http://litellm.rag.svc.cluster.local:4000/v1` |
| `LITELLM_API_KEY` | Secret `jithendar-com-env` (web), `seo-agent-env` (agent) | the caller's virtual key |
| `LITELLM_PRACTICE_API_KEY` | `jithendar-com-env` | the tutor's own key and budget (the web key when unset) |
| `LITELLM_ASK_API_KEY` | `seo-agent-env` | Ask the Blog's own key and budget, since readers can start it (the agent key when unset) |
| `LITELLM_MODEL` | both | the default alias: drafting, crews. Default `moks-cms-default` |
| `LITELLM_MODEL_FAST` | both | the fast alias: classifying, enrichment, Ask the Blog. Default `moks-cms-fast` |
| `LITELLM_MODEL_PRACTICE` | web | the tutor's alias. Default: the fast alias |
| `LITELLM_TIMEOUT_MS` | web | per attempt; default 120 s |
| `LITELLM_UI_URL` | web | LiteLLM's Admin UI, for links only (`https://jithendar.com/llm/ui`) |

Without `LITELLM_BASE_URL` and `LITELLM_API_KEY` no model is called. Drafting, enrichment, AI visibility and the tutor
say what to set, flows fail with `not_configured`, and the rule-based parts of the site keep working. There is no
fallback to a provider.

Removed (D-110):

- `ANTHROPIC_API_KEY` and `PERPLEXITY_API_KEY`;
- `SEO_DRAFT_MODEL` and `SEO_CLASSIFY_MODEL`;
- `SEO_LLM_MONTHLY_BUDGET_USD`, `SEO_LLM_PRICES_JSON` and `ASK_BLOG_DAILY_BUDGET_USD`;
- `LITELLM_MODEL_DEFAULT`, renamed `LITELLM_MODEL`.

`GEMINI_API_KEY` and `OPENAI_API_KEY` stay only for image and video generation (below).

## Models: aliases

Nothing creates a model in LiteLLM automatically (owner's rule, moks-rag README): every alias is added by hand in
LiteLLM's Admin UI, under Models + Endpoints → Add Model, with the alias as the *Public Model Name*. A call to an alias
LiteLLM does not have fails with "Invalid model name". The names moks-cms asks for:

| Alias | Points at (suggested) | Used by |
|---|---|---|
| `moks-cms-default` | Claude Sonnet | drafts, crews, content flow writers |
| `moks-cms-fast` | Claude Haiku | intents, enrichment, Ask the Blog, the tutor, content flow classification |
| `moks-cms-quality` | Claude Opus | what jithendar.com's `SEO_CREW_MODELS` gives the editorial writer and reviewer, and every stored Opus id (migration 0045) |
| `moks-cms-visibility-claude` and the other AI visibility aliases | below | AI visibility, only for the assistants switched on |

Add each alias to the team `jithendar.com`'s models too (if the team has a model list).

To change what an alias answers with, edit it in LiteLLM: https://jithendar.com/llm/ui → Models + Endpoints → the model
→ Edit Settings. It takes effect at once, without a deploy.

- Crews, crew agents, content flows and writing profiles can name any alias. The admin pickers list the aliases LiteLLM
  lists for the SEO agent's key.
- `SEO_CREW_MODELS` (agent) maps `crew.agent` to an alias.
- Migration 0045 turned every stored Claude id into an alias: Haiku → `moks-cms-fast`, Opus → `moks-cms-quality`, any
  other Claude id → `moks-cms-default`.

### AI visibility

AI visibility measures how each AI assistant answers. So each assistant has its own alias, pointing at that
assistant's model with web search: Settings → AI & drafts → AI visibility → aliases. An empty alias means that
assistant is not asked.

| Assistant | Alias (default) | The alias must point at |
|---|---|---|
| Claude | `moks-cms-visibility-claude` | an Anthropic model (LiteLLM turns `web_search_options` into Anthropic's web search tool) |
| ChatGPT | `moks-cms-visibility-chatgpt` | an OpenAI search model (e.g. a `-search` model) |
| Perplexity | `moks-cms-visibility-perplexity` | a Perplexity Sonar model |
| Gemini | `moks-cms-visibility-gemini` | a Gemini model (Google Search grounding) |

Add the provider's key to LiteLLM (Models + Endpoints → add the model with its key), never to moks-cms. The sources are
read from what LiteLLM returns for each provider:

- OpenAI-style `annotations`;
- Anthropic's citations and web search results in `provider_specific_fields`;
- Perplexity's `search_results` and `citations`;
- Gemini's grounding chunks.

Google AI Overview is read through DataForSEO's SERP API, which is not a model call.

## Budgets: LiteLLM's

- **Team** `jithendar.com`: one budget for all the site's keys together, e.g. per 30 days.
- **Each key**: its own budget and reset, e.g. Ask the Blog per day and the tutor per day, plus rate limits (RPM/TPM).

Set both in LiteLLM (Teams, Virtual Keys). Nothing is preset: an empty budget is no limit.

When a budget is used up, LiteLLM refuses the call with HTTP 422 `budget_exceeded`:

- a flow run pauses (`paused_budget`);
- an AI visibility run stops (`partial`, error code `budget`);
- a draft is marked as paused;
- Ask the Blog answers that it is unavailable;
- the tutor says it reached its budget;
- the AI & SEO admin pages show a banner.

What moks-cms still limits, because these are not money: the tutor's requests per person per day, the enrichment's
requests per day, and the content flows' image caps (images are not LiteLLM calls).

**Spend records.** Every call writes a `seo_llm_usage` row (provider `litellm`) with what LiteLLM charged
(`x-litellm-response-cost`; 0 when it does not say, as on streams). The CrewAI console's cost per run and per draft
comes from these rows. They are a record, not a limit, and LiteLLM's own spend logs are the source of truth. Calls carry
`metadata.tags` (`moks-cms`, `purpose:<what>`), so LiteLLM's logs can be filtered by purpose.

## The admin page

Settings → AI & models → LiteLLM, read only:

- for the web app and for the SEO agent: connected or not, the endpoint, the aliases they ask for, and the last health
  check (an authenticated `GET /v1/models`), with any alias LiteLLM does not list for the key;
- the team's and each key's spend, budget and reset, read with the keys themselves;
- the aliases the keys may use, and what each points at;
- a link to LiteLLM's Admin UI. LiteLLM's master key is never used or shown by moks-cms.

The admin's health checks have a "LiteLLM (LLM gateway)" line (group SEO & AI): not configured, down, degraded when an
alias is missing for the key, or ok with the latency.

## Not through LiteLLM

These are not chat-model calls. They stay as they are (D-110), each behind its own settings and caps:

- **Image generation**: Gemini (`src/lib/gemini.ts`, `GEMINI_API_KEY` or the key saved under Settings → AI & models →
  Image generation), and the news desk's OpenAI image provider (`seo-agent/app/news/images.py`, `OPENAI_API_KEY` in
  `seo-agent-env`).
- **Video generation**: Veo (`src/lib/video-generation.ts`).
- **Embeddings**: bge-m3 through Ollama in namespace `rag`, and the ONNX models.

Moving images to LiteLLM's `/images/generations` is possible later; it is not part of D-110.

## Turning it on (jithendar.com)

1. **LiteLLM (moks-rag)**: add the aliases above by hand in the Admin UI. Then `scripts/issue-litellm-keys.sh` creates
   the team and the keys (with no budget) and writes them into Secrets `jithendar-com-env` and `seo-agent-env`. It never
   prints them.
2. **Release this version**, then restart `deploy/jithendar-com`. Released without the keys, the site makes no model
   calls until they are set.
3. **jithendar.com manifests**: `LITELLM_BASE_URL` on both containers, the NetworkPolicy to `rag/litellm:4000`,
   `SEO_CREW_MODELS` with aliases, and no budget or model variables.
4. **Set the budgets** in LiteLLM: the team's, and Ask the Blog's key at least.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "LiteLLM is not configured: set LITELLM_BASE_URL and LITELLM_API_KEY" | The Secret has no `LITELLM_API_KEY`, or the container has no `LITELLM_BASE_URL`. |
| Flow runs `paused_budget` "LiteLLM refused the call: the budget of … is used up" | A key's or the team's budget in LiteLLM: raise it or wait for its reset. |
| `LiteLLM: The requested model '…' is not available for this API key (HTTP 403 key_model_access_denied)` | Add the alias to the key's models in LiteLLM, or fix the alias a crew, flow or profile names. |
| `LiteLLM: Invalid model name passed in model=…` | LiteLLM has no such alias: create it (Models + Endpoints) or fix the name. |
| `LiteLLM could not be reached.` | The NetworkPolicy (jithendar → rag/litellm:4000), LiteLLM's pods, or `LITELLM_BASE_URL`. |
| The LiteLLM page says LiteLLM does not list an alias for the key | The alias is missing in LiteLLM, or the key's model list leaves it out. |
| An AI visibility assistant answers with no sources | Its alias points at a model without web search. |
