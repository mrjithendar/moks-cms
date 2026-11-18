# Internal linking (v2 Phase 4)

Internal links are added **automatically into drafts** and reviewed like any other change — nothing is linked on the
live site until you approve the article's draft. The planner is deterministic and rule-based
(`src/lib/seo-intel/internal-links.ts`); Claude never writes links (a validator rejects any it tries to add).

## The rules as shipped (Settings → Internal linking)

| Setting | Default | Meaning |
|---|---|---|
| `maxNewPerDraft` | **3** | New links per article per draft. |
| `wordsPerLink` | **250** | Total internal links (existing + new) ≤ 1 per 250 words of prose (code excluded). An article already at or over the cap gets **no** new links. |
| `minWordsBetween` | **100** | Words between two new links. |
| `maxInboundPerTargetPerRun` | **5** | New inbound links to one target per rolling 7 days (all open, scheduled and published drafts count). |
| `minRelevance` | **0.12** | Cut-off for the relevance score below. |
| `anchorMinWords` / `anchorMaxWords` | **2 / 6** | Anchor length. |
| `enabled` | on | Off = no link changes at all. |

Always (not configurable):

- One link per target per article; a target the article already links to is skipped.
- Targets are published, indexable, self-canonical articles only: never itself, drafts, scheduled posts, `noindex`,
  pages canonicalised elsewhere, or anything that does not exist (so no 404s and no redirects — targets are current
  canonical paths).
- Never inside headings, code blocks, tables, paragraphs that contain an image (captions), the article's first
  sentence, existing links, inline code, raw HTML or bare URLs. A short paragraph (< 400 characters) that already has
  an internal link gets no second one.
- **Anchors are phrases that already exist in the paragraph** — no sentence is ever inserted to hold a link. The phrase
  must occur exactly once in its paragraph, not span emphasis or line breaks, and must not be an exact anchor another
  article already uses for the same target (anchor diversity across the site).

## Relevance and priority

`relevance = 0.55 × TF-IDF cosine (title ×3, headings ×2, body) + 0.25 × shared Search Console queries (Jaccard, top 15
per page, last 28 days) + 0.10 × same category + 0.10 × shared tags`. There is no embedding store in the stack (v1
D-13), so TF-IDF is the semantic signal.

Preferred (added to the score after the cut-off, so they never let an irrelevant page through):

- **Tutorial path**: the previous/next part of a series (`…-part-1`, `…-part-2`) +0.15; an earlier article in the same
  category whose subject the source mentions ("likely prerequisite") +0.05.
- **Orphan rescue**: targets with zero inbound links are tried first (+0.10), still within every limit above.

Anchor candidates for a target are its title's 2–6-word runs (not starting or ending with a stop word) and its top
search queries, longest first.

## Reviewing

- Each link is one numbered change in the draft (`internal_link`), showing the anchor highlighted as "linked → /path"
  and a rationale listing the signals (similarity, shared queries, category, series/prerequisite, orphan).
- **Admin → SEO → Internal linking** lists pending link changes across drafts (accept/reject there or in the draft),
  orphans, over-linked articles, and a per-article inbound/outbound/words/cap table.

## Tuning

- Too few suggestions: lower `minRelevance` (0.08–0.10) or `minWordsBetween`; raise `maxNewPerDraft` only for long
  articles (the density cap still applies).
- Too many / too generic: raise `minRelevance` (0.18–0.25); lower `maxInboundPerTargetPerRun` to spread links.
- One page attracting links: `maxInboundPerTargetPerRun` is the brake; rejected link changes do not count.

## Automatic publishing (owner decision 2026-11-10)

A weekly web-app job, `auto_links` (Settings `links.auto`: default Tuesday 09:00 UTC), publishes link changes **without
review**. It runs in both orchestrator modes. It is deliberately not aggressive:

| Setting (`links.auto`) | Default | Meaning |
|---|---|---|
| `enabled` | on | Off = no automatic link updates (manual drafts still work). |
| `maxArticlesPerRun` | **5** | Articles updated per weekly run, least recently auto-linked first. |
| `maxExternalPerArticle` | **2** | New official-docs links per article; none if the article already has that many external links. 0 = off. |
| `cooldownDays` | **30** | An article is left alone this long after an automatic update. |

- Internal links use the planner and every limit above. External links come only from the curated official-docs
  allowlist in `src/lib/seo-intel/external-links.ts` (first mention of a tool, in prose, never in headings, code, captions,
  the first sentence or a paragraph that already has a link). The validator rejects any other external target.
- An article is skipped while it has an open draft or unsaved editor changes, or if it was edited in the last 24 hours.
- Each run records an ordinary draft (`trigger = auto_links`, every change accepted) and publishes it through
  `autoPublishLinkDraft`. That function refuses anything except rules-made `internal_link`/`external_link` changes.
  Publishing uses the same CMS update path, live verification, alert and **one-click rollback** as an approved draft.
  It acts as the earliest admin account and is labelled `auto-links (<email>)` in the audit log.

## Rendering

Every link in an article, page or news body opens in a new tab (announced to screen readers), except in-page `#` links.
Every external link is `rel="nofollow noopener"` (`src/lib/mdx/link-rel.ts`). Links to jithendar.com stay followed.

## Keyword links (your keyword → URL list)

SEO › Internal linking › **Keyword links**. Each entry is a phrase (whole words; case-insensitive unless "Match case")
and a target: a site path (must be a published, indexable post or page) or an `https://` URL (rendered nofollow).
Only a keyword's **first** mention in an article is linked, and only if that mention is in eligible prose (never headings,
code, captions, the first sentence, a paragraph that already has a link). Keywords take priority over automatic related
and docs links. They are used by the weekly auto-linker and by the editor's suggestions, within the same budgets.
Code: `src/lib/seo-intel/link-keywords.ts`; planners run in order in `link-plan.ts`.

## Link suggestions in the editor

Post editor › **Link suggestions** (admins). Click "Suggest links" to get suggestions for the text as it is now,
unsaved edits included: your keywords, related articles (up to 8) and official docs (up to 5). "Insert link" wraps the
existing words on the server (`POST /api/admin/seo/link-suggestions/apply`, validated like a draft change) and reloads
the editor. Nothing is saved until you save the post.

## Broken-link checker

A weekly job, `link_check` (Settings `links.check`: default Wednesday 04:00 UTC; "Check links now" on the page), checks
every link in published posts and pages, once per distinct URL:

| Status | Meaning |
|---|---|
| ok | Works. External links are re-checked after `recheckDays` (7). |
| redirect | Works through a redirect (site redirect table, or the external site). Listed under "Moved links". |
| broken | 404/410, or a site path that is no post, page, app route or redirect. |
| blocked | 401/403/429: the site refuses checkers. Not counted as broken. |
| error | Timeout, 5xx or DNS failure. Counted as broken after **two failed runs in a row**. |

External links are fetched through the guarded fetcher (`publicFetcher`). It refuses private addresses on every hop,
caps each response at 64 KB and allows `maxExternalPerRun` (400) external URLs per run; the rest wait for the next run.
**Fix** (posts): "Replace" or "Unlink" (keeps the text), or "Update to new URL" for moved links. Each fix is a `link_fix`
draft change approved at once by the admin who clicked, so it gets the usual live check and one-click rollback. A post
with another open SEO draft must be finished first. Fix pages in the page editor.
