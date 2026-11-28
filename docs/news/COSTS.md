# News desk costs

**Estimates.** The crews ran only against a deterministic test model in this work; no live model call was made, so the
token counts below are estimated from the prompt sizes, not measured. Replace them with real numbers from the run detail
(`news_runs.tokens`, `cost_usd`) after the first week. Every call goes through LiteLLM (D-110, [LLM_GATEWAY.md](../LLM_GATEWAY.md)),
and the cost booked to a run is what LiteLLM charged; moks-cms keeps no price table. The figures assume the aliases point
at Claude, at the list prices of 2026-10: `cms-claude-sonnet-latest` at Sonnet 5.5 ($2 / $10 per million input/output tokens),
`ops-claude-haiku-latest` at Haiku 5.5 ($0.10 / $0.50). What an alias points at is set in LiteLLM's Admin UI.

## Per draft (single story, default settings)

| Step | Alias | Input tokens | Output tokens | Cost |
|---|---|---|---|---|
| Researcher (2–3 calls incl. tool results; up to 12 items × 3,000 chars + one primary source) | `cms-claude-sonnet-latest` | ~30,000 | ~2,000 | $0.080 |
| Analyst | `cms-claude-sonnet-latest` | ~8,000 | ~1,000 | $0.026 |
| Writer | `cms-claude-sonnet-latest` | ~10,000 | ~2,000 | $0.040 |
| Fact-checker | `cms-claude-sonnet-latest` | ~10,000 | ~2,000 | $0.040 |
| SEO editor | `cms-claude-sonnet-latest` | ~12,000 | ~2,500 | $0.049 |
| Art director | `cms-claude-sonnet-latest` | ~4,000 | ~300 | $0.011 |
| Vision: safety per variant + alt text on the final image | the vision model (empty: `cms-claude-sonnet-latest`) | ~4,000 each | ~200 | ~$0.01 each (~$0.001 on a Haiku-priced alias) |
| **Crew total** | | **~75,000** | **~10,000** | **≈ $0.25** (+ ≈ $0.03 for the vision checks on `cms-claude-sonnet-latest`) |

Cached system blocks (the rules + each agent's prompt) bring the input part down somewhat after the first call in a
5-minute window. A per-draft token cap (`max_tokens_per_draft`, default 120,000) bounds the worst case at ≈ $0.35.

Covers: template $0. Gemini or OpenAI: 2 variants × the configured price (default estimate $0.04) = $0.08 + the vision checks.

Classification fallback (the fast model, empty: `ops-claude-haiku-latest`; 20 stories per call): < $0.001 per story. It runs
during ingest and its cost is booked to the job or ingest run that ingested; when LiteLLM refuses the call (a budget is
used up) the model's low-confidence guess is kept (`model_low_conf`). Bootstrap (one-off, up to 1,000 items):
≈ $0.10–0.30. Style review (weekly, `cms-claude-sonnet-latest`, ≤ 12 diffs): ≈ $0.05–0.10. Training: CPU only, free.

## Per approved article

Not every draft is approved. Assuming 15 % fail the quality gates (they still cost a crew run) and 60 % of the rest are
approved:

| Covers | Cost per draft | Cost per approved article |
|---|---|---|
| template | ≈ $0.25 | ≈ $0.25 / (0.85 × 0.6) ≈ **$0.49** |
| Gemini/OpenAI (2 variants) | ≈ $0.33 | ≈ **$0.65** |

The analytics page shows the real figure ("cost per approved article", including rejected and failed drafts).

## Per day and month at the defaults

One content flow, daily, `max_articles_per_run` 3: ≈ 3 × $0.25 ≈ **$0.75/day**, ≈ $23/month if it found 3 stories every day.

**LLM spend has no news cap** (D-110). Every news call goes through LiteLLM with the SEO agent's key, so the agent key's
budget and the team's budget in LiteLLM limit it, together with everything else the agent does
([LLM_GATEWAY.md](../LLM_GATEWAY.md)). When LiteLLM refuses a call (HTTP 422 `budget_exceeded`), the run ends as
**paused (budget)**. The run detail and the analytics page still show the LLM spend per run, day and month, without a
cap. The content flows' former `llm_daily_usd` / `llm_monthly_usd` caps are gone (migration 0045 removed them from
saved rows).

What the news desk still limits itself:

| Cap | Default | Effect |
|---|---|---|
| content flow images per day / month | $0.50 / $5.00 | only matters with a paid provider |
| global images per day / month | $1.00 / $10.00 | all content flows together |
| global drafts per day | 10 | |
| tokens per draft (`max_tokens_per_draft`) | 120,000 | ends the crew early, marked incomplete |

Images are not LiteLLM calls. When an image cap would be crossed, nothing is sent, and the run ends as **paused
(budget)** with the cap named.

Levers: fewer articles per run/day, a cheaper alias (e.g. `ops-claude-haiku-latest`) for the researcher/analyst (content flow →
Writing → models per agent), fewer items per story, a lower token cap, template covers.
