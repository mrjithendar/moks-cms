# News desk ML

CPU-only, in the seo-agent process, as plain Python steps inside the flows. Libraries: scikit-learn 1.9.1, LightGBM 4.7.0,
datasketch 2.0.0, numpy. No MLflow: models are rows in `news_models` with their metrics; one active per kind.
Measured on the development Mac: importing the ML libraries adds ≈ 70 MiB; training the classifier on 1,000 items
(384-dim embeddings + 72 extra features) or the ranker on 2,000 rows takes ≈ 0.1 s each.

## Normalisation (`app/news/text.py`)

- Canonical URL: lower-case host without `www.`, default ports dropped, tracking parameters removed (`utm_*`, `gclid`,
  `fbclid`, `mc_*`, `ref`, …), remaining query sorted, fragment and trailing slash dropped. `url_hash` = SHA-256 of it.
- Clean text: scripts/styles/nav/footers dropped, paragraphs kept, entities decoded, bounded (excerpt ≤ 4,000 chars,
  text ≤ 20,000).
- Language: stop-word vote (en/de/fr/es) over the first 400 words; `null` when there is too little text (N-09).
- Entities: CVE ids, version strings, and a gazetteer of products and organisations (N-08). KEV/NVD feeds add CVSS and
  "known exploited".

## Dedupe (`app/news/dedupe.py`)

| Level | Method | Threshold |
|---|---|---|
| exact | same normalised URL (any source) or same content hash (title + text, normalised) | equal |
| near-duplicate | MinHash (64 permutations, `affine32`) over word 5-gram shingles; LSH for candidates (threshold 0.5), decision on estimated Jaccard | ≥ 0.80 |
| semantic | cosine of embeddings (the service's embedding model; bge-small in production) | ≥ 0.95 |

A duplicate is stored with `duplicate_of` and joins its original's cluster, so source counts stay honest. Tested on
fixtures: a syndicated copy with a small edit (Jaccard 0.84) is a near-duplicate; another article about the same release
is not (it clusters instead).

## Clustering (`app/news/cluster.py`)

Incremental, over clusters seen in the last 96 hours. An item joins the best cluster when cosine(item, centroid) ≥ 0.80,
or cosine ≥ 0.66 with entity Jaccard ≥ 0.34, or they share a CVE id; otherwise it starts a new one. Centroids are running
means. **Burst** = 1 − exp(−g / 2.5), where g = distinct sources that joined in the last 12 h − half of those that joined
in the 24 h before (clipped to 0).

## Novelty vs the site

The cluster title is searched in the site's pgvector index (the existing retriever). Best hit ≥ 0.86 → the cluster is an
`update_candidate`: it is not drafted as new news, and the candidate's reason names the existing article (to update it
through the SEO optimisation flow). When pgvector is not available, novelty is 1 (no match).

## Topics (`app/news/classifier.py`)

- Features: embedding ⊕ 64 hashed entity buckets ⊕ one keyword-hit feature per topic.
- Model: one balanced logistic regression per topic (multi-label), stored as numpy arrays (no pickle).
- Prediction: labels with p ≥ 0.5 (at least the best); if the best p < `classifier_threshold` (0.55) Claude Haiku picks
  1–3 topics from the allowed list; without a model, keyword rules.
- Bootstrap: "Bootstrap labels with Claude" labels up to 1,000 recent items once (≈ 50 calls of 20 items).
- Training: weekly and on demand, from Claude labels plus the owner's category corrections (human labels win). 20 %
  held out; per-topic precision/recall/F1 and macro F1 recorded. A new model is activated only if its macro F1 is not
  lower than the current one's.

## Ranking (`app/news/scoring.py`)

v1 (transparent): score = Σ wᵢ·fᵢ, weights renormalised to 1 (job overrides allowed). Every candidate stores each
feature's value, weight and contribution.

| Feature | Value |
|---|---|
| credibility | mean of the top 3 distinct sources' credibility |
| source_count | 1 − exp(−(n − 1)/2) |
| burst | cluster burst (above) |
| recency | 0.5^(age / half-life), half-life 36 h by default |
| topic_match | the cluster's probability for the job's topics (or its best topic) |
| audience | similarity to the closest site article × (0.5 + 0.5 × its share of top-article clicks, GSC 28 d); 0.3 when unknown |
| novelty | 1 − similarity to the closest site article |
| severity | CVSS / 10; known exploited ⇒ ≥ 0.9 |
| keyword_overlap | share of the story's top terms that appear in the site's GSC queries |

Default weights: credibility .14, source_count .12, burst .10, recency .16, topic_match .14, audience .10, novelty .12,
severity .06, keyword_overlap .06.

v2 (learned): LightGBM, binary objective (N-12), 120 rounds, 7 leaves, deterministic. Labels: approved/scheduled = 1,
rejected = 0 (performance at +7/+28 days is collected in `news_feedback` for later use as a stronger label). Trains once
there are ≥ `ranker_min_feedback` (100) labelled decisions. Time-ordered split (oldest 80 % / newest 20 %). Promoted
only if it beats v1 on the same held-out rows on **both** AUC and NDCG@5 (per run). Its explanation is LightGBM's
per-feature contributions, shown next to the v1 breakdown. Tests: a synthetic signal v1 underweights is learned and
promoted; pure noise is not.

## Selection (`app/news/select.py`)

In this order, each candidate gets exactly one reason: language → max age → excluded keywords/entities → include
keywords/entities → job topics → already covered in the dedupe window → existing site article (update candidate) →
score threshold → per-run cap → per-day cap (job time zone) → global daily cap → diversity (per topic, per source per
day). Digest mode: the top `digest_size` eligible stories become one article (counts as one toward the caps).
"Both": singles first, then a digest of eligible stories held back only by the per-run cap or diversity.
