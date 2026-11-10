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
