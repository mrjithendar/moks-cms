# SEO LLM costs (estimate; v4 crews, v5 budget and ML)

These are estimates, not measured bills: no live Claude call was made during the build (no API key here). The inputs
are the v3 measurements (corpus, prompt sizes) plus the v4 crew structure. Every real call writes a `seo_llm_usage`
row (tokens, cache tokens, cost, model, purpose), so actual numbers appear on Settings → Drafts, in MCP
`get_llm_usage`, and in the *SEO agents* dashboard after the first week.

## Assumptions

- **Prices** (USD per million tokens; `claude.ts` and `seo-agent/app/llm.py`): Sonnet 5.5 $2 in / $10 out, cache read
  $0.20, cache write $2.50; Haiku 5.5 $0.10 / $0.50. Override with `SEO_LLM_PRICES_JSON`.
- **Tokens ≈ characters ÷ 3.5** (the budget guard's deliberately pessimistic estimator).
- **Corpus** (measured 2026-11-10): 37 blog articles, median body 24,570 characters (≈ 7,000 tokens), mean 34,338, max
  101,165.
- **Crews** use the ReAct text protocol: each agent call re-sends its task, context from earlier tasks, and the tool
  results so far. The stable prefix (system prompt) is cached; the task context mostly isn't.
- `SEO_CREW_MODELS` default: `optimization.analyst` on Haiku; everything else on `SEO_DRAFT_MODEL` (Sonnet), the report
  writer on `SEO_CLASSIFY_MODEL` (Haiku).

## Per flow

| Flow | Model calls | Tokens (typical) | Cost (typical) | Worst case |
|---|---|---|---|---|
| `optimize_article_flow` (Optimization Crew) | analyst ~2 (Haiku), editor ~2, reviewer ~2 (Sonnet); +1 crew run on a validation retry (assumed 20 %) | analyst in ~7k / out ~0.6k; editor in ~30k (article + rules + style guide, twice) / out ~2.5k; reviewer in ~15k / out ~2k | **$0.12–0.15** (v3 single call: $0.03–0.04) | ~$0.45 (101k-character article, retry); hard cap 150k tokens per crew run ≈ $0.45 |
| regenerate (reviewer feedback) | one crew run | as above | $0.10–0.13 | ~$0.30 |
| `new_article_flow` (Editorial Crew, prompt `seo-crew-v4`) | researcher ≤ 10 turns and SEO editor on Sonnet; writer and technical reviewer on Opus | estimate, not yet measured: Sonnet in ~105k / out ~5k; Opus in ~65k / out ~13k | **≈ $0.60–1.00 (estimate)**; was $0.25–0.45 on Sonnet with 4 turns | hard cap 300k tokens per crew run; ×2 with a retry. Replace the estimate with `seo_llm_usage` numbers after the first runs |
| `report_flow` (Report Crew, Haiku) | 1–2 calls | in ~3k, out ~0.4k | **< $0.001** | $0.002 |
| `weekly_recommendations_flow` (N = 10) | N × optimize | | **$1.20–1.50 per week** | ~$4.50 |
| `gsc/ga4_sync`, `tech_audit`, `internal_linking`, `reindex`, `ask_gaps` | none (data steps, deterministic planner, ONNX) | 0 | $0 | $0 |
| `publish_flow` | none | 0 | $0 | $0 |
| Ask the Blog, answered (widget or MCP `ask_blog`) | Haiku grade + Sonnet answer | grade ~1.25k in; answer ~3k in / ~0.25k out | **$0.009** | $0.012 |
| Ask the Blog, fallback / cached / refused | Haiku grade / none | | $0.0002 / $0 | |
| MCP read tools | none | 0 | $0 | $0 |

Optimization Crew breakdown (input tokens, median article): the editor dominates (~60 %) because it receives the
article blocks, the v2 rules and the style guide on each of its turns. Putting the editor on Haiku would cut the run to
~$0.03, at a quality cost not measured here; put the reviewer on Haiku first if needed
(`{"optimization.analyst":"claude-haiku-5-5","optimization.reviewer":"claude-haiku-5-5"}` ≈ −25 %).

## Monthly estimate for the current site

| Activity (assumption) | Monthly |
|---|---|
| Weekly optimisation, 10 articles × 4.3 weeks | $5.20–6.50 |
| Manual "Draft/Fix with Claude", keyword actions and MCP kickoffs (10) + regenerations (5) | $1.70–2.10 |
| New articles from the Editorial Crew (4) | $2.40–4.00 (estimate, see above) |
| Reports (4 weekly + 1 monthly) | < $0.01 |
| **Admin total (v2 legacy path and v4 flows share this budget)** | **≈ $9.50–12.50** against the default **$15** cap (v5; was $10) |
| Ask the Blog (separate daily cap): 20 questions/day, 60 % answered, 15 % cache hits | ≈ $2.80 |
| Ask the Blog ceiling | ≤ 31 × $1 = $31 (only if the daily cap is hit every day) |

**The v4 crews cost about 3–4× v3's single-call drafting.** With the old $10 cap the estimate ($8–10.5) left no headroom,
so **v5 raised the default to $15** (web `DEFAULT_MONTHLY_BUDGET_USD`, agent `Settings.monthly_budget_usd`, the
`seo-agent-config` ConfigMap); the estimate now uses 53–70 % of it, and `SeoLlmBudget80` fires at $12. The guard still
pauses runs (`paused_budget`, banner, alert at 80 %) rather than overspend. To spend less: lower `SEO_AGENT_WEEKLY_MAX_ARTICLES` to 5 (−$3); move the reviewer to Haiku (−25 %
per draft). v3's graph path had used ~$3–4.5 a month.

## Budget controls

> **Since the admin settings plan (P2 part A, 2026-11-21):** there is one LLM budget, a daily and/or monthly limit set
> in Admin → AI & SEO → Settings → LLM budget and kept by the seo-agent. No limit exists until an admin saves one.
> `SEO_LLM_MONTHLY_BUDGET_USD`, the `drafts.monthlyBudgetUsd` setting and AI visibility's own cap are gone; this web
> app's own calls and AI visibility hold their upper bound against the one budget (`src/lib/seo-intel/llm-gate.ts`).
> Items 1 and the per-model limits below describe how it worked before and are kept for history.

1. **Admin budget:** `SEO_LLM_MONTHLY_BUDGET_USD` (default $15 since v5; $10 before): one cap for the v2 legacy path and every v4 flow,
   computed from `seo_llm_usage` (+ in-flight legacy batches), excluding Ask the Blog. Before every call an upper-bound
   estimate is checked; a call that could cross the cap is **never sent**. The flow ends `paused_budget`, the draft shows
   "Paused", every SEO admin page shows the banner, and MCP `kickoff_flow` refuses drafting/report flows.
2. **Ask the Blog:** `ASK_BLOG_DAILY_BUDGET_USD` (default $1), separate (public spend never pauses drafting). The public
   MCP `ask_blog` counts against it too.
3. **Per crew run:** `CREW_MAX_TOKENS_PER_RUN` (300k), `CREW_TIMEOUT_SECONDS` (1200), `CREW_MAX_ITER` (4; per agent
   `SEO_CREW_MAX_ITERS`), `CREW_MAX_RPM` (20). Hitting one gives a partial result marked incomplete.
4. **Per flow run:** `SEO_FLOW_TIMEOUT_SECONDS` (2700); one active run per flow + target; weekly fan-out ≤ 2 at once.
5. **MCP:** `kickoff_flow` ≤ 10 per hour per client; per-token and per-IP limits; Kong limits.
6. **Alerts:** `SeoLlmBudget80` (≥ 80 %) and `SeoLlmBudgetReached` (100 %).
7. **Kill switches:** `SEO_ORCHESTRATOR=legacy`, `ASK_BLOG_ENABLED=false`, `PUBLIC_MCP_ENABLED=false`,
   `ADMIN_MCP_ENABLED=false`, and suspending the CronJobs.
8. **LLM budgets (per model and per provider):** owned by the **seo-agent**, which makes the platform's LLM calls
   (`moks-seo-agent/app/llm_budgets.py`, its own table `seo_agent_llm_budgets`). An optional daily and monthly limit
   for each model, and for each provider (all of its models together, e.g. the credit on the Anthropic account).
   Empty = no limit; nothing is preset. The agent checks them before every call, for every purpose (drafts, flows,
   Ask the Blog, the news desk), counting all of `seo_llm_usage` (this app's own few Claude calls included) plus legacy
   batches in flight, by UTC day and month, as Anthropic's spend limits; the caps above still apply on top. Admin →
   Automation & AI → **LLM budgets** only shows and edits them through the agent's `GET`/`PUT /llm-budgets`
   (`src/lib/llm-budgets-view.ts`, `src/lib/seo-agent/client.ts`); nothing is stored here, and the card cannot change
   them while the agent is unreachable. This app's own Claude calls (keyword intent labelling, the legacy draft path)
   are counted by the agent but not stopped by these limits; their cap is item 1. AI visibility answers are recorded in
   `seo_ai_answers` and stay under their own monthly cap only. Setting the provider's monthly limit to the spend limit
   of this site's workspace in the Claude Console keeps the site from ever reaching Anthropic's hard stop.

## Where the money goes: Settings → Claude usage → "By flow" (v5)

The usage card now splits the month by flow, from `seo_flow_runs.cost_usd` (every run's measured model cost). News flows
(own caps) and Ask the Blog (own daily cap, no flow) are not in it; **Outside flows** is the rest of the admin month in
`seo_llm_usage` (the v2 legacy path, keyword intent labelling, recommendation explanations). Expect
`optimize_article_flow` to dominate (≈ 60–70 % of the estimate above). These are measured numbers once runs exist;
the table is empty until then.

## v5: ML and RAG costs

| Item | Model calls | Cost |
|---|---|---|
| `seo_ml_flow` weekly training (decay, clusters, intent, priority, related, live RAG eval) | none: CPU in the seo-agent pod | $0 |
| Cluster label suggestions ("Ask Claude for suggestions", once per 200-query sample) | 1 Haiku call (~2.5k tokens in, ~3k out) | < $0.002 per sample |
| Ask the Blog, ask-blog-v3 | the answer prompt has only the excerpts the grader kept (often 2–3 of 6) | answer input ≈ −40–60 % when the grader is selective; **estimate**, measured per question in `seo_ask_log` from the first week |
| Intent labelling with the distilled classifier | Haiku only for queries below the classifier's confidence threshold | see below |

**Intent savings (estimate):** Haiku labels new queries in batches of 100 (~1.5k tokens in, ~1.2k out per batch, about
$0.0008). At this site's volume (a few hundred new queries a month) that is **under $0.01 a month**, so the classifier
saves cents, not dollars. It mainly removes a dependency on the API for a routine step. The Models page reports the
measured share of queries answered without Claude once the classifier is active (`share_confident` on held-out
queries; `byModel` in the keyword refresh result).
