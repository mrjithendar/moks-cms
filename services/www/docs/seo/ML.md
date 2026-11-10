# SEO-side ML (v5)

Five models that can replace or inform a v1–v4 rule. They run in the seo-agent as plain Python steps of one CrewAI Flow,
`seo_ml_flow` (weekly CronJob `seo-flow-ml` plus manual runs from **ML models → Run now**). They write Postgres tables,
and the web app reads those tables. **No ML runs inside a web request.**

The pattern is the News Desk's ([../news/ML.md](../news/ML.md)): train → evaluate on held-out data → store the version
and its metrics (`seo_ml_models`) → **active only if it beats the current rule** (and, where noted, after your review)
→ outputs written → the TypeScript side uses the model or falls back to the rule. Libraries: the ones already installed
(scikit-learn 1.9.1 incl. `HDBSCAN`, LightGBM 4.7.0, numpy, scipy). The one library the brief named that isn't
installed, statsmodels for STL, was **not** added: STL is implemented in numpy instead (D-75).

## Model or rule? (`src/lib/seo-intel/ml.ts` `mlDecision`)

| Override (ML models page / Settings) | Uses the model when… | Otherwise |
|---|---|---|
| `auto` (default) | a version is **active** (beat the rule on held-out data; reviewed where required) **and** its output is fresh | rule |
| `rule` | never | rule |
| `model` | its output exists and is fresh, even if it never beat the rule | rule (`rule (stale model output)`) |

**Fresh** means the output was computed within **14 days** (2 × the weekly schedule). A missing table (migration 0019 not
applied) means rule. Every number the site shows from these features carries its source: `model vN`,
`model vN (A/B)`, `rule`, `rule (insufficient history)` or `rule (stale model output)`.

**On retrain**, if the previously active model no longer beats the rule, the new version is stored inactive, the site
falls back to the rule at once, `seo_ml_train_runs_total{status="fallback_to_rule"}` counts it, and
`SeoMlModelFellBackToRule` fires.

## 3.1 Content decay: STL (`app/seo_ml/decay.py`, `stl.py`)

- **Data:** `seo_gsc_page_daily` (web), clicks and impressions summed per page per day, up to 800 days.
- **Eligible pages:** ≥ 120 days of history and ≥ 100 impressions in the last 28 days. The others keep the 28-day
  rule, labelled `rule (insufficient history)`.
- **Method:** STL (Cleveland et al. 1990: cycle-subseries LOESS, low-pass filter, trend LOESS, bisquare robustness
  weights) with weekly seasonality. The trend window is 45 days, so a one- to two-week dip can't drag the trend down.
  With ≥ 2 years of data a yearly component is removed first. It is **last year's** deviation of the monthly level from
  that year's level, shifted by 364 days. A yearly STL with only two cycles would absorb the very decline it should
  find (found while measuring: 0 of 133 two-year declines flagged).
- **Flag** when all four hold:
  - the trend fell on each of the last 21 days;
  - it fell more than 20 % from its level before the decline;
  - the robustness-weighted, deseasonalised recent level is more than 2σ below the baseline (σ = the spread of 21-day
    means in the page's own history);
  - the last 7 days confirm it (> 2σ of 7-day means). At the end of a series STL can't yet tell a dip that just ended
    from a decline; a recovered week can.
- **Output:** `seo_ml_decay_signals`, one row per page: decaying, trend slope, drop %, confidence, `method_version`
  (`stl-v1` | `insufficient_history`), and evidence holding 120 days of actual clicks and the trend. The
  recommendation shows the evidence as a trend-vs-actual chart.
- **Evaluation:**
  1. Labelled synthetic series (stable weekly pattern, holiday dips of 7–14 days at −50 to −70 %, sustained declines of
     35–60 %), 180-day and 800-day (with a ±30 % yearly wave), on **held-out seeds**. The detector was designed while
     looking at other seeds.
  2. A back-test on the real history: model and rule alert rates on 12 two-week cut-offs, and their agreement.
- **Activation:** fewer false alarms than the rule on the noise series without lower drop recall, **then your review**
  of the real back-test (ML models → "Reviewed: use the model"). A retrain that still wins keeps the review.
- **Measured** (held-out seeds; 60 × 180-day + 30 × 800-day series per kind, 2026-11-10):

  | | False alarms (stable + holiday) | Sustained drops caught |
  |---|---|---|
  | STL model | 2 / 180 (1.1 %) | 82 / 90 (91 %) |
  | 28-day rule | 13 / 180 (7.2 %) | 42 / 90 (47 %) |

  On the 800-day series alone the rule catches one more drop than the model (29 vs 28 of 30, in a separate check),
  while raising 14 false alarms against the model's 2.

  The real back-test needs production data. It runs on the first `seo_ml_flow` in the cluster.

## 3.2 Query clusters: embeddings + HDBSCAN (`app/seo_ml/clusters.py`)

- **Data:** the top 2,000 Search Console queries (90 days), plus the open Ask-the-Blog gaps, which share the space and
  are stored as `ask:<normalized>`.
- **Method:** each query is embedded with the service's embedding model (bge-small), cached by normalised text in
  `seo_ml_query_embeddings`, then clustered with `sklearn.cluster.HDBSCAN` (min cluster size 3, min samples 2). Each
  cluster is named after its highest-impression query; noise points become singletons.
- **Output:** `seo_ml_query_clusters`. The daily keyword refresh copies these clusters into `seo_query_clusters` (with
  a `source` column), so Keyword opportunities' "Parent topic", the content-gap views and "Asked on site" all read
  them. Queries the weekly model hasn't seen yet get token-set clusters (ids above 1,000,000, `source` = rule).
- **Evaluation:** 200 sampled queries (half the top queries, half random from the long tail):
  1. Claude **suggests** groupings (one Haiku call, `purpose = ml_label`, on demand).
  2. You confirm or change them on **ML models → Labelling → Query groupings**.
  3. Model and token-set clusters are scored against your labels.
- **Activation:** ≥ 100 confirmed labels, ARI strictly higher than the token-set rule, and purity no more than 0.05
  lower. Purity alone rewards over-splitting (all singletons score 1), which is what token sets do, so ARI decides;
  inverse purity is shown next to it.
- **Measured:** on a fixture (3 topics + 2 noise queries), ARI 0.90 vs 0.44 and inverse purity 1.00 vs 0.65. The real
  scores need your labels.

## 3.3 Intent classifier: distilled from Haiku (`app/seo_ml/intent.py`)

- **Training data:** `seo_query_intents` rows labelled by Haiku with the **current** prompt (`seo-intent-v1`; the
  prompt version is now stored, and every earlier label was v1), plus your spot-check answers, which win.
- **Features:** query embedding ⊕ 10 lexical features ("how to", "what is", vs/or/compare, error words, version
  pattern, commercial words, navigational words, tutorial words, length, question mark).
- **Model:** multinomial logistic regression (balanced), stored as numpy arrays (no pickle), like the news classifier.
- **Threshold:** the lowest confidence at which held-out accuracy of the predictions at or above it stays ≥ 90 %, kept
  within [0.5, 0.95].
- **Use:** the daily keyword refresh takes the model's intent for new queries at confidence ≥ the threshold
  (`source = model`, `model = "model vN"`). The rest go to Haiku, and Haiku's answers become new training data; without
  Haiku they get the rules.
- **Evaluation:** macro-F1 against held-out Haiku labels (20 % split), next to the rules' macro-F1 on the same queries.
  Up to 50 model/Haiku disagreements become tasks on **Labelling → Intent disagreements**.
- **Activation:** macro-F1 ≥ 0.85 **and** at least 50 spot-checked disagreements (all of them if fewer exist).
- **Savings:** reported as "answered without Claude" on the Models page; COSTS.md has the estimate.
- **Measured:** synthetic separable data only (tests). The real numbers need ≥ 60 Haiku labels from production.

## 3.4 Learned priority: weight proposals (`app/seo_ml/priority.py`, SCORING.md)

- **Data:** implemented recommendations with baseline and 28-day outcome metrics, oldest first.
- **Lift:** (clicks in the 28 days after − clicks in the 28 days before) − (the 28 days before − the 28 days before
  those), divided by max(clicks before, 10). This is relative to the page's own trend.
- **Features:** the six score inputs, category, position band, impressions, CTR gap, decay signal, length,
  internal-link count, intent, cluster size and effort.
- **Model:** LightGBM regression (deterministic). Proposed weights come from a non-negative least-squares fit of the
  lift's rank on the six inputs (renormalised like `scoreOf`), scaled to 100. LightGBM's gain importance is shown
  beside them.
- **Evaluation:** NDCG@10 on the newest 20 % of outcomes: the proposed weights vs the current ones (and LightGBM's own
  ranking as a reference).
- **Never applied automatically.** A proposal is stored only when it ranks the held-out outcomes better. You approve or
  dismiss it on Settings → "ML models & retrieval"; approval writes a new weights version into the audited settings
  document.
- **Below 50 outcomes:** "collecting data: N/50".

## 3.5 Related articles (`app/seo_ml/related.py`)

- **Components:**
  - similarity: `similar_articles` from the vector index;
  - co-visitation: GA4 views of a page path in sessions that started on a landing page, aggregated over 28 days and
    cosine-normalised (`seo_ga4_page_pairs`, synced daily by the web app);
  - shared queries: Jaccard of the 90-day GSC queries;
  - category: same category.
- **Weights:** 0.50 / 0.25 / 0.15 / 0.10 with co-visitation; without it, 0.60 similarity / 0.25 shared queries /
  0.15 category.
- **GA4 pair data:** whether the property supports the dimension pair (`landingPagePlusQueryString` × `pagePath`) is
  only known in production. The sync records `seo_integrations.config.pagePairs = ok | unsupported | error` and never
  fails the GA4 sync because of it.
- **Output:** `seo_ml_related_articles` (top 6 per article, with components).
- **Use:**
  - The public "Related reading" block runs an **A/B split by article-id parity** while the model is
    `experiment_running`: even ids get the model's list, odd ids the existing tags/category/links list. Explicit
    front-matter `related` entries stay first in both.
  - Internal-link candidate ranking blends in the model's score (25 %) only while the model is active or forced. The
    v2 linking limits are enforced unchanged by the web app's planner.
- **Evaluation:** `related_click` GA4 events (arm, position) from the block, sent only with consent. CTR =
  related_click ÷ article page views per arm, over at least 28 days. The Models page shows "experiment running" until
  then. The CTR comparison is read from GA4 by hand (Explore → event `related_click`, breakdown by `arm`), because the
  daily sync doesn't import custom events.

## Live retrieval evaluation

`seo_ml_flow`'s last step runs the RAG eval set (RAG.md) against the live retriever and records it in
`seo_rag_eval_runs`, which feeds `seo_rag_eval_recall_at_3`.

## Overriding and rolling back

- One model: **ML models** or **Settings** → its "Use" select → `force the rule`. This takes effect on the next read,
  with no restart.
- Everything ML: suspend the `seo-flow-ml` CronJob. Outputs go stale after 14 days and every feature falls back to its
  rule automatically.
- Retrieval: `RAG_MODE=vector` (the default) in `seo-agent-config`.
- Data: migration 0019 is additive; its manual rollback is `src/db/rollback/0019_seo_v5_ml.down.sql` (drops the ML
  tables only).

## Resources

Training runs inside the seo-agent pod, within its limits. Measured on the development Mac (Python 3.13, CPU) with the
in-memory store: a full `seo_ml_flow` on 2,000 queries, 400 pages × 800 days and 120 outcomes. See PROGRESS.md v5
"Memory" for the numbers and the decision on a separate Job.
