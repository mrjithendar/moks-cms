# DataForSEO: volume, difficulty, live ranks and backlinks

Search Console says how the site already performs. It cannot say how many people search for a query, how hard a query
is to rank for, where the site ranks for a keyword it has no impressions for yet, or who links to the site. DataForSEO
(pay as you go, no subscription for the first three) fills those gaps. The integration is off until a person turns it
on, and its spend is capped per month.

Code: `src/lib/seo-intel/dataforseo.ts`. Tables: migration `0030_seo_dataforseo.sql`. Settings: Settings → Data sources →
DataForSEO.

## What it buys

| Job | When | Endpoint | Writes | Shows in |
|---|---|---|---|---|
| `dataforseo_keywords` | daily, 2 h after the GSC sync hour; only queries whose metrics are older than `refreshDays` | DataForSEO Labs `keyword_overview/live` (≤ 700 keywords per request) | `seo_keyword_metrics` | Keywords: **Volume** and **KD** columns (sortable), CSV export, Tracked keywords |
| `serp_ranks` | weekly (`rankTracking.weekday`, `hourUtc`) | SERP `google/organic/live/regular`, one request per tracked keyword, `depth` results | `seo_serp_ranks` (one row per keyword per day) | Tracked keywords: live Google position, AI Overview badge, top results |
| `backlinks` | weekly (`backlinks.weekday`, `hourUtc`); **off by default** | Backlinks `summary/live` + `referring_domains/live` (top 1,000 by rank) | `seo_backlink_snapshots`, `seo_referring_domains` (kept a year) | Backlinks page: totals, gained and lost referring domains |

- Keywords: the top `maxKeywords` Search Console queries by 90-day impressions, plus every tracked keyword. A query
  DataForSEO has no data for still gets a row (volume empty), so it is not bought again every day.
- Ranks: "position" is the organic `rank_group` of this site's best result; empty means not in the first `depth` results.
  Tracked keywords can be added on the Tracked keywords page, also ones the site has no impressions for yet.
- Backlinks: the Backlinks API has its own monthly minimum at DataForSEO. Switch `backlinks.enabled` on only once that
  subscription is active, or the job fails with DataForSEO's access error.
- All three use the market in Settings: `locationCode` (2840 United States, 2356 India, 2826 United Kingdom) and
  `languageCode`. Changing the market makes every keyword stale, so the next daily run re-buys them.

## Cost control

- Every response carries DataForSEO's own `cost`; each job stores the sum on its row (`seo_sync_jobs.detail.costUsd`).
- `monthlyBudgetUsd` (default $5) is a hard cap per calendar month (UTC). Before each request the client checks the
  remaining budget against an upper estimate of that request and stops if it would cross the cap: the job ends
  `partial` with what it already wrote, or `skipped` if nothing was bought.
- Rough prices (DataForSEO's list prices; check theirs): keywords ≈ $0.01 per request + $0.0001 per keyword, so 1,000
  queries ≈ $0.12 per refresh; live SERP ≈ $0.002 per 10 results, so 20 keywords at depth 30 ≈ $0.12 a week; backlinks
  ≈ $0.07 per snapshot plus the subscription.
- Spend this month is on Integrations → DataForSEO and in the confirmation of every "Run now" button.

## Setup (a person)

1. Create an account at dataforseo.com and add funds. API Access shows the API login and password (not the dashboard
   password).
2. `KUBE_CONTEXT=<name> scripts/set-dataforseo-config.sh` merges `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` into
   Secret `jithendar-com-env`. Restart the site.
3. Settings → Data sources → DataForSEO: tick **Enabled**, check the market and the monthly cap, save.
4. Integrations → DataForSEO → **Run now** on "Volume and difficulty". Volume and KD appear on Keywords once it finishes
   (Data sync shows the job).

Rollback: untick Enabled (nothing more is bought). The tables are dropped only by the manual
`src/db/rollback/0030_seo_dataforseo.down.sql`.
