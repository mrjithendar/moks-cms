# AI News Desk: decisions and deviations

Each entry: what the brief asked, what the repository has, what was done and why. SEO decisions D-01 … D-65 still apply
(docs/seo/DECISIONS.md); in particular D-01 (commits on the feature branch only), D-03 (docs under services/www/docs),
D-04 (audit_log), D-05 (setting rows), D-44 (callback API), D-56 (split-flow approval), D-57 (flow persistence/locks).

## N-01 Docs live in `services/www/docs/news/`
There is no root `docs/` folder (D-03). The brief's `docs/news/*` files are here.

## N-02 Embeddings for news are `real[]`, not pgvector
pgvector is optional in this cluster (MANUAL_SETUP §13 in the SEO docs) and may be absent. News dedupe and clustering
only ever compare items inside a bounded window (14 days of items, 4 days of clusters: hundreds to a few thousand
rows), which numpy does in milliseconds. So `news_items.embedding` and `news_clusters.centroid` are `real[]` and the
migration works with or without the extension. "Novelty vs the site" uses the existing pgvector article index through
the retriever when it is available, and is skipped (novelty = 1) when it is not.

## N-03 Topics map to CMS categories; tags are suggestions
`news_topics.category_slug` references `category.slug`, which is the CMS's own (editable) list. Topics add keywords for
the rules fallback and suggested tags; tags stay free text in the CMS. On first visit, every category becomes a topic.

## N-04 Extra tables: `news_models` and `news_labels`
The brief allows models in Postgres or a PVC. A PVC would be a new volume for a few hundred KB, so models are rows in
`news_models` (artefact as bytes, metrics as JSON, one active per kind). Classifier models are stored as numpy arrays
(npz, `allow_pickle=False`), the ranker as LightGBM's text model: loading a model can never execute code.
`news_labels` holds the one-off Claude bootstrap labels and the owner's category corrections (human labels win).

## N-05 Fetching goes through the web app's SSRF-safe fetcher
The brief says to reuse v1's fetcher, which is TypeScript (`crawler.ts`: DNS checked inside the socket, private ranges
refused, manual redirects re-validated, size and time limits). The agent asks the web app (`POST /news/fetch`), as it
already does for documentation (D-44). `headerFetcher` adds request headers to the same code path: a User-Agent that
identifies the site, feed `Accept`, and `If-None-Match`/`If-Modified-Since`. Feeds may only be fetched from their own
source's host; primary sources only from source hosts + a primary-source allowlist + the docs allowlist. robots.txt is
read per origin (cached 6 h; 4xx = allowed, 5xx/unreachable = disallowed, Google's rules). Paywalled hosts (Settings) are
refused in both the source editor and the fetcher. https only. The agent keeps its egress to the Anthropic API.

## N-06 News drafts are v4 new-article drafts
A news draft is a CMS draft post in collection `news` (contentType `news`) plus a `seo_drafts` row of kind
`new_article` owned by the agent, created in one callback after the gates pass. So the review page, validators,
approval record, `publish_flow` and `publishNewArticle` are the existing ones; nothing new can publish. The CMS post is
created with its sources, category, tags and cover, so the site's existing `NewsArticle` JSON-LD, Sources section and
Google News sitemap work unchanged. The crew's `schema_jsonld` is checked by the SEO gate and shown in review; the page
renders the site's own markup (one source of truth).

## N-07 Separate news budgets
News LLM calls are recorded in `seo_llm_usage` with purpose `news.*` (so the usage page shows them) but are excluded
from the SEO admin monthly cap, as Ask-the-Blog already is (D-48): a busy news day can never pause SEO drafting. News has
its own caps (global and per job, daily and monthly, LLM and image), checked before every call against `news_runs`.

## N-08 Entities: rules + gazetteer, no NER model
The brief suggests "rules plus a small model". A spaCy/transformers NER model would add 50–500 MB and a download step;
the entities that matter here (CVE ids, versions, a fixed list of products and organisations) are found reliably by
rules. The "small model" in the pipeline is the topic classifier, with Claude Haiku as its low-confidence fallback.

## N-09 Language detection by stop words
No dependency: a stop-word vote over the first 400 words (en/de/fr/es) is enough to filter items to a job's language.
Items with too little text get `null` and are not filtered out.

## N-10 Cron in-house (≈80 lines each side)
The dispatcher needs "is this job due in its time zone"; the editor needs validation and "next run". A 5-field evaluator
with IANA zones is small and fully tested; croniter would be a dependency for one function.

## N-11 One dispatcher CronJob, not one per job
Jobs are created in the admin UI; one CronJob per job would need a person to apply a manifest for every new job (D-49:
CronJobs are applied manually). A single `news-dispatch` CronJob every 15 minutes starts `news_dispatch_flow`, which
starts each due job with a slot id (job + scheduled minute). `news_runs (job_id, slot)` is unique, so a double fire is a
no-op. Cost: one small trigger pod every 15 minutes.

## N-12 The learned ranker uses LightGBM's binary objective
The brief asks for a LightGBM ranker evaluated by AUC/NDCG. A lambdarank model's scores are unbounded and can't be
compared with a job's score threshold; a binary model's probability can. It is evaluated per run with NDCG@5 and
overall AUC on a time-ordered hold-out, and replaces v1 only when it beats v1 on both.

## N-13 One quality retry is not attempted
The new-article flow retries once after validation errors. News drafts that fail a gate are saved as `failed_quality`
with the reasons and **not** retried automatically: a second crew run doubles the cost, and the failures (copied
passages, unsupported numbers) are exactly what the owner should see. "Retry failed step" in the run detail re-drafts
on demand.

## N-14 Covers: alt text is required by the CMS
The CMS requires alt text on covers, so "decorative" can't be expressed by an empty alt. The vision model's
`decorative` verdict is stored on `news_images` and in the media item's description; the cover still gets accurate alt
text. Template covers carry IPTC DigitalSourceType `digitalCreation`; AI images `trainedAlgorithmicMedia`.

## N-15 OpenAI Images model is configurable
OpenAI's docs now list `gpt-image-2`, but its size list couldn't be confirmed from here (the docs site refused automated
access). `NEWS_OPENAI_IMAGE_MODEL` defaults to `gpt-image-1`, whose 1536×1024 size is documented. Not enabled by default.
