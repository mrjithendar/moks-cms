# User guide (Admin → User manual, public /user-manual)

The CMS documents itself: guides in plain words, an FAQ, draw.io diagrams and a reference of every setting with its
default. Admins, authors and read-only demo accounts open it from **Admin → User manual** (`/admin/user-manual`); authors see
only the parts about pages they can use. It is searchable (title, text, synonyms), filterable by area and by kind
(Guides, FAQ, Settings), and the address bar keeps the view (`?q=&area=&kind=`).

**Layout (since 2026-11-15).** The manual is a small documentation site of its own, in both copies:

| Page | Admin | Public | What it shows |
|---|---|---|---|
| Home | `/admin/user-manual` | `/user-manual` | Contents tree, search, guides as cards by category, the FAQ, the settings reference |
| An entry | `/admin/user-manual/<id>` | `/user-manual/<id>` | Breadcrumbs, title, who it is for, On this page, the text, diagram, where the page is in the admin, the settings of that page, related entries, previous / next |
| Print | `/admin/user-manual/print` | `/user-manual/print` | The whole manual on one page with a contents list, for printing or saving as a PDF |

- The contents tree (`GuideSidebar`) is rendered on the server and needs no JavaScript: categories are `<details>`,
  the page being read is marked and its category is open. On phones and tablets it folds away under **Contents**.
- `<id>` is the entry's `id` in `src/lib/user-guide.ts`. `print` is reserved (`GUIDE_RESERVED_IDS`); the test fails
  when an id is not a plain slug or collides with a page of the manual.
- Reading order is the order of the contents (`guideReadingOrder`): categories as in `GUIDE_SECTIONS`, in each one its
  guides, then its questions. Previous / next and "Page n of m" follow it.
- **Settings on this page** on an entry are the settings-reference groups whose `href` is the entry's admin page.
  Authors do not get them (as on the home page).
- Printing an entry (`Print / Save as PDF`) or the print page hides the site's and the admin's chrome
  (`GUIDE_PRINT_CSS`, the rule the SEO report page uses). The manual's components therefore use no `<header>` or
  `<footer>` element; `tests/user-guide-pages.test.tsx` checks that.
- Public copy: each guide page is indexable with its own canonical and is in `sitemap.xml`. A question's page is
  `noindex, follow` and not in the sitemap, because the home page already answers it in full (`FAQPage`); the print
  page is `noindex` with the home page as canonical. The home page no longer repeats every guide's full text, so a
  guide's text is on one indexable page only.

**Public guide.** Appearance & settings → General → **Public user manual** (`general.features.publicGuide`, default off)
publishes the same content at `/user-manual`. It shows documentation and **defaults only**, never this site's data or saved
values, and links to admin pages are shown as paths, not links. Off: `/user-manual` is not found.

**Search engines.** While public, `/user-manual` is crawlable (robots.txt allows it), indexable (`index, follow`,
canonical `/user-manual`), listed in `sitemap.xml`, and carries `FAQPage` structured data for the FAQ. The server renders
the whole manual into one cached page (ISR, 300 s); the browser applies `?q=&area=&kind=` after it loads, so every
filtered link shares the one canonical page. Switching it off removes it from the sitemap and makes it 404.

## Where the content lives

| Part | Source | Stays current because |
|---|---|---|
| Guides and FAQ | `src/lib/user-guide.ts` | `tests/user-guide.test.ts`: every admin nav page must be covered by an entry; every entry link must be a real admin route |
| Pages (contents tree, entry page, print page) | `src/components/guide/` (`GuideSidebar.tsx`, `GuideArticle.tsx`, `parts.tsx`, `GuideBrowser.tsx`), routes `src/app/admin/user-manual/` and `src/app/user-manual/` | `tests/user-guide-pages.test.tsx` renders them; `tests/user-guide.test.ts` "pages of the manual" checks ids, contents, neighbours and related entries |
| Settings: Automation & AI (SEO agent) | generated from `DEFAULT_SEO_SETTINGS` + `settings-meta.ts` help | generated: a new SEO setting appears automatically |
| Settings: Advanced settings | generated from `runtime-settings.ts` `GROUPS` | generated |
| Settings: MCP scopes | generated from `mcp-oauth/oauth.ts` `SCOPES` | generated |
| Settings: Appearance, Integrations, Storage & email | hand-written rows in `src/lib/user-guide-settings.ts` | the test fails when a form label in those pages is not mentioned |
| Diagrams | `docs/guide/diagrams/*.drawio` → `public/guide/*.drawio.svg` | the test fails when an entry names a diagram whose source or SVG is missing |

## Diagrams

Edit a `.drawio` source in draw.io (desktop app or app.diagrams.net), then run `scripts/export-guide-diagrams.sh`. The
exported SVGs embed their diagram, so they can be opened in draw.io too. Keep labels as plain text with explicit line
breaks (no HTML labels, no word wrap): the SVGs then contain only vector text (about 20 KB each) instead of PNG
fallbacks.

## When you change the product

Add, change or remove the matching guide entry, FAQ, setting row or diagram in the same pull request (AGENTS.md rule 16).
Run `npx vitest run tests/user-guide.test.ts`: its failure message names what is missing.
