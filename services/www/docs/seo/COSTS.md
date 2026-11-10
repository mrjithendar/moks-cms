# SEO v3 LLM costs (estimate)

These are estimates, not measured bills: no live Claude call was made during the build. The inputs below are
measured. Every real call writes a `seo_llm_usage` row (tokens, cache tokens, cost, model, purpose), so the actual
numbers are on Settings → Drafts and in the *SEO agents* dashboard after the first week.

## Assumptions

- **Prices** (USD per million tokens, the same table in `claude.ts` and `seo-agent/app/llm.py`): Sonnet 5.5 $2 in /
  $10 out, cache read $0.20, cache write $2.50; Haiku 5.5 $0.10 / $0.50. You can override them with
  `SEO_LLM_PRICES_JSON`.
- **Tokens ≈ characters ÷ 3.5**, the same estimator the budget guard uses (deliberately pessimistic for English prose).
- **Corpus** (measured 2026-11-10): 37 blog articles, with bodies of median 24,570 characters, mean 34,338 and max
  101,165; plus 2 news articles and 3 projects.
- **Cached prefix** (draft rules + style guide): 6,448 characters ≈ 1,842 tokens. It's above Sonnet's minimum
  cacheable size, so after the first call in a 5-minute window it's billed at the cache-read rate.

## Per run type

| Run | Model calls | Tokens (typical) | Cost (typical) | Cost (worst case) |
|---|---|---|---|---|
| `optimize_article` | 1 Sonnet call (+1 on a validation retry, assumed for 20 % of runs) | in ~9,000 (median article; 12,200 mean) + 1,842 cached; out ~1,200 | **$0.03–0.04** | ~$0.21 (101k-character article, full 4,096-token output, retry) |
| `regenerate` (reviewer feedback) | 1 Sonnet call | as above | $0.03–0.04 | ~$0.11 |
| `internal_linking` | none (deterministic planner + pgvector) | 0 | $0 | $0 |
| `weekly_recommendations` (N = 10) | N × `optimize_article` | | **$0.35–0.45 per week** | ~$2.10 |
| `new_article` (editorial crew) | 4 agents, ~12 ReAct calls in total; the transcript grows with tool results | in ~91k, out ~13.5k (≈ 105k, under the 150k cap) | **$0.25–0.45** | ~$0.45 per crew run at the cap; ×2 with a validation retry |
| Ask the Blog, answered | 1 Haiku grade + 1 Sonnet answer | grade in ~1,250 / out 60; answer in ~3,000 / out ~250 | **$0.009** | $0.012 |
| Ask the Blog, fallback | 1 Haiku grade | | $0.0002 | |
| Ask the Blog, cached or refused | none | 0 | $0 | $0 |
| Embeddings (ONNX, in-cluster) | none | | $0 | $0 |

Crew breakdown (input tokens): researcher ~25k (three tool results re-sent as the transcript grows), writer ~12k,
reviewer ~18k, SEO editor ~36k (it receives all prior task output as context). Output: ~1.5k + 3.5k + 4k + 4.5k.

## Monthly estimate for the current site

| Activity (assumption) | Monthly |
|---|---|
| Weekly optimisation, 10 articles × 4.3 weeks | $1.50–2.00 |
| Manual "Draft/Fix with Claude" + keyword actions (10) and regenerations (5) | $0.45–0.60 |
| New articles from the editorial crew (4) | $1.00–1.80 |
| **Admin total (v2 + v3 share this budget)** | **≈ $3–4.5** (default cap $10) |
| Ask the Blog (separate daily cap): 20 questions/day, 60 % answered, 15 % cache hits | ≈ $2.80 |
| Ask the Blog, ceiling | ≤ 31 × $1 = $31 (only if the daily cap is hit every day) |

With `SEO_ORCHESTRATOR=legacy`, weekly drafting goes through Message Batches at half price (−$0.75–1.00 a month). v3
graph nodes need their answer inline, so they use the synchronous API with prompt caching (D-46).

## Budget controls

1. **Admin budget:** `SEO_LLM_MONTHLY_BUDGET_USD` (default $10). It's one cap for v2 and v3, computed from
   `seo_llm_usage` plus in-flight batches, excluding Ask the Blog. Before every call, an upper-bound estimate is
   checked; a call that could cross the cap is **never sent**. The graph then ends in `paused_budget`, the draft shows
   "Paused", and the v2 banner appears on every SEO page.
2. **Ask the Blog:** `ASK_BLOG_DAILY_BUDGET_USD` (default $1). This is separate: public spend never pauses drafting.
   Above it, the assistant answers "resting for today".
3. **Per crew run:** `CREW_MAX_TOKENS_PER_RUN` (150k), checked before each call; `CREW_TIMEOUT_SECONDS` (600);
   `CREW_MAX_ITER` (4) per agent. Hitting any of them gives a partial draft marked incomplete.
4. **Per call:** `maxOutputTokens` from Settings → Drafts (4,096) for optimisation; 700 for answers, 200 for grades.
5. **Alerts:** `SeoLlmBudget80` (≥ 80 %) and `SeoLlmBudgetReached` (100 %), from `seo_llm_budget_used_ratio`.
6. **Kill switches:** `SEO_ORCHESTRATOR=legacy` and `ASK_BLOG_ENABLED=false`.
