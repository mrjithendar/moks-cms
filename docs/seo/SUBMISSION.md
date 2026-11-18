# Search-engine submission (v2 Phase 3)

What is submitted where, when, and why Google's Indexing API is not used. Code: `src/lib/seo-intel/submission.ts`.
Log: table `seo_search_submissions` (every attempt, including skips). UI: the timeline on each article's SEO panel
and on the draft's review page.

> Submitting a URL is a **crawl hint**. It does not guarantee crawling, indexing or any ranking change, and the UI
> says so wherever it shows a submission.

## When

| Event | IndexNow | Google sitemap resubmit | URL Inspection |
|---|---|---|---|
| SEO draft approved and published | after the live page passes verification | after verification | scheduled +60 h (setting, 24–168 h) |
| SEO draft rolled back | after re-verification | after re-verification | scheduled again |
| Editor save of a published post | only if a **visible** field changed (title, body, metadata, status, …) | no | no |
| Verification failed | **nothing** is submitted; alert + one-click rollback | — | — |

## IndexNow (Bing, Yandex, Seznam, Naver, …)

- Key: `INDEXNOW_KEY`, else the key from Admin → Integrations. If neither exists, the first SEO submission generates one
  automatically (audit `seo.submission.indexnow_key_generated`). If an admin turned IndexNow **off**, it stays off.
- The key file `/{key}.txt` is served from the site root by `src/proxy.ts` (an additive route; no public URL changes).
- URLs are queued and sent in one POST per minute to `https://api.indexnow.org/indexnow` (`host`, `key`,
  `keyLocation`, `urlList` ≤ 10,000, deduplicated). A URL already waiting is not queued twice.
- 200/202 → accepted. 429/5xx/network → back to the queue, job retries with exponential backoff (up to 6 attempts).
  400/403/422 → error (retrying cannot help).

## Google

**No Indexing API.** Google permits it only for pages with `JobPosting` or `BroadcastEvent` (livestream) structured
data; using it for articles is against its terms. Instead:

1. **Sitemap `<lastmod>` only moves on a substantive change.** The sitemap is built per request from each article's
   `updatedAt` (else `publishedAt`), never from the build time. An approved draft sets `updatedAt` only when it changes
   body text (headings, paragraphs, code); title/meta/alt-text/link-only drafts leave it — and the visible "Updated"
   date and JSON-LD `dateModified` — unchanged. (`isSubstantive()` in `changeset.ts`.)
2. **Resubmit the sitemap** with the Search Console API `sitemaps.submit`
   (`PUT /webmasters/v3/sites/{property}/sitemaps/{sitemap}`), `/sitemap.xml` plus `/news-sitemap.xml` for news
   articles, at most once per hour per sitemap. This needs the **`https://www.googleapis.com/auth/webmasters`** scope
   (write) and a service account with **Full** or **Owner** permission on the property; the read-only sync keeps using
   `webmasters.readonly`. A 403 is shown with that hint (see MANUAL_SETUP.md).
3. **URL Inspection** 2–3 days later (`urlInspection/index:inspect`, read-only scope, within
   `google.urlInspection.dailyLimit` per day): stores verdict, coverage state, last crawl time and Google's chosen
   canonical. Shown as **"Google's last-known state"** — it is a report of Google's index, not a live test.

## Kill switch and limits

- `SEO_SUBMISSION_ENABLED=true|false`; unset → on only when `APP_ENV=production`. Off → each event is logged as
  `skipped` with the reason, nothing is sent.
- Settings → Submission: `indexNow`, `googleSitemap`, `urlInspection`, `inspectionDelayHours`.
- Rate limits: IndexNow one batch per minute; sitemap once per hour per sitemap; URL Inspection daily cap; Google calls
  use v1's backoff with jitter on 429/5xx.
