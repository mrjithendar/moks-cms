# Jobs and profiles: admin guide

Admin → **News desk** (admins only). Nothing runs while `NEWS_DESK_ENABLED` is not `true` (MANUAL_SETUP.md); you can
still configure everything.

## First job

1. **Sources** → *Import starter sources* (or *Add source*); open each, check its terms, enable it.
2. **Topics**: every CMS category is already a topic; add keywords (they drive the rules classifier until a model is
   trained) and suggested tags. Optionally *Bootstrap labels with Claude*, then *Retrain now*.
3. **Jobs → New job**: name, mode, sources (none = all enabled), topics, keywords, caps, schedule, budget. Save (v1).
4. *Dry run*: the whole pipeline (fetch, rank, draft, gates) without saving drafts or spending image budget; *Dry run (no
   LLM)* stops after selection. Open the run: the candidate table explains every decision.
5. Adjust weights/threshold/filters (each save is a version), dry run again, then enable the job.

## Job editor tabs

| Tab | What |
|---|---|
| General | name, description, mode (single stories / daily digest / both), enabled |
| Sources | which sources (none = every enabled source) |
| Selection & ML | include/exclude keywords and entities, topics, min score, dedupe window, max age, recency half-life, digest size, language, score weights (v1) |
| Writing | writing profile (+ pinned version), length range, author, models per agent |
| Images | on/off, image profile, provider override, variants |
| Categories | default CMS categories when the classifier is not confident |
| Schedule & limits | cron + time zone, max per run / per day, per topic / per source per day, expiry notice days, publishing slots |
| Budget | LLM and image, per day and per month; tokens per draft (crew cap) |
| Review | review priority, run summary email |

**Versions**: every save creates an immutable version with a field-by-field diff; runs record the version they used.
*Roll back to vN* saves vN's snapshot as a new version (history is never rewritten). *Clone* copies a job, disabled.
Deleting is a soft delete; runs and drafts keep their history. At most 25 jobs (keeps the metrics' label bounded).

Cron is the standard 5 fields in the job's time zone (`0 7 * * 1-5` = 07:00 on weekdays). The dispatcher runs every 15
minutes, so a job starts within 15 minutes of its time; one run per scheduled slot.

## Profiles & playground

**Writing profile**: system style, structure template, tone, audience, banned phrases, required sections, examples,
optional model. **Image profile**: provider, style prompt, negative prompt (people, faces, logos, trademarks and text
are always excluded), palette, variants, template fallback. Saving always creates a new version; *Activate* makes it the
one jobs use (unless a job pins a version).

**Proposed versions** come from the weekly style review: it compares the drafts with what you published, and proposes
a new version with an explanation and before/after examples taken from your edits. Nothing changes until you click
*Approve & activate*.

**Playground**: pick a job (its budget pays), a recent story and versions A/B; the crew writes both and shows them side
by side with tokens and cost. Nothing is saved to the review queue unless you click *Save as draft*, which runs the
normal draft flow with that version (all quality gates apply).

## Reviewing news drafts

Review queue → **News** badge, job name, score and age (drafts older than 48 h are marked "may be stale"; news is
sorted by score × freshness × the job's review priority). The review page shows: why the story was picked (score
breakdown), the article with inline edits, sources with the fact-sheet claims each supports, the quality gates and the
closest passages to the sources, fact-check flags, the cover (regenerate with a prompt tweak, switch to the template,
pick an earlier cover, edit the alt text), category and tags.

- **Approve & publish** (now) or **Schedule…** (the job's next publishing slots). Publishing goes through the existing
  path: publish → verify the live page → IndexNow + sitemap resubmission (incl. the news sitemap).
- **Reject…** with a reason: off-topic, low value, duplicate, inaccurate, style, other. Reasons train the ranker and
  source weights; "duplicate" marks the story covered.
- Your edits are saved on the draft; the generated version is kept, and the edit distance is recorded at publish time.

## After publishing

- The article has `NewsArticle` structured data (author, dates, image), appears in `/news-sitemap.xml` for 48 hours and in
  `/news/feed.xml`.
- **Add correction / update** (review page of a published news draft): a dated note in the article's Corrections box,
  `dateModified` updated, page resubmitted.
- **Expiry** (job setting, optional): after N days the article shows "This news may be outdated" with a link to newer
  coverage in its category. Nothing is ever deleted.

## Learning loop (all human-approved)

| What | When | Applied |
|---|---|---|
| Ranker (LightGBM) | weekly, once ≥ 100 labelled decisions | only if it beats v1 on held-out AUC and NDCG@5 |
| Topic classifier | weekly and on demand (Topics → Retrain) | only if macro F1 is not worse |
| Writing style | weekly style review | proposed version; you approve it |
| Source credibility | on the Sources page | suggestion; you apply it |
