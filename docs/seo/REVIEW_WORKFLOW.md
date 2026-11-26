# Reviewing Claude's drafts (admin guide)

Claude turns recommendations into **drafts**: lists of small, separate changes to an article. Nothing goes live until
you approve that article. This guide covers the review queue and the diff view; both work on a phone.

## Where drafts come from

| Source | When |
|---|---|
| Weekly batch | Settings → Drafts → weekly (default Tuesday 04:00 UTC), the top 20 articles by recommendation priority. Uses the cheaper Message Batches API; results arrive within about an hour. |
| "Draft with Claude" | Button on an article's SEO panel. Runs right away (synchronous API). |
| "Fix with Claude" | In Content optimization, on any fixable issue behind a number. |
| "Draft optimization" | On a row in Keyword opportunities: uses that query as the evidence. |

Only categories you allow are drafted automatically (Settings → Drafts → `autoEligible`): title/meta, striking-distance
expansion, freshness, internal links, alt text, FAQ/headings. New-article drafts are **off** by default. News articles
have their own, narrower list (title/meta, alt text, links). A recommendation you approve is drafted even if its
category is not auto-eligible.

One article has at most one open draft. A new recommendation for it is **merged** into that draft as extra changes;
"Regenerate" replaces the pending changes (it never stacks a second draft). If someone edits the article in the
editor, the draft is superseded on the next run because its "before" text no longer matches.

## The queue — Admin → SEO → Review queue

- Tabs: **Articles**, **News**, **Published** (history).
- Each card: article, categories, number of changes and a breakdown ("3 edits · 2 links · 1 meta"), priority, the main
  evidence, when it was generated and an estimated review time.
- Filter by type, priority and age; sorted by priority. Select several to **reject** them together. There is no bulk
  approve: each article is approved on its own page.
- "Needs credentials" at the top means `ANTHROPIC_API_KEY` is not set; a red banner means the monthly budget is
  reached and drafting is paused (existing drafts can still be reviewed).
- A weekly digest email lists what is waiting, once Settings → Drafts → digest recipients are set and email is
  configured (Admin → Settings → Email).

## The diff view

- **Summary bar** (stays at the top): total changes, counts by type, +words / −words, links added, metadata fields,
  and the live counter "5 of 7 accepted".
- **Layout**: Auto (inline on phones, side by side on wide screens), Inline, or Side by side.
- **Highlighting**: prose is compared as rendered text, word by word — green = added, red strike-through = removed;
  a phrase that only becomes a link is shown as "linked → /path". Code blocks are compared line by line. Title and
  meta are compared as fields, with a desktop + mobile **search-result preview** showing where Google would cut them.
- Every change is numbered (1/7, 2/7 …). **j / k** (or the ↑ ↓ buttons, or swiping a card left/right on a phone) move
  between changes; **a** accepts, **x** rejects.
- **Why this change** expands the rationale and the evidence it rests on (Search Console numbers, audit findings,
  cited sources).
- **Flags**: "Needs fact check" (new versions or commands without a cited source), "Check" (lengths, large rewrites),
  "Blocks approval" (duplicate title, link density, conflicts) — an accepted change with a blocking flag must be edited
  or rejected before you can publish.
- **Edit** lets you rewrite the proposed text; saving accepts your version (it is stored as yours).
- **Preview final page** opens the article exactly as it will be published, with only the accepted changes.

## Approving

- **Approve & publish** shows what will happen, then on confirm:
  1. the accepted changes are saved as a new revision through the editor's normal update (your permissions apply;
     rejected and undecided changes are left out);
  2. the "Updated" date and the sitemap's `lastmod` move only if body text changed (not for title/meta/links/alt);
  3. the page, sitemap and listings are refreshed;
  4. about 40 seconds later the live page is checked: HTTP 200, self-canonical, not noindex, the expected title, valid
     JSON-LD. If a check fails, **nothing is submitted**, you get an alert, and the page offers a one-click rollback;
  5. it is submitted to search engines (IndexNow; Search Console sitemap resubmission; a URL Inspection check about
     2–3 days later). Submission is a crawl hint, not an indexing guarantee (SUBMISSION.md);
  6. clicks/impressions are recorded as a baseline and compared at +28 and +56 days.
- **Publish later**: pick a time; it publishes then, as you (only if you are still an admin).
- **Reject draft**: optionally say why; the reason is kept to improve future drafts.
- Approval is refused if the article changed since the draft was made, if you have unsaved editor changes for it,
  or if nothing is accepted.

## Rolling back

On a published draft, **Roll back this change** restores the body, search title, meta description and updated date
from before the draft, as a new revision (history is kept), then verifies and submits again. If the article was edited
after the draft went live, use the editor's revision history instead.

## Every action is logged

Admin → Audit log, actions `seo.draft.*`, `seo.submission.*`, `post.update` (reason `seo-draft` / `seo-rollback`).
