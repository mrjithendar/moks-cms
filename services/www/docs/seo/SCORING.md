# Recommendation scoring

Code: `src/lib/seo-intel/scoring.ts` (formula), `src/lib/seo-intel/rules.ts` (inputs per rule).
Tests: `tests/seo-intel-recs.test.ts` ("scoring", "rules (fixed fixtures)").

## Formula

Each rule produces up to six inputs, each normalised to **0–1**:

| Input | Default weight | Meaning |
|---|---|---|
| `searchOpportunity` | 30 | How much search demand is involved |
| `rankingOpportunity` | 20 | How close the page is to a better result |
| `relevance` | 20 | How directly the site's own content is concerned |
| `qualityGap` | 15 | How far the current state is from good |
| `trend` | 10 | Size of a decline |
| `effort` | 5 | Ease of the fix (1 = cheap, e.g. a title rewrite; 0 = a new article) |

```
score = Σ wᵢ·xᵢ / Σ wᵢ      over the inputs the rule could compute
```

**Missing inputs** (no data for them, e.g. no trend for a low-CTR finding) are excluded and the remaining weights
are renormalised. The recommendation stores `used`, `missing`, `renormalized: true` and the weights in effect, and
the UI shows them under "Evidence and score inputs".

**Bands:** `high` ≥ 0.66, `medium` ≥ 0.40, else `low` (Settings → thresholds `bandHigh`, `bandMedium`).

Weights are relative (they need not sum to 100) and live in the `seo` settings document (Settings → Scoring weights).

## Normalisation per input

| Input | Method |
|---|---|
| `searchOpportunity` | `logNorm(v, max) = log10(1+v) / log10(1+max)`, where `v` is impressions (or prior-period clicks for decay) and `max` the largest such value in the same analysis run. Log scale so one huge query does not flatten the rest. For content-only rules: `log10(1+impressions)/5`, capped at 1. |
| `rankingOpportunity` | Low CTR: `(11 − min(position, 11)) / 10` (fixing the snippet matters most on page one). Striking distance: `(maxPos − position) / (maxPos − minPos)` with the configured 5–20 band. |
| `relevance` | 1 when the URL maps to a CMS article, 0.5 otherwise. Content gap: `1 − topic overlap` (Jaccard of query tokens vs. title/tags) — the less the existing page matches, the more relevant a new piece is. Internal links: the best relatedness score. |
| `qualityGap` | Low CTR: `1 − CTR/expected`. Content gap: 1 if no page is in the top 20, else 0.6. Quality: `1 − audit score`. Outdated: 0.9 when an upstream source confirms it, 0.5 for "verify". Internal links: `suggestions / maxLinksPerPage`. |
| `trend` | Decay: relative drop in clicks, 28 days vs. the previous 28. |
| `effort` | Fixed per rule: snippet 0.9, links 0.8, quality fixes 0.7, striking distance 0.5, refresh/outdated 0.4–0.5, new article 0.2. |

### Expected CTR yardstick (low-CTR rule)

`expectedCtr(position)`: 25 % (pos < 1.5), 15 %, 10 %, 6 % (≤ 5), 3 % (≤ 10), 1 % (≤ 20), 0.5 %. A conservative curve in
line with published industry CTR studies; it is only a **relative** yardstick: a query is flagged when its CTR is below
`expected × lowCtrRatio` (default 0.6). It is never shown as a prediction.

## Confidence

Set by each rule from data volume and corroboration, e.g. decay is `high` only when the year-over-year comparison also
shows the drop (rules out seasonality) and `low` without year-over-year history; outdated-tech is `high` only with a
cited upstream source.

## Recalibrating from measured outcomes

Implemented recommendations record a **baseline** (28 days before "implemented") and **post-change** metrics for
days 1–28 and 29–56 after (Search Console clicks, impressions, CTR, position for the URL), filled by the daily
`outcomes` job.

Quarterly (or after ≥ 20 implemented recommendations):

1. Export outcomes: `select category, rule_key, priority_score, baseline_metrics, post_metrics_28d, post_metrics_56d from seo_recommendations where implementation_status = 'implemented'`.
2. Per category, compare the change in clicks (`post_56d.clicks − baseline.clicks`, normalised by baseline impressions)
   against the priority score. Watch for site-wide movement: compare with the change in `seo_gsc_daily_totals` over
   the same windows and subtract it.
3. If a category's high-band items do not outperform its low-band items, lower the weight of the input that drives
   that category (e.g. `effort` overrates cheap snippet changes) or raise its threshold.
4. Change weights/thresholds in Settings (audit-logged) and note the reason and date in DECISIONS.md.

These are observational comparisons, not controlled experiments: other changes (algorithm updates, seasonality,
new competitors) affect the same windows, so treat them as signals, not proof.
