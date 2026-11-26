# AI visibility: are AI assistants citing the site?

Readers increasingly ask an assistant instead of a search engine. AI visibility tracks, for a list of questions
("prompts"), whether ChatGPT, Claude, Perplexity, Gemini and Google's AI Overview cite this site as a source or name it
in the answer, week by week. The idea comes from open-seo (github.com/every-app/open-seo, MIT). Here it runs on the
site's own keys and budget, and it feeds the editorial calendar.

Code: `src/lib/seo-intel/ai-visibility.ts`. Tables: migration `0031_seo_ai_visibility.sql`. Page: Admin → AI visibility.
Settings: Settings → AI & drafts → AI visibility.

## How it works

- **Prompts** (`seo_ai_prompts`): added by hand, or "Add 10 from Search Console", which takes question-like queries
  (how/what/why/which/…, "vs", "alternatives") with impressions in the last 90 days. Prompts can be paused or removed.
- **Weekly job `ai_visibility`** (web worker, `weekday` / `hourUtc` in Settings; Run now on the page): each active
  prompt (at most `maxPrompts`) goes to each assistant that is both switched on and configured, in parallel per prompt.
  An answer already collected today is not bought again.
- **Per answer** (`seo_ai_answers`, one row per prompt, assistant and day): the text (first 8,000 characters), the
  sources in the order given, `cited` (a source is on this host or a subdomain) with `cited_rank`, `mentioned` (the
  site name, host or a `brandNames` entry appears as a whole word), cost and any error.
- **Page**: cited share per assistant with a weekly trend, the prompt × assistant grid, "Not cited anywhere" (answered
  by at least one assistant, cited by none) with **Send to editorial calendar**, and the domains cited instead.

| Assistant | API | Key (Secret `jithendar-com-env`) | Sources are | Cost counted |
|---|---|---|---|---|
| Claude | Anthropic Messages API, web search tool (`web_search_20260209`, ≤ 5 searches), server-side refusal fallback | `ANTHROPIC_API_KEY` (already used for drafts) | the answer's citations; the search results when it cites none | exact: token usage at list price (`claude.ts`) + $0.01 per search |
| ChatGPT | OpenAI Responses API with the `web_search` tool | `OPENAI_API_KEY` + `models.chatgpt` | `url_citation` annotations | `costPerAnswerUsd` (estimate) |
| Perplexity | Sonar chat completions | `PERPLEXITY_API_KEY` | `search_results` (or `citations`) | `costPerAnswerUsd` (estimate) |
| Gemini | Gemini API with Google Search grounding | `GEMINI_API_KEY` + `models.gemini` | grounding chunks (domain from the chunk title; the URI is a Google redirect) | `costPerAnswerUsd` (estimate) |
| Google AI Overview | DataForSEO SERP `organic/live/advanced` with `load_async_ai_overview` | `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | the overview's references | DataForSEO's returned cost |

No model is guessed for ChatGPT or Gemini: each stays "not ready" until its model id is set. Claude defaults to
`claude-opus-5-5`; a cheaper model can be set in `models.claude`.

## Limits worth knowing

- These are **API answers**. chatgpt.com, claude.ai and perplexity.ai can answer differently (other models, memory,
  location, personalisation). Compare the same prompts over time; don't read a single week as what every reader sees.
- A Google query with no AI Overview is stored as `no_ai_overview` and left out of the rates, not counted as "not cited".
- Answers are third-party text: the page shows them as plain text and links sources with `rel="nofollow noopener"`.
  Nothing from an answer is published or fed to the drafting crews automatically; "Send to editorial calendar" creates
  a calendar idea from the prompt, which a person approves as usual.

## Cost control

AI visibility has no limit of its own: it counts against the one LLM budget (Admin → Settings → AI & models → LLM
providers & budget), like every other LLM call. Before each call the job holds an upper estimate against that budget (Claude: 60k
input + 4k output tokens at the model's price + 5 searches; the others: `costPerAnswerUsd`; AI Overview: $0.01) and
stops at the first call that does not fit (the run ends `partial`). Each answer's cost is also written to
`seo_llm_usage` with purpose `ai_visibility`, which is what the budget adds up. `maxPrompts` still bounds a run. Rough size: 25 prompts ×
Claude Opus 5.5 ≈ $1–2 a week; Haiku 5.5 is far cheaper if that is good enough for the trend.

## Setup (a person)

1. Keys: `ANTHROPIC_API_KEY` is normally set already. For the others, `KUBE_CONTEXT=<name> scripts/set-ai-visibility-config.sh`
   merges `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` and/or `GEMINI_API_KEY` into Secret `jithendar-com-env` (each optional).
   Google AI Overview reuses the DataForSEO credentials ([DATAFORSEO.md](DATAFORSEO.md)). Restart the site.
2. Settings → AI & drafts → AI visibility: tick **Enabled** and each assistant, set the ChatGPT/Gemini model ids, the cap
   and `costPerAnswerUsd`.
3. Admin → AI visibility: add prompts (or take them from Search Console), then **Run now**.

Rollback: untick Enabled. Tables are dropped only by the manual `src/db/rollback/0031_seo_ai_visibility.down.sql`.
