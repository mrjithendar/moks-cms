# Topic discovery

What to write next, with the evidence. Admin → **Topic discovery** (`/admin/topics`).

## What it does

Once a day (CronJob `seo-flow-topic-discovery`, 05:40 UTC → `topic_discovery_flow` in the seo-agent → the web app's
`topic_discovery` job) and on "Run discovery now":

1. **Collect trends** from the enabled sources. Only the title, link and counts are kept (no usernames, no bodies), in
   `seo_topic_signals`, pruned after 30 days.
2. **Read search demand**: Search Console queries of the last 28 days with enough impressions that rank outside the
   top 8.
3. **Filter** both to the site's subjects (the "Subjects" list in the settings).
4. **Group** queries and trend items into topics by shared words (the token similarity the keyword clusters use).
5. **Drop** topics the site already has an article for, or that are already in the editorial calendar.
6. **Score** each topic 0 to 100 and store the ones above the minimum in `seo_topic_candidates`.

No model is called: the same inputs always give the same list, it costs nothing, and every number on a candidate can
be traced to its evidence. Grouping is lexical, not semantic, so two differently worded versions of one topic can
appear as two candidates.

## Sources

| Source | How | Needs |
|---|---|---|
| Search Console | `seo_gsc_query_daily` (already synced) | the Search Console sync |
| Hacker News | Algolia search API, stories of the last 7 days above the minimum points | nothing |
| dev.to | public articles API, top of the week per subject tag | nothing |
| GitHub | repository search, repositories created in the last 30 days with more than 50 stars | nothing (unauthenticated: 8 subjects a run) |
| Reddit | the threads Promotion already collects (`seo_promo_signals`) | Promotion's Reddit settings |
| X | API v2 recent search, 3 requests a run | **off by default.** Save `X_BEARER_TOKEN` (Advanced settings → Research sources) and switch the source on. Recent search needs a paid X API plan. Untested against the live API. |

A source that fails is reported on the run (`partial`) and the others carry on.

## Score

`score = weighted mean of demand, trend, fit, ease` (weights in the settings; defaults 30 / 25 / 20 / 25).

| Part | Meaning |
|---|---|
| demand | Search impressions in 28 days, log-scaled (5,000 impressions = 100). 0 for a topic seen only as a trend. |
| trend | Points plus twice the comments of its trend items, halved every 7 days of age, log-scaled, plus 10 for each extra source. |
| fit | Share of the topic's words that appear in the titles of the site's own articles. |
| ease | 100 − keyword difficulty. |

## Difficulty

- **Proxy (default).** From what the site can see itself: starts at 50; long-tail phrases are easier and one- or
  two-word terms harder; easier when the site already appears for the query in the top 30 and when the topic is close
  to what the site covers; a little harder with no search data. It is **not** a measurement of the competition on the
  results page, and is labelled "proxy" wherever it is shown.
- **DataForSEO (optional).** Save `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` (Advanced settings → Research sources)
  and switch it on in the topic settings. One request per run to DataForSEO Labs "bulk keyword difficulty" (Google) for
  the candidate titles; candidates it returns a value for use it, the rest keep the proxy. If the request fails the
  proxy is used. Untested against the live API (no account at the time of writing).

## From candidate to article

"Add to calendar" creates an **approved** editorial-calendar item with the candidate's reasons in its notes, the
queries as supporting queries and the trend links as evidence. From there it is an ordinary calendar item: the
Editorial Crew drafts it, and a person reviews and approves. "Dismiss" hides a candidate for good.

## Automatic planning

Topic discovery → **Automatic planning**. Off by default. Once a day (CronJob `seo-flow-calendar-plan`, 06:30 UTC →
`calendar_plan_flow` → the web app's `calendar_plan` job) and on "Plan now":

| Mode | What the planner does |
|---|---|
| Off | nothing |
| Suggest only | adds the best candidates as **suggested** calendar items without a date; it adds no more while earlier suggestions are still waiting |
| Schedule | adds them as **approved** items with a date and time |
| Schedule and draft | the same; the draft is written ahead of the date (auto-draft, a later change) |

- **Cadence:** N articles per day, per week (Monday to Sunday) or per month, on the chosen publishing days, at the
  chosen time (Asia/Kolkata), for the next "plan ahead" days. Limits: 5 a day, 14 a week, 31 a month.
- **Quota includes your own items.** Every dated calendar item in a period counts, so the planner tops the calendar
  up and never adds to a period that is already full.
- **Spread.** Within a week or month, planned articles keep a distance of `floor(7 / N)` or `floor(30 / N)` days from
  each other and from existing items.
- **Only candidates above "Minimum score to plan"**, best first. A candidate is planned once; dropping the calendar
  item does not bring it back.
- **Why, in the notes.** Each item's notes (shown on the calendar under an "Auto-planned" badge) say when it was
  planned, why the topic (score, its parts and the evidence sentences) and why the date (cadence, how full the period
  was, the distance rule).
- **Nothing is published.** A scheduled item is a plan. Drafts still go through review and a person's approval.

Settings: `setting` row `automation`.

## Settings and data

- Settings: `setting` row `topics` (sources, DataForSEO switch, subjects, weights, thresholds).
- Secrets: Advanced settings → Research sources (sealed; never in the topic settings).
- Tables: `seo_topic_signals`, `seo_topic_candidates` (migration `0029_seo_topics.sql`; rollback in `src/db/rollback`).
- Switch it off: Topic discovery → Settings → off (the flow then does nothing), or suspend the CronJob.
