# Progress log — jithendar.com

## Admin menu: a submenu for every area, Newsroom and AI room apart, Storage and Email apart, stronger edges (2026-11-18, owner request)

The owner found the admin hard on the eyes (white on white, fields that looked like text) and the menu's groups
confusing (an "AI newsroom" holding the SEO agent, a "Storage & email" page).

- **Menu (`src/lib/admin-menu.ts`, `src/components/admin/AdminNav.tsx`):** every group opens a submenu, even one with
  a single page. Beside the page (from `md`, 768 px: tablets too, was `lg`) a group opens as a panel beside the sidebar
  on hover (closes 200 ms after the pointer leaves) or click, one at a time; nothing expands inside the sidebar. The
  group holding the current page is highlighted. Pinned pages stay listed. On a phone groups expand in place, as before.
- **Groups:** Dashboard, Posts, Editorial (calendar, review queue, promotion), Media, Pages, Newsroom (the news desk's
  seven pages), AI room (Automation & AI, ML models, LanceDB, MCP access), SEO & insights, Community (comments,
  messages, bookings), Billing, Practice, Appearance, Users, Settings (General, Integrations, Storage, Email, Advanced),
  System (System status, Backups, Database, Data sync, Audit log).
- **Email has its own page** (`/admin/email`; `EmailSettings.tsx` and `email-actions.ts` moved from `storage/`).
  `/admin/storage` is storage only. Every "Storage & email" mention points to the right one.
- **Edges:** inside the admin shell, `--line` is slate-300, `--line-strong` slate-400, the canvas slate-100 (dark mode:
  stronger translucent lines); cards have a light shadow. Editorial calendar fields have visible borders and labels.
- User guide (`src/lib/user-guide.ts`, `user-guide-settings.ts`, `GuideBrowser.tsx`) describes the new menu and pages.
- Tests: `tests/admin-nav.test.tsx` (21: panels on tablet/desktop, hover with delayed close, phone accordion, pins,
  narrow menu), `tests/seo-admin-css.test.ts` (the `md:` overrides), `tests/user-guide.test.ts`.
- Commands (Node 26): `eslint` on the changed files pass; `tsc --noEmit` pass; `vitest run` 1253 passed, 1 skipped;
  `next build` pass. Checked in Chrome (Playwright) against a local build with a throwaway PGlite database: desktop
  hover panel, tablet (820 px) panel, phone accordion, no horizontal scroll at 390 px.
- No new dependency. No migration.

## Posts pushed as MDX files through the API (2026-11-16, owner request, phase 2 of 3)

Second part of the request in the next entry. A site's CI could send a post only with `npm run push-post`, which
needs a checkout of this repository, Node and a YAML parser: the site repository has none of them since the split on
2026-11-16. The API now takes the file itself.

- **`PUT /api/v1/posts/by-path/<collection>/<slug>[.mdx]`** (scope `posts:draft` or `posts:write`): the body is the
  MDX file. The server parses the frontmatter and validates it with the editor's checks (`src/lib/post-files.ts`).
  A new slug becomes a **draft**; a draft or a post in review is updated; a published, scheduled, archived or trashed
  post is skipped. `?mode=create` never changes an existing post. `?live=1` with a `posts:write` key updates the
  content of a live post (never its status or date), as `push-post --update-live` does. Owner decision: CI pushes
  drafts only, so it holds a `posts:draft` key and does not use `live`.
- **Idempotent:** a post that already holds what the file says answers `unchanged` and nothing is written (no new
  revision). The comparison ignores jsonb key order and compares `updatedAt` as an instant.
- An author's key is kept to the author's own posts (`409` for a slug another author holds).
- `scripts/push-post.ts`: the hint for an image that is not on the site now names the images API.
- The "one push command" of the plan is a small script in the **site** repository (phase 3), because that is where
  it runs: it needs only an HTTP client. Nothing changes in how `push-post` works.
- Files: `src/lib/post-files.ts` (new), `src/app/api/v1/posts/by-path/[collection]/[slug]/route.ts` (new),
  `scripts/push-post.ts`, `src/app/admin/api-keys/page.tsx`, user guide (`src/lib/user-guide.ts`), `docs/EDITOR.md`.
- Tests: `tests/post-files.test.ts` (create, update, unchanged, create-only, live posts, trash, invalid files, keys
  and ownership, the comparison).
- No new dependency. No migration.
- Commands: **not run locally** (no `node_modules`, no package installs); `lint`, `typecheck`, `test` and `build` ran
  in CI on pull request #119 (`ci-moks-cms.yml` run 43917913695, commit `40d45ac`): `lint` pass, `typecheck` pass,
  `build` pass, image built and smoke-tested, `test` 1231 passed and 1 skipped over the three shards
  (`tests/post-files.test.ts`: 9 passed; `tests/push-post.test.ts`: 6 passed). Checked locally: the new files
  transpile (Bun).
- Delivery: #119 was stacked on the phase 1 branch and was merged into that branch 42 seconds after #118 had been
  squash-merged, so it never reached `master`. The same two commits were put on top of `master` and reach it through
  #120; release `pr-118` holds phase 1 only.
- Manual steps: none here. Phase 3 needs a `posts:draft` key and an `images:write` key as secrets of the site
  repository.

## Site images in R2, PNG stored as lossless WebP (2026-11-16, owner request, phase 1 of 3)

Owner request: "add png compression and store images in r2 instead of copy; make push mode to update content; content
should store in db and images should store in r2". Content is already in Postgres (the MDX files in the content image
are only an import path), so the work is images and the push. Owner decisions on 2026-11-16: PNG → WebP; a push from
git creates and updates **drafts only** (published posts are edited in the admin); delivered as pull requests.
Plan: (1) this change, site images in R2; (2) one push command for images and posts; (3) in `moks-tech/jithendar.com`,
push instead of the content image, then remove the init container. Full description in `docs/SITE_IMAGES.md`.

- **`PUT /api/v1/images/<path>`** stores a site image (`/images/…`) in R2 under `jithendar/www/site-images/` and
  records it in the new table `site_image`. New API key scope **`images:write`**, which only an admin can create.
  The type is read from the bytes and must match the file name; 5 MB, 12,000 px a side. SVG is accepted (these files
  come from the site's repository) unless it holds a `<script>`, an event handler attribute or a `javascript:` link.
  The same bytes pushed again change nothing. `GET /api/v1/images` lists paths with the SHA-256 of each pushed file.
- **PNG → lossless WebP** when smaller (sharp, already a dependency): the same pixels, 25.2 MB → 12.9 MB for the 88
  PNGs of jithendar.com (measured with libwebp). Lossy quality 90 saved only three points more, so it was not used.
- **URLs and content do not change.** Content keeps the `.png` path; `resolveImage()` gives pages the stored `.webp`;
  the `.png` URL still answers with a PNG made from the WebP, so `og:image`, the image sitemap, JSON-LD, feeds and old
  links get a PNG. No post body is rewritten and no redirect is added (the owner had accepted both; neither is needed).
- **Disk still wins.** `/images/…` files in `public/images/` are served and resolved exactly as before; R2 is used
  only for a path that is not on disk. So this change alone alters nothing for readers.
- **Serving** (`src/app/images/[...path]/route.ts`): through the site (no third-party request), `ETag` + `304`, the
  same `Cache-Control` as files on disk, sandboxing CSP, and up to 32 MB of bodies kept in memory per pod.
- The editor's image picker lists site images in R2 next to those on disk; the social card reads them too.
- Files: `src/db/migrations/0033_site_image.sql` (+ rollback), `src/db/schema.ts`, `src/lib/site-images.ts` (new),
  `src/app/api/v1/images/route.ts`, `src/app/api/v1/images/[...path]/route.ts`, `src/app/images/[...path]/route.ts`
  (new), `src/app/api/v1/_lib.ts` (`bodyBytes`), `src/lib/api-keys.ts`, `src/lib/media.ts`,
  `src/lib/site-config/image-bytes.ts`, `src/app/admin/_actions/shared.ts`, `src/app/admin/api-keys/*`, user guide
  (`src/lib/user-guide.ts`: API keys entry, one question), `docs/SITE_IMAGES.md` (new), `docs/EDITOR.md`,
  `docs/MEDIA.md`.
- Tests: `tests/site-images.test.ts` (paths, conversion with identical pixels, both URLs, ETag, replacement,
  JPEG and SVG, refused files, URL clashes, scopes and roles, the list, `resolveImage()`, the social card).
- No new dependency.
- Commands: **not run locally.** The environment has no `node_modules` and cannot install packages, so `npm run lint`,
  `typecheck`, `test` and `build` ran in CI on pull request #118 (`ci-moks-cms.yml` run 43916775375, commit `babbb7a`):
  `lint` pass, `typecheck` pass, `build` pass, image built and smoke-tested, `test` 1222 passed and 1 skipped over the
  three shards (`tests/site-images.test.ts`: 20 passed). `schema-contract` (run 43916775067) applied every migration,
  `0033_site_image.sql` included, to PostgreSQL 18: pass. Checked locally: every new or changed file transpiles (Bun),
  and the path, SVG, ETag and body-cache logic of `site-images.ts` passes with its imports stubbed (Bun test runner,
  3 tests, 26 assertions). The size figures come from converting the site's real PNGs with libwebp (Pillow), not with
  sharp. Not checked anywhere: a real R2 bucket (the tests use the in-memory stand-in, `tests/fake-r2.ts`).
- Open: no delete through the API (an image removed from the repository stays in R2); the in-memory body cache is per
  pod and has no metric.
- Manual steps: none for this change. For the site: an `images:write` key (Admin → API keys) and R2 configured
  (Admin → Storage), then phases 2 and 3.

## Invoices: send to a client, paid through a Razorpay link, PDF stored in R2 (2026-11-15, owner request)

Owner request: "admin can send invoices from admin login to clients and client can pay using razorpay link; all
invoices are downloadable and stored in R2". Full description in `docs/INVOICES.md`.

- **Admin → Invoices** (new menu item under Community; admins only, hidden from demo accounts): list with counts and
  amounts owed per currency, filters (drafts, unpaid, overdue, paid, void), New invoice, an invoice page, Settings.
- **Flow:** draft → Send → sent → paid, or void. Send gives the next number (`INV-2026-0007`, one sequence per prefix
  and year in `invoice_counter`, never skipped or reused), stores the PDF in R2, creates a Razorpay **payment link**
  for exactly the total and emails the client `/invoice/<token>`. Nothing holds a database transaction open across a
  network call; a send that fails before "sent" leaves a draft (keeping its number) and removes what it made in R2 and
  Razorpay.
- **Client page** `/invoice/<token>` (no sign-in; 32 random bytes): the invoice, Pay (Razorpay), Download PDF, Print.
  Never cached, never indexed, the token is kept out of the logs, and the path stays up in maintenance mode.
- **Paid** is recorded once by the first of: webhook `payment_link.paid` (amount and currency must match), the signed
  address Razorpay returns the client to, or an admin's "Mark as paid" (bank transfer; the link is cancelled first, and
  an online payment found at that moment wins). `payment_link.cancelled` / `.expired` take the Pay button away until
  "Create a payment link".
- **PDF** written by hand in `src/lib/invoice-pdf.ts` (no PDF dependency added: rule 15): A4, built-in Helvetica,
  several pages, clickable link. Stored at `jithendar/www/invoices/{year}/{id}/{random}.pdf`, rendered again on paid /
  void. Admin and client downloads serve the stored object; a missing one is rendered and stored again.
- Money is integers throughout (`src/lib/invoice-math.ts`); the form's live totals use the same functions as the server.
- Also: `loggedPath` now covers `/invoice/<token>` and route error lines use it (`http-errors.ts`); "invoice" is a
  reserved page slug; audit actions `invoice.*` are `notice`; StatusPill has `sent`, `overdue`, `void`.
- Files: `src/db/migrations/0032_invoices.sql` (+ rollback), `src/db/schema.ts`, `src/lib/invoice-math.ts`,
  `src/lib/invoice-pdf.ts`, `src/lib/invoices.ts`, `src/lib/razorpay.ts` (webhook branch, return-address signature),
  `src/app/admin/invoices/**`, `src/app/api/admin/invoices/[id]/pdf/route.ts`, `src/app/invoice/[token]/**`,
  `src/components/invoice/InvoiceSheet.tsx`, `src/proxy.ts`, `next.config.ts`, `src/lib/request-log.ts`,
  `src/lib/http-errors.ts`, `src/lib/site-config/maintenance.ts`, `src/lib/site-pages.ts`, `src/lib/audit.ts`,
  `src/lib/runtime-settings.ts` (Razorpay help text), `src/app/admin/layout.tsx` (menu), `src/components/admin/ui.tsx`,
  user guide (`src/lib/user-guide.ts`: article and three questions; `src/lib/user-guide-settings.ts`: Invoice settings;
  `GuideBrowser.tsx`), `docs/INVOICES.md`, `docs/HIRE_ME.md`.
- Tests: `tests/invoices.test.ts` (drafts, numbering, send and its failures, webhook, return address, mark paid, void,
  link renewal, client link, PDF storage, audit), `tests/invoice-pdf.test.ts` (arithmetic, encoding, PDF structure,
  paging); additions to `indexing`, `sign-out`, `tracing-config` and `user-guide` tests.
- Commands: `tests/invoice-pdf.test.ts` was run locally with Bun's test runner (11 passed), not with vitest, and the
  sample PDFs were checked with `qpdf --check` and by eye (rendered with `pdftoppm`). **Everything else was not run
  locally:** the environment has no `node_modules` and cannot install packages, so `npm run lint`, `typecheck`, `test`
  (including `tests/invoices.test.ts`) and `build` ran only in CI on the pull request; see its checks.
- **Not verified against the real services:** no Razorpay account or R2 bucket was available. The Payment Links
  request, the webhook payloads and the return-address signature follow Razorpay's documentation and are tested
  against a stand-in. Try it with `rzp_test_` keys first (`docs/INVOICES.md`, last section).
- Manual steps: Invoices → Settings (business name is required to send); on the Razorpay webhook switch on
  `payment_link.paid`, `payment_link.cancelled`, `payment_link.expired`; mention invoices and Razorpay in the privacy
  policy and terms if they do not already cover billing.
- Open: one tax line only (no split CGST/SGST, no tax-inclusive prices), no discounts, credit notes, partial payments
  or recurring invoices; refunds are made in Razorpay and do not change the invoice; invoices are not in the content
  backup; the look of the admin and client pages has not been seen in a browser.

## Restore keeps what hangs off posts and never grants roles from a backup file (2026-11-15, owner request after a repository review)

Two defects in `restoreStoredBackup` (`src/lib/backups.ts`), found in a review of the repository.

- **Data outside the backup was deleted.** A restore deleted every `post` and `category` row and inserted the backup's
  rows. Six SEO tables reference `post` with ON DELETE CASCADE and are not in a backup (`seo_drafts`,
  `seo_content_audits`, `seo_article_optimizations`, `seo_internal_link_suggestions`, `seo_ml_related_articles`,
  `seo_promo_opportunities`), four more with ON DELETE SET NULL, and `news_topics` references `category`: every restore
  emptied or unlinked all of them. Posts and categories are now updated in place (`KEEP_ROWS`); only rows the backup
  does not have are deleted. Kept posts get a placeholder slug first, so two posts that traded slugs since the backup
  do not collide on the unique `collection + slug` index while they are updated one by one.
- **Roles came from the file.** Missing accounts were recreated with the `role` in the backup's `user` rows, and a plain
  zip is accepted even with encryption on, so anyone who can write to the backup bucket could plant an admin and set
  its password with “Forgot password”. Recreated accounts are now always readers. `RestoreResult.rolesNotRestored`
  counts those that were staff in the backup; the success message says so and the `backup.restore` audit entry names
  them.
- Files: `src/lib/backups.ts`, `src/app/admin/backups/page.tsx` (success message), `src/lib/user-guide.ts` (Backups
  article), `tests/security-admin.test.ts` (three new restore tests), `docs/MEDIA.md`.
- Commands: **not run locally.** The environment this was written in has no `node_modules` and cannot install packages
  (and has Node 22, not ≥ 24), so `npm run lint`, `typecheck`, `test` and `build` ran only in CI on the pull request;
  see its checks.
- Open: SEO rows of a kept post are not rolled back with it (a draft made after the backup stays next to the older
  text). `media` is still deleted and inserted again, so `image_generation.media_id` (ON DELETE SET NULL) loses its
  link on a restore. A plain zip is still accepted while encryption is on (older backups need that).

## Admin menu reorganised: one entry per area, icons, filter, pins, a narrow menu (2026-11-15, owner request)

First step of the admin UI plan the owner approved ("inspire from WordPress … reorganise admin menu"). Described in
`docs/ADMIN_MENU.md`.

- The sidebar's 8 categories with 43 links are now 14 entries, each with an icon: Dashboard, Posts, Media, Pages,
  Comments, Inbox, Billing, AI newsroom, SEO & insights (Traffic / Content / Authority & health), Practice,
  Appearance, Users, Tools, Settings. An entry with one page is a link; the others open and close. **No address
  changed.** Billing is one more entry than the approved list: it holds Payments, and Invoices from the invoices pull
  request, which did not exist when the list was agreed.
- New in the menu: Posts → Add new, Pages → Add new, and the sections of Appearance & settings people look for by name
  (Menus, Homepage, Typography & colours, Settings → General). The Appearance editor now follows a link to another of
  its sections while it is open (`AppearanceEditor.tsx`).
- **Filter menu** (every word typed; Enter opens the first match), **pins** (the star beside a page; listed first),
  **Collapse menu** (icons only on large screens; an icon opens its pages in a panel beside it). The user manual is
  **Help** at the foot of the menu.
- `src/lib/admin-menu.ts` decides where each page sits; `src/app/admin/layout.tsx` still decides who may see it and
  counts the badges. A page the menu file does not know shows under its old category instead of disappearing.
- The narrow menu and the pins are kept in a cookie (`admin_nav`, path `/admin`) that the layout reads, so the sidebar
  does not jump after a page loads; which entries are open stays in `localStorage`.
- Removed: "Expand all / Collapse all" (the filter replaces it).
- Files: `src/lib/admin-menu.ts` (new), `src/components/admin/AdminNav.tsx` (rewritten: `AdminSidebar`),
  `src/components/admin/menu-icons.tsx` (new), `src/app/admin/layout.tsx`, `src/app/admin/appearance/AppearanceEditor.tsx`,
  `src/lib/user-guide.ts` (tour of the admin; "Where did a page go?"), `tests/admin-nav.test.tsx` (rewritten),
  `docs/ADMIN_MENU.md`.
- Commands: **not run locally** (no `node_modules`, packages cannot be installed): `npm run lint`, `typecheck`, `test`
  and `build` ran only in CI on the pull request; see its checks. The icons were rendered to an image and looked at.
- **Not seen in a browser.** Spacing, the panel's position beside an icon and the phone layout need a look after
  deploying; the classes follow what the old sidebar and other admin components already use.
- Open: the menu's top bar, admin-wide search (Ctrl/Cmd K) and the Help link's final place come with step 3 of the
  plan; "Widgets" under Appearance with step 6.

## User manual: in the admin, optionally public, searchable, with draw.io diagrams (2026-11-15, owner request)

Owner request: a user manual for admins and read-only demo users after sign-in, searchable and filterable by category,
with an FAQ, draw.io diagrams, every setting and option explained in simple words (SEO agent, AI/ML, integrations, MCP,
the executor, CrewAI), optionally public and indexable, and kept up to date as features change. Details: [USER_GUIDE.md](USER_GUIDE.md).

- **Admin → User manual** (`/admin/user-manual`, first item under Overview; the demo banner links to it): 42 guides and
  29 FAQ in plain words across 9 categories, 8 draw.io diagrams, and a settings reference (every setting with what it does
  and its default). Authors see only the parts about pages they can open.
- **Search and filters:** type-ahead suggestions (Enter or a click jumps to the entry and opens it), `/` to focus search,
  kind chips (All, Guides, FAQ, Settings) and category chips with live counts; the address bar keeps the view.
- **Public:** Appearance & settings → General → **Public user manual** (`general.features.publicGuide`, default off)
  serves the same content at `/user-manual`: ISR, canonical, `index, follow`, in `sitemap.xml`, `FAQPage` JSON-LD.
  Off: 404 and not in the sitemap. `user-manual` is a reserved page slug.
- **Settings reference:** Automation & AI (SEO agent), Advanced settings and MCP scopes are generated from the code
  registries; Appearance, Integrations and Storage & email are hand-written with the exact form labels.
- **Kept current:** `tests/user-guide.test.ts` fails when an admin menu page, a form label, an SEO/Advanced setting,
  an MCP scope or a diagram is not covered, or when the manual links to a removed page. AGENTS.md rule 16 makes
  updating the manual part of every feature change.
- **Diagrams:** sources `docs/guide/diagrams/*.drawio`, exported by `scripts/export-guide-diagrams.sh` to
  `public/guide/*.drawio.svg` (editable in draw.io; plain-text labels keep each SVG ~20 KB).
- Files: `src/lib/user-guide.ts`, `src/lib/user-guide-settings.ts`, `src/components/guide/GuideBrowser.tsx`,
  `src/app/admin/user-manual/page.tsx`, `src/app/user-manual/page.tsx` (all new); `src/app/admin/layout.tsx`,
  `src/app/admin/appearance/panels.tsx`, `src/lib/site-config/schema.ts`, `src/lib/settings.ts`, `src/lib/site-pages.ts`,
  `src/lib/seo/sitemap.ts`; tests `tests/user-guide.test.ts` (new), `tests/sitemap.test.ts`, `tests/discussions.test.ts`;
  docs `docs/USER_GUIDE.md` (new), `AGENTS.md`.
- Commands: `tsc --noEmit` pass; eslint on changed files pass; `npm test` 97 files / 1179 tests pass (1 skipped);
  `next build` (APP_ENV=production) pass: `/user-manual` static with 5 min revalidation, `/admin/user-manual` dynamic.

## User manual as a documentation site: contents tree, one page per entry, print (2026-11-15, owner request)

Owner request: "improve user manual like enterprise software". Four parts were agreed, as phased pull requests: this
layout, then task-based articles, reference pages (roles and permissions, glossary, troubleshooting, what's new) and a
Help link on every admin page. This is the first. Details: [USER_GUIDE.md → Layout](USER_GUIDE.md).
(This entry sits below the one it continues, not at the top, so that it merges cleanly next to a backup-restore fix
that adds an entry at the top at the same time.)

- **One page per entry.** `/admin/user-manual/<id>` and, while the manual is public, `/user-manual/<id>`: breadcrumbs,
  title, who the page is for, "Page n of m", an On this page list, the text and diagram, where the page is in the
  admin, the settings of that page (the settings-reference groups with the same `href`), related entries, previous and
  next in reading order.
- **Contents tree** beside every page of the manual (`GuideSidebar`): categories as `<details>`, no JavaScript, the
  current page marked and its category open; folds away under Contents below the `lg` breakpoint.
- **Home page**: guides are cards by category that link to their pages (title and summary only; a search shows one
  ranked list). The FAQ and the settings reference stay on the home page. A type-ahead suggestion opens the entry's page.
- **Print**: `Print / Save as PDF` on an entry, and `/…/print`, the whole manual on one page with a contents list. Print
  hides the site's and the admin's chrome with the rule the SEO report page uses.
- **Search engines** (public copy): guide pages are indexable, self-canonical and in `sitemap.xml`; question pages are
  `noindex, follow` (the home page answers them in full, with `FAQPage` data); the print page is `noindex` with the
  home page as canonical. Guide text is no longer repeated on the home page.
- Files: `src/lib/user-guide.ts` (bases, `guideToc`, `guideReadingOrder`, `guideNeighbours`, `guideRelated`,
  `sameAdminPage`; the "Using this manual" entry), `src/components/guide/` (`parts.tsx`, `GuideSidebar.tsx`,
  `GuideArticle.tsx` new; `GuideBrowser.tsx`), `src/app/admin/user-manual/` (`page.tsx`, `[id]/page.tsx`,
  `print/page.tsx`), `src/app/user-manual/` (the same three), `src/lib/seo/sitemap.ts`, `tests/user-guide.test.ts`,
  `tests/user-guide-pages.test.tsx` (new), `tests/sitemap.test.ts`, `docs/USER_GUIDE.md`.
- Commands: **not run locally.** The environment this was written in has no `node_modules` and cannot install packages
  (and has Node 22, not ≥ 24), so `npm run lint`, `typecheck`, `test` and `build` ran only in CI on the pull request;
  see its checks. **Nobody has looked at the pages in a browser yet**: the layout was written against the existing
  design tokens and component patterns, and the owner checks how it looks.
- Open: printing in dark mode keeps the dark theme's text colours on the article (the admin shell is forced white).

## Read-only demo accounts with email invitations (2026-11-14, owner request)

Owner request: demo users who see what an admin sees but cannot edit anything, as many as needed, invited by email.
Details: [AUTH.md → Demo accounts](AUTH.md#demo-accounts-read-only-for-product-demonstrations).

- New stored role `demo`. The proxy stamps the request method; `getSessionUser()` makes a demo account an admin on
  GET/HEAD and a non-staff `demo` on every write, so all existing role checks refuse its writes (`lib/demo.ts`).
- Admin → Users: **Invite demo users** form (email, optional name), Demo option in the role picker, **Resend invite**.
  Invitation email with a 72-hour set-password link; `/reset-password?invite=demo` wording.
- Admin shell shows a read-only banner and a "demo" badge. Backup download refused (route + hidden links); comments
  refused; friendly read-only messages from the editor, `seoRoute` APIs and server actions.
- Fix found on the way: role changes and bans now end sessions through Better Auth, so they also reach sessions held
  in Redis (previously only the Postgres session rows were deleted).
- Files: `src/lib/demo.ts` (new), `src/lib/session.ts`, `src/lib/auth.ts`, `src/lib/users.ts`, `src/lib/admin.ts`,
  `src/lib/comments.ts`, `src/lib/comment-types.ts`, `src/lib/seo-intel/http.ts`, `src/proxy.ts`,
  `src/app/admin/layout.tsx`, `src/app/admin/users/page.tsx`, `src/app/admin/backups/page.tsx`,
  `src/app/api/admin/backup/route.ts`, `src/app/reset-password/{page,ResetPasswordForm}.tsx`,
  `src/components/AccountMenu.tsx`, `tests/demo-users.test.ts` (new), `docs/AUTH.md`.
- Commands: `tsc --noEmit` pass; eslint on changed files pass; `npm test` 96 files / 1168 tests pass (1 skipped);
  `npm run build` could not run in this worktree (`node_modules` is a symlink outside the Turbopack root).
- Open: a demo account sees real personal data (users, messages, bookings, comments). Masking it is not built.

**Manual configuration required:** email must be set up (Admin → Storage & email) before invites can be sent.

## Admin MCP tools and agent skills for AI visibility, rankings and backlinks (2026-11-14, owner request)

Fourth part of "add what is worth taking from open-seo": its MCP tools and agent skills, on this site's admin MCP.

- `/mcp/admin` (seo:read, read-only): `get_ai_visibility`, `get_ai_prompt_answers(prompt_id)`, `get_tracked_keywords`,
  `get_backlinks`; prompt `ai_visibility_review`. Prompts, AI answers and source titles are returned as
  `untrusted_content`. Web side: data views `ai-visibility`, `ai-prompt`, `tracked-keywords`, `backlinks`
  (`callbacks-v4.ts`). No new write path; the approval boundary test still covers every tool.
- Agent skills in `.claude/skills/`: `seo-weekly-review`, `ai-visibility-review`, `keyword-research`,
  `backlink-review` (read and suggest; ask before any flow).

## AI visibility: are ChatGPT, Claude, Perplexity, Gemini and Google AI Overviews citing the site? (2026-11-14, owner request)

Third part of "add what is worth taking from open-seo". Details: [seo/AI_VISIBILITY.md](seo/AI_VISIBILITY.md).

- Weekly job `ai_visibility` (web worker; Run now): every active prompt goes to every enabled, configured assistant
  with web search on. Answers, cited sources, cited rank and name mentions are stored per prompt, assistant and day
  (`0031_seo_ai_visibility.sql`, additive, manual rollback).
- Claude through the Anthropic SDK (`web_search_20260209`, server-side refusal fallback, exact cost from usage);
  ChatGPT (Responses API), Perplexity (Sonar) and Gemini (Search grounding) over HTTPS; Google AI Overview through
  DataForSEO. Each is off until switched on and its key (and, for ChatGPT/Gemini, model id) is set.
- Admin → AI visibility: cited share per assistant with a weekly trend, prompt × assistant grid, prompts no assistant
  cites (Send to editorial calendar), domains cited instead, per-prompt answer history. Prompts by hand or from
  question-like Search Console queries.
- Off by default; monthly cap $10 across assistants, checked before each call. `scripts/set-ai-visibility-config.sh`.

**Manual configuration required:** keys for the assistants beyond Claude; switch on in Settings.

## DataForSEO: volume, keyword difficulty, live ranks and backlinks (2026-11-14, owner request)

Second part of "add what is worth taking from open-seo". Search Console cannot give search volume, difficulty, rankings
for keywords without impressions, or backlinks; DataForSEO (pay as you go) can. Details: [seo/DATAFORSEO.md](seo/DATAFORSEO.md).

- New jobs (web worker, like `keywords_refresh`; no CronJobs): `dataforseo_keywords` (daily, only stale queries),
  `serp_ranks` (weekly, tracked keywords), `backlinks` (weekly, off by default: separate DataForSEO subscription).
- Keywords: **Volume** and **KD** columns (sortable, in the CSV). Tracked keywords: live Google position, AI Overview
  flag, top results, volume/KD, and a form to track any keyword. New **Backlinks** page (gained/lost referring domains).
  Integrations: DataForSEO status, month spend and Run now.
- Settings → Data sources → DataForSEO: off by default; market (location 2840 US, language en), monthly cap $5.
  Spend is DataForSEO's returned `cost`, summed per month from `seo_sync_jobs.detail.costUsd`; a run stops before a
  request that would cross the cap.
- Migration `0030_seo_dataforseo.sql` (four new tables; additive), manual rollback file. `scripts/set-dataforseo-config.sh`.

**Manual configuration required:** a DataForSEO account with funds; `scripts/set-dataforseo-config.sh`; switch on in
Settings. Backlinks also need DataForSEO's Backlinks subscription.

## AI crawlers, llms.txt and seven new technical checks (2026-11-14, owner request)

Owner request: add what is worth taking from open-seo (github.com/every-app/open-seo, MIT). This first part covers
crawler access and the technical audit.

- **robots.txt**: one explicit group per AI crawler (`src/lib/seo/ai-crawlers.ts`): answer engines (OAI-SearchBot,
  ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User) and training crawlers (GPTBot, ClaudeBot,
  Google-Extended, Applebot-Extended, CCBot, meta-externalagent). Policy per site: `aiCrawlers` in `site.json`
  (`search` / `training`, `allow` or `block`). All three sites are set to allow both, so what crawlers may fetch is
  unchanged.
- **/llms.txt** (llmstxt.org): published, indexable, self-canonical articles by category, with the public MCP server
  when `PUBLIC_MCP_ENABLED` is on (`src/lib/seo/llms.ts`, `src/app/llms.txt/route.ts`).
- **Technical audit** (`technical.ts`), new checks: `ai_crawlers` (robots.txt against the policy, then the home page
  requested with each allowed crawler's User-Agent; a 401/403/429/503 or a bot-challenge page means a CDN or firewall
  rule turns it away), `thin_content` (< 300 words of main text), `js_rendering` (< 50 words and scripts: text needs
  JavaScript), `slow_response` (≥ 1.5 s info, ≥ 3 s warning), `dead_end` (no internal links), `click_depth` (> 3 clicks
  from home), `title_length` and `description_length`. The fetcher now records `elapsedMs` and can send another
  User-Agent.
- The live AI-crawler request comes from this server, not from the vendors' addresses: a block there is a strong hint
  that Cloudflare's AI-crawler or bot settings turn crawlers away, not proof.

Commands: `npx vitest run tests/seo-ai-crawlers.test.ts tests/seo-intel-technical.test.ts tests/indexing.test.ts`
(69 passed); full lint/typecheck/test results in the pull request.

## deploy.sh removed; the deploy workflow applies everything (2026-11-14, owner request)

Owner request: "Remove deploy.sh, whatever it is doing can you do it via workflow." Delivered as a pull request from a
cloud session (branch `ci/deploy-via-workflow`; nothing merged, nothing applied to the cluster).

**What deploy.sh did, and where it is now**

| deploy.sh step | Now |
|---|---|
| Check three Secrets exist | Dropped: CI cannot read Secrets. A missing one shows as a failed rollout |
| `kubectl apply -k minikube --dry-run=server`, then apply | `deploy-minikube.yml`, on merge and on manual runs. New: the site group is applied in full (`scripts/ci-app-manifests.py --all`), not only its application objects |
| Restart the site on `:latest`, wait | Manual run: input `restart_site` (default on). On merge the image workflow already restarts it |
| `scripts/smoke.sh` | Unchanged step; now also runs when another workload failed to roll out |

**Decisions (asked, owner chose)**
- *Privileged objects (Namespace, ServiceAccounts, RBAC including CI's own, mesh policies):* "apply all on merge",
  over a manual-run job or keeping a kubectl command. This reverses the rule "a commit cannot widen CI's own access";
  the consequences are written in DEPLOYMENT.md ("What moved from a person to CI") and in the header of
  `minikube/85-ci-applier.yaml`.
- *seo-agent group:* CI now applies its application objects on merge (it was hand-applied only); CronJobs stay manual.
- Kept out of CI without being asked, to limit the new reach: Secrets (so the applier gets no Secret access), and the
  ClusterRole/ClusterRoleBinding (cluster-wide RBAC). `scripts/setup-ci-applier.sh` applies those.
- New: when a group's ConfigMap changed, the workflow restarts that group's Deployments (pods read it at start).

**Files.** Removed `deploy.sh`. Changed `.github/workflows/deploy-minikube.yml`, `scripts/ci-app-manifests.py`
(`--all`), `minikube/85-ci-applier.yaml` (wider Role, new ClusterRole for the Namespace object),
`scripts/setup-ci-applier.sh` (new can/cannot checks, three groups), `ci-repo.yml`, `ci-jithendar-com.yml` and
`dependabot.yml` (comments, shellcheck list), `scripts/tests/kube-context.test.sh`, `setup-practice-runner.sh`, and
the references in `README.md`, `minikube/`, `AGENTS.md`, DEPLOYMENT.md and five other docs. Published articles and
their diagram sources that describe `deploy.sh` are unchanged (they describe the repository as it was).

**Commands run → result**
- `scripts/ci-app-manifests.py` on the three groups (site rendered by concatenating the kustomization's files;
  no `kubectl` in the sandbox): site `--all` 20 objects applied, 4 left (2 token Secrets, ClusterRole,
  ClusterRoleBinding); seo-agent 7 applied, 15 CronJobs left; practice-executor unchanged (7 / 11). A Namespace other
  than `jithendar`, an object in another namespace and an unknown kind each stop the run (exit 2). Pass.
- The workflow's apply script against a **stub** `kubectl`, five cases (ConfigMap changed on merge, manual run,
  nothing changed, old Role → "forbidden", one workload not ready). Pass. This checks the script's logic only.
- `bash -n` on the workflow's three scripts and the changed shell scripts; the workflow file parses as YAML. Pass.
- **Not run:** anything against the cluster. `kubectl diff`'s header format (used to spot a changed ConfigMap) and the
  new RBAC rules are untested on mk4. `shellcheck` and the kube-context test run in CI on the pull request.

**Open issues**
- The deploy job has failed on recent merges because `deployment/practice-executor-api` and
  `deployment/practice-dispatcher` are past their progress deadline in the cluster (runs of 2026-11-13). The site part
  applied. Not caused or fixed here; it will keep the job red until those Deployments are healthy.

**Manual steps required (owner), in this order**
1. Before or right after merging: from this branch, `KUBE_CONTEXT=mk4 scripts/setup-ci-applier.sh`. It applies the
   wider Role and the ClusterRole (CI cannot grant itself these) and re-tests the token. Until then the deploy job
   stops at the server dry run with "forbidden" and changes nothing.
2. If the merge ran before step 1: Actions → deploy to minikube → Run workflow.

## In-article image and video generation, automatic drafts, pull-request-only CI (2026-11-12, owner request)

Delivered as a pull request from a cloud session (branch `feat/editor-generation-pr-ci`, owner approved pushing a
branch for review; nothing merged).

- **Automatic drafts**: the "Import as draft" list on Admin → Posts is gone. `syncBundledPosts()` (`lib/bundled-posts.ts`,
  called from `instrumentation.ts`) turns new `content/{blog,news,projects}/*.mdx` files into drafts at server start.
  Ledger table `bundled_import` (migration 0027): each file once, so permanently deleted posts stay deleted. The first
  start after this release also records every existing post's file.
- **Generate in the article**: toolbar buttons and `/generate` slash commands in `BlockEditor.tsx`; the prompt is built
  from the selection or the current section (`inlinePrompt`).
- **Video generation**: `lib/video-generation.ts`, routes under `/api/admin/videos/`, `GenerateVideoDialog.tsx`,
  `::video{loop="true"}` (GIF-style). `image_generation` gained `kind`, `operation`, `duration_seconds`; image limits
  now count images only. Settings group "Video generation" in Advanced settings; `.env.example` updated.
- **Video destinations** (owner request, same day): `lib/video-destinations.ts` sends an inserted clip to this site's
  media library (R2), Cloudflare Stream, Mux or Bunny Stream. Each is switched on or off in Advanced settings → Video
  destinations; the dialog lists only enabled, fully configured ones. External players are whitelisted in `embedUrl()`;
  `::embed` gained `ratio`. `image_generation` gained `destination`, `external_id` (same migration 0027).
- **Members-only articles** (owner request, same day): per-post switch and preview percentage (editor → Access), site
  default in Advanced settings (`MEMBERS_PREVIEW_PERCENT`, 30). Migration 0028 (`post.members_only`,
  `post.preview_percent`), `lib/members.ts`, `components/MembersGate.tsx`, `app/_actions/members.tsx`; JSON-LD and the
  public Ask index respect it. See `docs/EDITOR.md`.
- **CI**: `ci-jithendar-com.yml`, `ci-seo-agent.yml`, `ci-practice-executor.yml`, `deploy-minikube.yml`,
  `grafana-dashboards.yml`, `ci-repo.yml` no longer have a `push` trigger. Images are built only when a pull request is
  merged into `master`, tagged `pr-<number>` and `latest`. `ci-content.yml` is unchanged (owner instruction);
  `infra.yml` is unchanged too (see open issues).

**Commands run → result**
| Command | Result |
|---|---|
| `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` | **Not run.** The session could not install dependencies (no package registry access). They run in `check` on the pull request |
| Syntax-only compile of the changed TypeScript files (no dependencies) | No syntax errors |
| YAML parse of every workflow | Pass |
| A real Veo generation | **Not run.** No Gemini key; tests use canned provider responses |

**Open issues**
- Video generation **requires manual configuration** (`GEMINI_VIDEO_MODEL`) and one real generation to confirm the API
  shapes and the parameters the chosen model accepts.
- `infra.yml` still applies Terraform on push to `master`: its `aws-infra` environment is restricted to the `master`
  branch, and a `pull_request` run may not satisfy that rule. Decide whether to move it to the merged-pull-request trigger.
- The cluster still runs `:latest` (manifests, CronJobs and sandbox pods name it); `pr-<number>` is the same image kept
  for rollbacks.
- Cloudflare Stream, Mux and Bunny Stream **require manual configuration** and one real upload each to confirm the API
  shapes and the players' loop options. Videos sent there are not listed or deletable in Admin → Media, Uploaded videos
  sent to a service also keep their copy in the media library (`lib/video-publish.ts`).
- Members-only: search engines index only the preview (the full text is not served to crawlers). Comments under a
  gated article stay visible to everyone. Signed-in readers see the sign-in prompt for a moment while the rest loads.
- Generated images and videos from the editor carry no embedded AI-provenance metadata (the news desk's covers do).
- A pull request that changes only `minikube/seo-agent-*.yaml` or `minikube/practice-executor-*.yaml` still rebuilds
  that image on merge (the site workflow skips such merges through its `scope` job).

## Paid calls with Razorpay on /hire-me (2026-11-12, owner request)

"Make payment and book call; price based on minutes, per-minute rate from Admin → Hire me"; "from India INR, all
other countries USD". Details in `docs/HIRE_ME.md` → *Paid calls (Razorpay)*. Left uncommitted (A3.12).

- **Config** `hireMe.paidCall` (off by default; existing stored configs get it from the defaults): rates per minute in
  INR and USD, min/max/step minutes, title, summary, booking link. Validation: both rates and a booking link when on.
- **Server** `src/lib/razorpay.ts`: order creation (amount computed on the server; currency from `CF-IPCountry`),
  Checkout signature check, webhook handler, admin list. Actions `src/app/_actions/payments.ts`; route
  `src/app/api/razorpay/webhook/route.ts`; keys in Advanced settings (`runtime-settings.ts`, group `razorpay`).
- **DB** `hire_payment` — migration `0026_hire_payment.sql` + rollback (applied automatically on start).
- **UI** `src/components/hire/PaidCall.tsx` (section + hero link on /hire-me, only when on); Admin → Payments
  (`src/app/admin/payments/page.tsx`, nav entry); Paid calls panel and `AmountField` (exact decimal input) in Appearance.
- No new dependencies (Razorpay REST API via `fetch`, Checkout script loaded on click).

| Command | Result |
|---|---|
| `npx vitest run tests/razorpay.test.ts` (new, 10 tests) + hire-me + calcom | pass (48/48) |
| `npm test` | pass: 81 files, 964 tests, 1 skipped |
| `npm run typecheck` | pass |
| `eslint` on changed files | pass (no output) |
| `npm run build` | pass (`/api/razorpay/webhook`, `/admin/payments` built) |
| Real Razorpay payment (test or live) | **Not run** — no keys; requires manual configuration |

**Manual steps (owner):** Razorpay keys + webhook in Advanced settings; enable International payments for USD; set
rates and switch on in Appearance → Hire me; test with `rzp_test_` keys first; update privacy policy and terms.

## Site review fixes (2026-11-12, owner request "review jithendar.com and find gaps", then "fix everything")

Review of the live site, this repo and the cluster; changes left uncommitted (A3.12). Branch `fix/site-review`.

- **Password reset** (open since the auth phase: reset emails pointed nowhere): `/forgot-password` (Turnstile, same answer
  whether or not the address exists) and `/reset-password` (token from Better Auth's redirect; invalid/expired link
  explained). "Forgot password?" on the sign-in form only when mail is configured. A reset revokes every session.
- **Email verification**: required for email+password sign-in **only while mail can be sent** (`mailConfigured()`);
  saving the email settings rebuilds the auth instance on every replica (`broadcastInvalidate("integrations")`).
  Sign-up then shows "check your email"; an unverified sign-in resends the link. Migration
  `0025_grandfather_email_verified.sql` marks existing accounts verified so nobody (the admin included) is locked out.
- **Icons**: `public/favicon.ico` (16/32/48), `apple-touch-icon.png` (180, opaque), `icon-192/512.png`, all rendered
  from `src/app/icon.svg`; in `public/` so a favicon uploaded in Admin → Branding still wins. `app/manifest.ts`.
- **/hire-me** share image (its own `openGraph` dropped the default) and `summary_large_image` card.
- **`/.well-known/security.txt`** (RFC 9116): Contact = /contact, Expires always 360 days ahead.
- **404**: one robots tag (`noindex, follow`) instead of Next's `noindex` plus the layout's `index, follow`.
- **robots.txt** no longer names /argocd, /vault, /db, … (it only advertised them). Deploy **after** Cloudflare Access
  is enforced (miniKube `docs/cloudflare-access-and-db-backups.md`), which answers crawlers there with a login or 403.
- **Deployment** (`minikube/30-jithendar-com.yaml`): topology spread now `DoNotSchedule` with `matchLabelKeys:
  [pod-template-hash]` and `nodeTaintsPolicy: Honor` (both replicas had landed on worker3; one node = full outage);
  memory limit 1Gi → 1536Mi (pods used 780–874Mi). `kubectl apply --dry-run=server` passed.

- **Admin backups as zip, encryption optional** (owner request "enable backups in r2 in zip file and encryption is
  optional"): each backup is `jithendar-backup-{stamp}.zip` with `backup.json` and an unencrypted `README.txt`. New
  switch *Encrypt backups* (Admin → Backups, default on, also for settings saved before it existed): on, `backup.json`
  is WinZip AES-256 with the passphrase (verified opening with `bsdtar --passphrase`; plain zip with `unzip`); off, a
  plain zip and no passphrase needed. Turning it off keeps the passphrase for older backups. Legacy `.json.gz.enc`
  backups are still listed, downloaded and restored. New dependency `@zip.js/zip.js@2.24.0` (BSD-3, no dependencies):
  Node has no AES zip writer. `docs/MEDIA.md` updated.

**Not changed, needs the owner:** HSTS `includeSubDomains` (deliberately left out in `next.config.ts`; every live
subdomain is HTTPS, `db.jithendar.com` is a dangling record); the About page description (served from the database,
Admin → Pages, not `content/pages/about.mdx`); a script-src Content-Security-Policy (AdSense, GA4, Cal.com, Turnstile
need a tested allowlist); the news sitemap is empty only because nothing was published in the last 48 h.

**Commands → result** (Node 26.13): `npm run lint` pass; `npm run typecheck` pass; `npm test` 951 passed, 1 skipped
(new `tests/site-review.test.ts`; updated `tests/indexing.test.ts`, `admin-ops.test.ts`, `security-admin.test.ts`); `npm run build` pass (one pre-existing Edge
Runtime warning in `src/lib/request-log.ts`).

## One CMS (D-86) follow-up: last /admin/seo links (2026-11-11, owner request "merge SEO dashboard and CMS in 1")

Reviewed master after `6cb34e1` (D-86: SEO pages in `app/admin/(growth)`, one sidebar, SEO overview in the Dashboard,
GSC/GA4 in Integrations, per-post insights at `/admin/posts/{id}/insights`, old `/admin/seo/*` URLs redirect). The web
app had no remaining `/admin/seo` page links. Fixed what still pointed at the old area:

- seo-agent: review links in MCP results and emails → `/admin/review/{id}`; MCP `service_documentation_url` →
  `/admin/automation/mcp`; sync `runs_url` → `/admin/sync`; docstrings (`review.py`, `mcp/admin.py`, `seo_data.py`,
  `tests/test_mcp.py`).
- docs/seo: ARCHITECTURE, FLOWS, MANUAL_SETUP, OPERATIONS, SECURITY use the new paths; PLAN.md marked historical.
  DECISIONS.md and PROGRESS.md keep their history.

**Commands → result** (master `6cb34e1` + this change): www `npm run lint`, `npm run typecheck` pass, `npm test` 934
passed, 1 skipped, `next build` pass (merged routes `/admin/calendar`, `/admin/review`, `/admin/automation`,
`/admin/posts/[id]/insights`; `/admin/seo/[[...rest]]` only redirects). seo-agent ruff, mypy pass, pytest 367 passed,
19 skipped (Postgres tests need a database). GitHub CI on master: green for #43 and `6cb34e1`.

## Cal.com integration for Hire me (2026-11-11, owner request "integrate cal.com to schedule meeting")

- Pop-up scheduling: `BookingLink` opens Cal.com's embed (`Cal("modal", {calLink, calOrigin, config})`, API checked
  against `app.cal.com/embed/embed.js` on 2026-11-11) for cal.com links or a configured self-hosted Cal.com; script loaded
  on the first click only; blocked script → booking page; GA4 `booking_completed` via `bookingSuccessfulV2`. Config:
  `hireMe.embedBooking` (default on), `hireMe.calOrigin`.
- Webhook `POST /api/cal/webhook` (`src/lib/calcom.ts`): HMAC-SHA256 `X-Cal-Signature-256` with `CAL_WEBHOOK_SECRET`
  (Advanced settings → Cal.com bookings, encrypted); `cal_booking` table (migration 0024 + rollback); Admin → Bookings.
- Privacy policy source: Cal.com scheduler, the booking copy kept here, deletion on request.

**Commands → result**: `npm test` 917 passed, 1 skipped; lint, typecheck pass; new `tests/calcom.test.ts` (20 tests) (link parsing, signature, created / repeated /
rescheduled / cancelled / ping / bad JSON / oversized, upcoming vs past, the route, migration + rollback). `next build`
pass (`/hire-me` ○, `/api/cal/webhook` and `/admin/bookings` ƒ). Standalone build + Playwright through the proxy: no
Cal.com request before the click; click → `embed.js` and the `rick/get-rick-rolled` scheduler (Cal.com's public demo)
open in a pop-up on /hire-me; with Cal.com blocked the click navigates to the booking page.

**Manual**: Cal.com webhook + secret (docs/HIRE_ME.md "Cal.com integration"); live privacy policy text in Admin → Pages.

## Hire me page: consulting, freelance, speaking, mentoring (2026-11-11, owner request)

`/hire-me` with availability, four offers (prices and Cal.com links from the admin), production highlights, selected
work, skills, experience, process and an enquiry form; a call to action at the end of articles. See `docs/HIRE_ME.md`.

- Config: `hireMe` section in the site configuration (`src/lib/site-config/schema.ts`, defaults: page on, all prices 0 =
  "On request", no booking links); Admin → Appearance → Hire me (`HireMePanel`). Stored configs get the defaults via
  `mergeKnown`; no config migration.
- Résumé facts in `src/config/hire-me-profile.ts` (owner's résumé, 2026-11-11); phone, personal email and CV download
  left out; Terraform Associate left out (dated June 2026).
- Enquiries: `submitEnquiry` + `enquiryInput` (`src/lib/contact.ts`), migration `0023_contact_enquiry.sql` (+ rollback),
  Admin → Messages "Enquiries" filter with kind badge and details, `[Kind]` email subjects; shared hourly limits.
- UI: `src/app/hire-me/page.tsx` (ISR 300 s), `src/components/hire/{EnquiryForm,BookingLink,HireCta,track}`;
  sitemap entry while enabled; `/hire-me` in the link checker's static routes; privacy policy source updated.

**Commands → result**: `npm test` 897 passed, 1 skipped (incl. new `tests/hire-me.test.ts`, 17 tests); `npm run lint`,
`npm run typecheck`, `next build` pass (`/hire-me` ○ 5m/1d). Standalone build against PostgreSQL 18: 200, `s-maxage=300`,
JSON-LD and sitemap entry present; Playwright (iPhone 13 + 1280 px): no horizontal overflow, no page errors, "Enquire" on
Mentoring preselects Mentoring, budget only for consulting/freelance; article call to action rendered.

**Manual**: Cal.com links and prices in the panel; header button/menu; privacy policy bullet in Admin → Pages.

## Article: caching, SSG, ISR and image optimisation (2026-11-11, owner request)

`content/blog/caching-isr-ssg-image-optimisation-nextjs.mdx` (`status: review`, 15 min by `readingTimeMinutes`): the
caching layers of the site from browser to database, SSG vs ISR vs dynamic rendering, the cross-replica ISR cache, the
warm-up, image optimisation with measured sizes, metrics, trade-offs and a checklist. Six draw.io figures
(`docs/knowledge-sharing/caching-web-performance/diagrams/`: `.drawio` sources, `build_diagrams.py`, `render_png.py`;
SVG + PNG in `public/images/caching-web-performance/`). Notes and facts to re-check:
`docs/knowledge-sharing/caching-web-performance/README.md`.

**Commands → result**: `build_diagrams.py` (label-fit and page-bounds checks pass), `render_png.py` (PNGs inspected by
eye; overlaps fixed); `npx vitest run tests/content.test.ts` 9 passed; `npm test` 880 passed, 1 skipped; `npm run lint` pass. Every source
URL answered 200.

**Manual**: measure live TTFB from a real client; choose the category; decide between this and
`ssg-isr-nextjs-jithendar-com` (or publish both as a series); review, then set `status`/`publishedAt`.

## Page cache tuning (2026-11-11, owner request "finetune caching")

After the SSG + ISR release (#40): measured the live site, then tuned what was still uncached or unbounded.

- Per-article Open Graph images (`blog|news|projects/[slug]/opengraph-image.tsx`): `revalidate = 300` +
  `generateStaticParams() → []`. Local production build: 194 ms per request → 6 ms after the first.
- `news-sitemap.xml`: per request → ISR, `revalidate = 60` (Cache-Control max-age 60, was 600).
- `next.config.ts`: `expireTime: 86400` → `stale-while-revalidate=86100` (was a year); `icon.svg` Cache-Control
  `public, max-age=86400, stale-while-revalidate=604800` (was max-age=0).
- Warm-up also renders `/feed.xml`, `/news/feed.xml`, `/search-index.json`.
- Metrics `jithendar_page_cache_*` and `jithendar_page_warmup*` (lib/metrics.ts `renderPageCache`, `recordPageWarmup`);
  Grafana Overview row "ISR page cache" (hit ratio, cached pages, memory, failed warm-up pages, lookups/s, clears and
  warm-ups).

**Commands → result**: `npm test` 879 passed, 1 skipped; lint, typecheck, `next build` pass (OG images `●`,
news-sitemap `○` 1m/1d); `scripts/check-dashboards.py` OK. Standalone server on PostgreSQL 18: OG MISS 194 ms then HIT
6 ms; news-sitemap HIT; `/blog` sends `s-maxage=300, stale-while-revalidate=86100`; startup warm-up 7 pages incl. feeds;
`/metrics` exposes the new series.

**Not in this repo**: Istio's response compression (EnvoyFilter in the miniKube repo) drops the ETag on compressed
responses, so browsers cannot get 304s for HTML; keeping weak ETags there would save bandwidth on repeat visits.
Live TTFB cannot be measured from the agent sandbox (its HTTPS proxy adds 0.3–0.7 s); measure from a real client.

## SSG + ISR for public pages (2026-11-11, owner request)

Public pages were `force-dynamic` (rendered from Postgres on every request; production TTFB 0.48–1.03 s, `Cache-Control:
private, no-store`), against D-6 "static-first". They are now ISR pages served from an in-memory page cache, cleared on
every replica when anything they show changes. See `docs/CONTENT_MODEL.md` "Rendering and caching (SSG + ISR)".

- `cache-handler.mjs` (+ `.d.mts`): custom `cacheHandler`, `cacheMaxMemorySize: 0`. Generation counter on globalThis, so
  a cache-bus message (outside any request, where `revalidatePath` throws) can clear it; a render that started before a
  clear is not stored; LRU by bytes (`PAGE_CACHE_MAX_MB`, 64). `isrFlushToDisk` removed (no effect with a custom handler).
- `src/lib/page-cache.ts`: clears on bus kinds content/categories/settings/integrations (not practice); imported by
  `instrumentation.ts`. `src/lib/warm.ts` `startPageWarmup`/`warmPages`: renders every sitemap URL after start and 10 s
  after each clear (127.0.0.1, 2 at a time; `PAGE_WARMUP=false`).
- 24 public routes: `revalidate = 300`; dynamic ones `generateStaticParams() → []`. Build: content comes from the bundled
  MDX during `next build` (no database); that output is never served (the handler starts empty).
- Root layout no longer opts every page out: `getSiteConfig()` reads the appearance-preview cookie only in draft mode,
  which `/api/admin/appearance/preview` now enables/disables. Contact form: signed-in check moved to the browser.

**Commands → result**: `npm run lint`, `npm run typecheck`: pass. `npm test`: 873 passed, 1 skipped (new
`tests/page-cache.test.ts`, 39 tests; `site-config.test.ts` mock gains `draftMode`). `next build` (APP_ENV=production, no
database): pass, public routes `○`/`●` with 5m revalidate. Standalone server on PostgreSQL 18: first render 0.49 s, then
cache hits 5–9 ms; startup warm-up renders the sitemap; an edit through `/api/v1/posts` shows on the next request, an
unpublish 404s at once; two replicas over Redis: an edit on one is served fresh by the other on its next request;
draft-mode requests render per request and are not stored.

**Open / manual**: none required. Optional: set `PAGE_CACHE_MAX_MB` if the site grows past ~64 MB of rendered pages.
Direct SQL edits are not seen until 300 s or a pod restart.

**Article**: `content/blog/ssg-isr-nextjs-jithendar-com.mdx` (`status: review`) explains the change; notes and the
facts to re-check in `docs/knowledge-sharing/ssg-isr/README.md`. Manual: deploy, re-measure live TTFB, review, publish.

## Cache bus: cross-replica cache invalidation over the shared Valkey, pub/sub only (2026-11-10, owner request)

Edits now reach both replicas within about a second instead of up to the cache TTL. `src/lib/cache-bus.ts` has its own
publisher and subscriber connections for a new variable, `CACHE_BUS_REDIS_URL` (Secret
`redis-site-cachebus-credentials`, key `uri`, explicit `env` entry with `optional: true`); `REDIS_URL` stays unset, so
sessions, rate limits and API keys stay in Postgres. No data in Valkey: messages are `{kind, origin}`. Valkey down or
unset = TTL-only caches as before; requests never wait on it. 5-minute PING keeps quiet connections inside HAProxy's and
Envoy's 1 h idle timeouts; SUBSCRIBE is redone on every reconnect and retried with backoff if refused.
`getRedis()` is unchanged; the unused `getRedisSubscriber()` is removed. Metrics `cache_bus_{published,received}_total{kind}`,
`cache_bus_errors_total{role}`, `cache_bus_connected{role}`; System status row "Cache bus (Valkey pub/sub)" (never
"down"; `/api/health` does not look at it); alert `CacheBusDisconnected` (warning) in new source
`docs/cache-bus/prometheus-alerts.yml` (added to `scripts/build-alerts.py`); Overview dashboard row "Cache bus & shared
Valkey". Manifests: env entry and an additive NetworkPolicy `jithendar-com-cache-bus` (namespace `redis`, Valkey pods,
pod port 6380 only). Handoff: `docs/redis-site-cachebus.md` (Terraform for the miniKube repo, ACL check, rollback).

- **Files:** `src/lib/{cache-bus,redis,health,metrics}.ts`, `tests/{cache-bus,cache-bus-env,cache-bus-redis,health-redis}.test.ts`,
  `.env.example`, `docs/{redis-site-cachebus,DEPLOYMENT,OBSERVABILITY}.md`, `docs/cache-bus/prometheus-alerts.yml`,
  `docs/seo/alerts-for-minikube-repo.yaml` (regenerated), root `minikube/{30-jithendar-com.yaml,kustomization.yaml,README.md}`,
  `scripts/build-alerts.py`, `services/grafana/jithendar-com-overview.json`. No new dependency (ioredis 6.0.0 was installed).
- **Checked:** `npm run lint` (pass), `npm run typecheck` (pass), `npm test` (73 files passed, 1 skipped; 832 passed,
  1 skipped: the real-server test, which needs its env vars), `npm run build` (pass); `tests/cache-bus-redis.test.ts`
  against a local `redis-server` 8.10.2 with the proposed ACL user and the real ioredis client: 200 invalidations
  p50 1.35 ms, p99 1.54 ms, max 1.82 ms (one process, loopback, ~1 ms polling resolution); back 0.42–0.50 s after
  `CLIENT KILL USER site-cachebus`; with the server down at start, broadcast returned in < 20 ms, 2 warnings in 3 s,
  connected 3.7 s after the server came up. ACL on Redis 8.10.2: WHOAMI, PUBLISH `jithendar:*` allowed; other
  channels, SET/GET/KEYS/SELECT/INFO/CONFIG/FLUSHALL/CLIENT LIST denied. Memory: 2.3 KB per connection (`tot-mem`),
  13 KB `used_memory` for four. `scripts/manifests.sh site | python3 scripts/ci-app-manifests.py` (pass, the new
  NetworkPolicy is a CI-applied kind); `kubectl create --dry-run=client` of the rendered site group with
  `KUBE_CONTEXT=mk4` (pass, all 22 objects); `scripts/build-alerts.py --check` (pass); `scripts/check-dashboards.py` (pass).
- **Read-only on mk4 (2026-11-10):** HAProxy `timeout tunnel 1h` present in `valkey-0`; `maxmemory 512mb`,
  `volatile-lru`; 2 Valkey pods (not 3 as in the article); exporter series present: memory used/max (19 MB / 512 MB),
  evicted keys 0, hits/misses, connected clients (21 + 6), pub/sub channels; no per-ACL-user client series; no
  Postgres exporter.
- **Not checked:** `promtool check rules` (Docker not running locally; CI runs it); Valkey 9.1 itself (ACL and memory
  were measured on Redis 8.10.2); anything on mk4 with the new tenant (needs the miniKube Terraform first);
  the Grafana panels against live Grafana.
- **Phase 5 (rate limits to Valkey): not needed.** `pg_stat_user_tables` for `rate_limit` (read-only, primary
  `postgres-cluster-1`, counters since its start at 2026-11-10 08:55 UTC, about 8 h): 38 inserts, 261 updates (all HOT),
  33 deletes, 5 live and 25 dead tuples, 3 autovacuums, 80 kB. About 41 writes/hour. A week of production data does
  not exist yet (rate limits moved to Postgres on 2026-11-09; no Postgres exporter keeps history). Re-measure after a week.
- **Manual (owner):** the Terraform in `docs/redis-site-cachebus.md` in the miniKube repo, `terraform apply`, check the
  Secret, `KUBE_CONTEXT=mk4 ./deploy.sh`, the ACL check there; copy the regenerated alerts file into the miniKube repo;
  optionally the exporter client-list change described there.
- **Deviations from the brief:** ACL user `site-cachebus` (tenant keys cannot contain `_`, and the key names the Secret);
  `+acl|whoami` added so the requested check works; rule order `-@all` first; `CACHE_BUS_REDIS_URL` falls back to
  `REDIS_URL` when only that is set (keeps the previous behaviour of such setups; production sets neither today).

## Push MDX drafts through the API, no image build (2026-11-06, owner request)

New `scripts/push-post.ts` (`npm run push-post -- <file.mdx>… [--dry-run] [--update-live]`) sends
`content/{blog,news,projects}/*.mdx` to the live site via the existing `/api/v1/posts` (API key with posts:read +
posts:write): new slugs become drafts, drafts/review posts update in place, live posts only with `--update-live`
(status never changes). Never publishes. Refuses posts whose `/images/…` files are not on the site yet. Docs:
`docs/EDITOR.md` "Sending MDX files without a build". `tsx` 4.23.15 pinned as a direct devDependency (it was
already installed through drizzle-kit; lockfile only gains `dev` flags).

- **Checked:** `tests/push-post.test.ts` (5 tests, real API handlers on PGlite: create, update, live skip and
  `--update-live`, dry run, image gate, validation errors); `npm run lint`, `npm run typecheck`, `npm test`
  (45 files, 458 passed), `npm run build` (pass); `--dry-run` against https://jithendar.com for two real articles (no key, so no lookup).
- **Not checked:** a real push to production: needs an API key the owner creates in Admin → API keys.
- **Open:** media upload has no API, so new images still need Admin → Media or a build.

## Grafana dashboards in this repo; k8s/ is now minikube/ (2026-11-04, owner request)

**Dashboards.** New top-level `grafana/` (README, kustomization → ConfigMap `monitoring/grafana-dashboards-jithendar`)
holds the new **Jithendar.com · Observability** dashboard (metrics, logs and traces on one page; requests table from
Loki completion lines → trace panel and trace log lines by trace id) plus Overview and Logs, moved from tools. In
tools: the `grafana` Argo app reads `jithendar.com.git` `grafana/` as a fourth source (project `mk-observability`
allows the repo); Jaeger data source `jaeger` with toggle `jaegerEnableGrpcEndpoint` (Jaeger 2.22 serves only
`/api/v3`; checked live); Loki `TraceID` now opens traces in Grafana; alert `TraceSpansLost` fixed (it errored on
every evaluation, see OBSERVABILITY.md). Check: `scripts/check-dashboards.py`, workflow `grafana-dashboards.yml`.

**Layout.** `k8s/` → `minikube/`, flat: `practice-executor/NN-*.yaml` → `minikube/practice-executor-NN-*.yaml`,
`db-access/*` → `minikube/db-access-NN-*.yaml` + `DB_ACCESS.md`; their kustomizations are gone (one per folder), so
`scripts/manifests.sh site|practice-executor|db-access` prints a group for `kubectl … -f -`. Updated: `deploy.sh`,
all three workflows, setup/enable scripts, dependabot (`/minikube`), docs. Dated entries below keep the old paths.

- **Checked:** every query of the three dashboards against live Prometheus/Loki/Jaeger on mk4 (all parse; empty
  only where the value is really zero), including the escaped route `/blog/[slug]` and an empty trace id; the three
  groups render the same objects as before (34/21/12); `kubectl diff` against mk4: only one blank line in a CEL
  expression of `practice-sandbox-pods` (kustomize had folded it differently); filter script on all groups;
  actionlint, shellcheck; tools `validate.py --external-charts` and pytest (242 passed).
- **Not checked:** the dashboards inside a running Grafana (table transformations, links, trace panel through the
  plugin's `/api/v3` path; the plugin's response types match Jaeger's JSON on reading, but running its code was
  blocked); nothing deployed or synced.

## Database access through code (2026-11-04, owner request)

`deploy-minikube.yml` now also applies `k8s/db-access/` (skipped with a notice until CI's Role has the TCP-route
kinds) and upserts the DNS-only record `db.jithendar.com` via `scripts/cloudflare-dns-record.sh` when secret
`CLOUDFLARE_DNS_TOKEN` exists. Privileged one-time steps (Traefik PROXY protocol, host HAProxy, `jithendar_remote`
login, CI Role update, first run) are `scripts/enable-db-access.sh`, run once from the Mac.

- **Checked:** actionlint, shellcheck on all new scripts; render of all three folders; server dry-run as
  `github-ci-applier` (k8s/ and practice-executor pass; db-access is forbidden for MiddlewareTCP/IngressRouteTCP/
  TLSOption until the Role is re-applied, as designed).
- **Not checked:** the Cloudflare script against the real API (no token here); `enable-db-access.sh` end to end.

## CI deploy of manifests to minikube (2026-11-04, owner request)

New `.github/workflows/deploy-minikube.yml` (existing workflows unchanged): plan on PRs, apply on `master` when
`k8s/**` changes and `MINIKUBE_DEPLOY=true`. Only application kinds in namespace `jithendar`
(`scripts/ci-app-manifests.py`); RBAC, Secrets, ServiceAccounts, quotas and cluster-scoped objects stay manual. New
ServiceAccount `github-ci-applier` (`k8s/85-ci-applier.yaml`, in the kustomization), kubeconfig template
`.github/jithendar-ci-applier.yaml`, setup `scripts/setup-ci-applier.sh`; docs in DEPLOYMENT.md.

- **Checked:** filter on both renders (30 applied, 21 held back, unknown kinds and other namespaces exit 2); server
  dry-run and diff of the exact files with the owner's context (only pending change: `strip-trace-headers`);
  applier RBAC server dry-run; workflow YAML parses; `bash -n` on the setup script.
- **Not checked:** the workflow on GitHub, and the Role as the ServiceAccount itself (it does not exist until
  `scripts/setup-ci-applier.sh` runs; the script dry-runs every object as the ServiceAccount before storing the
  token). actionlint and shellcheck pass on the workflow and setup script.

## Database access from the Mac and the Hetzner host (2026-11-04, owner request)

Adminer at `https://jithendar.com/db/` and PostgreSQL at `db.jithendar.com:443` (a path cannot carry the PostgreSQL
protocol), both IP-allowlisted to 122.177.247.138 and 46.224.38.14. Not applied; order and checks in
`k8s/db-access/README.md`.

- **Found:** Traefik saw every client as `192.168.49.2` (HAProxy TCP forwarding + kube-proxy NodePort SNAT), so IP
  allowlists, site logs and per-IP rate limits all saw one address. Fix in `tools`: Traefik
  `proxyProtocol.trustedIPs: 192.168.49.0/24`, HAProxy `send-proxy-v2` (script refuses to run before Traefik).
- **Files:** `k8s/db-access/` (kustomization, allowlist, adminer, postgres-tls, README), `scripts/create-db-remote-user.sh`,
  `k8s/README.md`; `tools/deploy/minikube/traefik/values.yaml`, `README.md`, `deploy/minikube/expose-ingress.sh`.
- **Checked:** server dry-run of `k8s/db-access` (12 objects); Traefik chart 42.0.0 renders the proxyProtocol flags;
  `bash -n` on both scripts; the role SQL on a throwaway PostgreSQL 17 (create, rotate, read/write, no DDL).
- **Not checked:** PROXY protocol on the live host (no SSH key for root@jithendar.com from this Mac), Traefik's
  PostgreSQL STARTTLS/ALPN handling, Adminer under `/db/` on the real image.

## Observability review + draft article (2026-11-04, owner request)

Reviewed logs, traces and metrics against the live mk4 cluster (read-only), fixed what was verified, and drafted
`content/blog/logging-tracing-observability-jithendar-com.mdx` (`status: review`). Nothing committed or deployed.
Details and runbooks: `docs/OBSERVABILITY.md` ("Review fixes", "Runbooks").

- **App:** `src/lib/tracing-config.ts` (new: sampler without health probes or remote sampling flags, outgoing span
  names `<kind> <METHOD> <host>`, `traceparent` to the practice executor only), `src/instrumentation.ts`,
  `src/lib/request-log.ts` (`isHealthProbe`, `loggedPath`), `src/proxy.ts`; `tests/tracing-config.test.ts`.
- **Cluster manifests:** `k8s/40-middlewares.yaml` (`strip-trace-headers`), `k8s/60-ingress.yaml`, `k8s/README.md`.
- **Executor:** `executor/app/main.py` (trace id on audit lines), `executor/tests/test_executor.py`.
- **tools repo:** Alloy route/outcome patterns (mk4 + EKS copy), collector metrics listener, Jaeger config
  (`jaeger/jaeger.yaml`, `kustomization.yaml`, `max_traces: 5000`, 384Mi), Prometheus jobs and alerts, dashboards,
  observability README runbooks.
- **Figure:** `docs/knowledge-sharing/jithendar-com-observability/diagrams/` (`.drawio`, builder, PNG script) →
  `public/images/jithendar-com-observability/`.
- **Commands:** `lint`, `typecheck` pass; `npm test` 449 passed; `npm run build` passes (after deleting
  `.next/cache/turbopack`); executor pytest 19 passed; tools pytest 241 passed, 4 skipped (the real-collector test
  needs an `otelcol` binary, not run); all alert expressions evaluated on live Prometheus; `kubectl diff -k k8s`
  shows only the middleware and annotation. Local `next start` checks: no spans for `/api/health`, a `-00`
  traceparent still traced, 20/20 requests 200 with the trace endpoint unreachable, reset token redacted.
- **Not validated:** the collector, Jaeger and Alloy configs were not run with their real binaries (running
  downloaded binaries was not permitted); NetworkPolicy enforcement on 9464 was not tested from a denied pod.
- **Open:** `tests/error-handling.test.ts` prints an unhandled PGlite `ENOENT` (`.data/pglite`) when run alone; it
  predates this change. `METRICS_TOKEN` is in the Secret and DEPLOYMENT.md but unused.

## Draft article: Mermaid diagrams on jithendar.com (2026-11-03, owner request)

`content/blog/mermaid-diagrams-on-jithendar-com.mdx`, `status: review`. Explains what Mermaid is, why it suits a technical blog, and how the Mermaid change below was built, with 5 Mermaid diagrams. Nothing published or committed. **Publish only after the Mermaid change is deployed.**

- **Files:** the article; `docs/knowledge-sharing/mermaid-diagrams/README.md` (SEO metadata, sources, validation).
- **Commands:** all 5 diagrams render in headless Chrome with Mermaid 12.2.0, light and dark, no `<script>` in the SVG. `content`, `links` and `editor-workflow` tests: 56 passed (after shortening the description to fit the 160-character limit).
- **Open:** category `devops-sre` is a placeholder.

## Mermaid diagrams in articles (2026-11-03, owner request)

A ```` ```mermaid ```` fence in a post or page now shows as a diagram. Uncommitted, not deployed.

- **How:** the server still sends the Shiki-highlighted source, labelled "Mermaid" (readers without JavaScript and crawlers get the text). In the browser, `MermaidBlock` loads the `mermaid` library with a dynamic import, so only pages with a diagram download it, and draws the SVG with a "Show source" toggle. It follows the site's light/dark theme. `securityLevel: "strict"` sanitises labels and disables click handlers. If the source does not parse, the code block stays as it is.
- **New dependency:** `mermaid` 12.2.0, pinned. Justification: no existing dependency draws diagrams. Rendering on the server instead (`rehype-mermaid`) would need a headless browser in the image and in CI.
- **Files:** `src/components/MermaidBlock.tsx` (new), `src/components/CodeBlock.tsx` (routes `mermaid` fences), `src/app/globals.css` (`.mermaid-diagram`), `src/lib/code-languages.ts` (label), `tests/features.test.tsx` (server output for a mermaid fence), `package.json`, `package-lock.json`.
- **Commands:** `typecheck` passes, `lint` clean, `build` succeeds. `npm test`: 427 passed, 2 failed with 30 s timeouts. The 4 test files that timed out across runs (`api-keys`, `article-route`, `responsive-content`, `setup-action`) pass when run alone (17/17). Both diagrams in `learning-terraform-real-project-tools-repository.mdx` rendered in headless Chrome with Mermaid 12.2.0 and these settings, with no `<script>` in the SVG.
- **Not verified:** a real article page in a browser (no local database here).
- **Open:** the admin editor's preview (`/api/admin/preview` → `src/lib/mdx/html.ts`, an HTML string, not React) still shows the highlighted source, not the diagram.

## Draft article: Learning Python through real projects (2026-11-03, owner request)

`content/blog/python-tutorial-beginners-real-projects.mdx`, `status: review`, written against moks `ef6908a` and roboshop-ai `c81e85a`. Nothing published or committed. No application code changed.

- **Files:** the article, `docs/knowledge-sharing/python-tutorial/` (README with SEO metadata, files used, validation, gaps; `verify_article.py`).
- **Commands:** `verify_article.py` passes (29 verbatim excerpts, 45 example outputs matched, Python 3.11.9). MOKS tests for the quoted code: 51 passed on a throwaway PostgreSQL. `content`, `editor-workflow` and `links` tests pass alone, after two fixes: an indented code line under a list item broke the editor round trip, and `/python-practice` is now plain text because the link checker does not know the route. Full `npm test` had one 30 s timeout in a different unrelated test on each of three runs, while another session was editing `CodeBlock.tsx` and `package.json`. `lint`, `typecheck` and `build` not run: no application code changed.
- **Open:** category is a `devops-sre` placeholder; tracebacks not checked on Python 3.12; gaps listed in the package README.

## Draft article: Advantages of TypeScript over Python and Go (2026-11-04, owner request)

`content/blog/typescript-advantages-over-python-and-go.mdx`, `status: review`, written against jithendar.com `be1287a`. Nothing published or committed. No application code changed.

- **Files:** the article; `docs/knowledge-sharing/typescript-advantages/` (README with SEO metadata, FAQs, internal links, files used, validation, author checks; `examples/`; `verify_examples.py`).
- **Commands:** `verify_examples.py` passes 29 checks (identical output in TypeScript on Node 26.13.0, Python 3.15.2 with Pydantic 2.14.2 and Go 1.27.3; `tsc` 6.0.3 and mypy 2.4.1 `--strict` errors match the article; TypeScript route streams from a FastAPI service; all 12 code blocks match their sources). Front matter passes `collectionSchema("blog")`, editor round trip lossless, `links` test passes, 23 source URLs return 200. Lint, typecheck and build not run: no application code changed.
- **Open:** category `ai-engineering` is a placeholder; FAQs are in the README, not the article body; no Go article exists to link to.

## Draft article: Python vs Go vs TypeScript (2026-11-03, owner request)

`content/blog/python-vs-go-vs-typescript.mdx`, `status: review`, written against roboshop-ai `c81e85a`, jithendar.com `f12f8cc`, moks `74a097d` and tools `387bd30`. Nothing published or committed. No application code changed.

- **Files:** the article; `docs/knowledge-sharing/python-vs-go-vs-typescript/` (README with SEO metadata, files used, validation and limitations; `verify_examples.py`).
- **Commands:** `verify_examples.py` passes (99 programs on CPython 3.11.9, Go 1.27.3 with `-race` and Node 26.13.0 match their `Output:` comments; 1 expected Go compile failure; pytest, `go test -race` and Vitest suites pass; `gofmt`/`go vet` clean; mypy `--strict`; `tsc` 6.0.3 and 7.0.2 strict with `erasableSyntaxOnly`; 10 project excerpts match their commits). RoboShop currency service `go test -race` 8/8. `npx vitest run`: 433 passed. Front matter validated against `articleFrontmatter`. Lint, typecheck and build not run: no application code changed.
- **Open:** category `ai-engineering` is a placeholder; Python examples not run on 3.12+; confirm Mermaid rendering is deployed (one diagram).

## Draft article: Python vs TypeScript (2026-11-03, owner request)

`content/blog/python-vs-typescript.mdx`, `status: review`, written against jithendar.com `dc249e8`, moks `ef6908a` and roboshop-ai `c81e85a`. Nothing published or committed. No application code changed.

- **Files:** the article; `public/images/python-vs-typescript/typescript-python-architecture.svg`; `docs/knowledge-sharing/python-vs-typescript/` (README with SEO metadata, files used, sources, validation and limitations; `verify_examples.py`).
- **Commands:** `verify_examples.py` passes (44 example groups run on CPython 3.11.9 and Node 26.13.0 and match their `Output:` comments; mypy; `tsc` 6.0.3 and 7.0.2, strict, with and without `noUncheckedIndexedAccess`; 9 project excerpts match their commits). `npx vitest run`: 428 passed, 1 `article-route` timeout under load that passes alone (8/8). Lint, typecheck and build not run: no application code changed.
- **Open:** category `ai-engineering` is a placeholder. Python examples were not run on 3.12+ (only 3.11 is installed here). `/python-practice` is linked as an absolute URL because the link checker does not know the route.

## Draft article: Learning TypeScript through jithendar.com (2026-11-03, owner request)

`content/blog/learning-typescript-real-project-jithendar-com.mdx`, `status: review`, written against this repository at `dc249e8`. Nothing published or committed. No application code changed.

- **Files:** the article, `docs/knowledge-sharing/typescript-tutorial/` (README with SEO metadata, files used, validation, gaps; `verify_article.py`).
- **Commands:** `verify_article.py` passes (77 blocks; 36 TS/TSX examples compiled with TypeScript 6.0.3). `npm test` 425 passed in 42 files, after one fix: the editor round trip first failed on a paragraph starting with inline `<p>` code. `npm run typecheck` passes; `npm run lint` is clean. `build` not run: no application code changed, and the MDX compile was checked directly.
- **Open:** category is a `devops-sre` placeholder (no web-development category exists). Six implementation gaps are listed in the package README, including deprecated `React.FormEvent` in 7 files and the link checker not knowing `/python-practice`.

## Python practice platform (2026-11-02, owner request)

`/python-practice`: role-based Python practice and interview preparation, plus a sandboxed code runner. Uncommitted. **Code execution is built but off**: mk4 has no gVisor runtime yet. Docs: `PYTHON_PRACTICE.md`, `PYTHON_PRACTICE_EXECUTOR.md`.

- **Owner decisions:** Postgres instead of the prompt's MongoDB; build the executor for gVisor and ship it switched off; treat prompt sections 1–14 as the full spec (the prompt was cut off in §14); deliver everything in one run.
- **Web (`www/`):** migration `0010_python_practice.sql` and schema; `lib/practice/*` (catalog, seeder, evaluator, submissions, sessions, progress, adaptive, daily, achievements, dashboard, profile/export, admin, settings, AI tutor); `/api/practice/*`; pages under `app/python-practice/`; admin under `app/admin/practice/`; components in `components/practice/`. Small edits: login `?mode=signup`, admin nav, audit severities, cache-bus kind, scheduler sweep, start-up seeding, `next.config.ts` no-store for `/api/practice`.
- **Content:** 20 roles, 57 topics, 100 original problems (`content/python-practice/`). Expected outputs come from running every reference solution through the real runner (`executor/tools/build_problems.py`), which also checked the hand-written expectations: 4 of mine were wrong and are fixed.
- **Executor (`executor/`):** FastAPI API, Redis queue, dispatcher (one gVisor pod per job), sandbox runner, Dockerfiles. Manifests in `k8s/practice-executor/` (separate from `deploy.sh`), NetworkPolicy egress added to `k8s/30-jithendar-com.yaml`, scripts `install-gvisor-mk4.sh`, `verify-practice-sandbox.sh`, `create-practice-executor-secrets.sh`, workflow `ci-practice-executor.yml`.
- **New dependencies:** `codemirror`, `@codemirror/{lang-python,state,view,commands,language}` (Monaco has no mobile support) and `@aws-sdk/client-bedrock-runtime` (Bedrock tutor; same SDK family as S3/SES).

**Commands run → result**
| Command | Result |
|---|---|
| `npm run lint` | pass (clean) |
| `npm run typecheck` | pass |
| `npm test` | pass: 42 files, 423 tests (21 new in `tests/practice.test.ts`) |
| `APP_ENV=production npm run build` | pass |
| `pytest` (executor, scratch venv, Python 3.11) | pass: 17 tests |
| `executor/tools/build_problems.py` | pass: 100 problems, 423 test cases |
| `next dev` smoke test as a guest | pages 200; `/dashboard` → 307 to `/login`; guest API calls → 401 `auth_required`; no solution code in problem HTML |
| `kubectl apply -k k8s/practice-executor --dry-run=server` | RuntimeClass and ValidatingAdmissionPolicy accepted. Namespaced objects not checked: their namespaces don't exist yet |
| Docker image builds (executor, sandbox) | **Not run.** The Docker daemon isn't running on this Mac; CI builds them |
| `install-gvisor-mk4.sh`, `verify-practice-sandbox.sh` | **Not run.** They change cluster nodes, which the owner runs |

**Open issues**
- Hidden tests and solutions of the seed problems are in this public repository: hidden in the product, not secret. Add private hidden tests in the admin where that matters.
- `catalog.generated.json` was generated with Python 3.11; CI regenerates it with 3.13 and fails if anything differs.
- The "practice time" metric is an estimate from activity gaps (definition shown on the dashboard).
- The header menu is admin-configured: add a "Python practice" link in Admin → Appearance.

**Manual configuration required (owner):** the six steps in `PYTHON_PRACTICE_EXECUTOR.md` → "Turning it on" (gVisor on every node, ECR repositories and CI push rights, apply manifests and secrets, verify, site secret, admin switch). The AI tutor needs a provider, model and key in Admin → Python practice → Settings.

## Draft article: FastAPI and FastMCP (2026-11-01, owner request)

`content/blog/fastapi-and-fastmcp-ai-projects.mdx`, `status: review`, four figures, written against `roboshop-ai` c81e85a and `moks` ab99cf7. Nothing published or committed. No application code changed.

- **Files:** the article, `docs/knowledge-sharing/fastapi-fastmcp/` (README, evidence map, editorial checklist, `verify_article.py`, `diagrams/`), `public/images/fastapi-fastmcp/`.
- **Commands:** `npm test` 401 passed; lint clean; `verify_article.py` passes. `typecheck` and `build` not run, because no TypeScript changed.
- **Open:** SVG and PNG files are rendered by `build_diagrams.py`, not exported by draw.io. Published-page discrepancies are listed in `editorial-checklist.md`.

## Draft project page: MOKS (2026-11-01, owner request)

`content/projects/moks.mdx`, `status: review`, checked against moks ab99cf7 and the EKS cluster. Not published or committed. Open items are in the page's `<Todo>`, including `usernamePassword.sh` tracked in the public moks repository and the missing LICENSE. The RoboShop series now uses the `:::figure` directive for captions.

## Draft series: RoboShop AI knowledge sharing (2026-11-01, owner request)

Four review drafts, nine figures and five editable draw.io files, written against `roboshop-ai` c81e85a. Nothing published or committed.

- **Files:** `content/blog/roboshop-ai-{architecture,gateway,mcp-server,shopping-agent}.mdx`, `docs/knowledge-sharing/roboshop-ai/` (README, evidence map, editorial review, `verify_series.py`, `diagrams/`), `public/images/roboshop-ai-series/`.
- **Commands:** `npm test` 399 passed; lint, typecheck and production build pass; `verify_series.py` passes. Details and the service test results are in section 3 of `docs/knowledge-sharing/roboshop-ai/editorial-review.md`.
- **Open:** SVG and PNG files are rendered by `build_diagrams.py`, not exported by draw.io, because the draw.io desktop download was refused by the session's permission policy. The `.drawio` files have not been opened in draw.io. No real model was called. Author decisions are listed in the editorial review.
- **Found:** a visual-editor bug where a paragraph starting "No. " becomes a list item. Not fixed.

## Article update: How We Implemented RAG and Skills in MOKS (2026-11-01, owner request)

**What changed**
- `content/blog/moks-rag-and-skills-design.mdx` rewritten against moks `9c150e9`. Same slug, `status: review`, not published. The live post is in Postgres, so the owner pastes this into the editor.
- Two Mermaid sources in `docs/diagrams/moks-rag-skills/`, rendered with mermaid-cli 11.4.2 to `public/images/moks/moks-rag-{knowledge-flow,skills-runtime}.svg`. The older SVGs stay because the live post uses them.
- `VERIFICATION.md`, `article_trace_test.py`, `trace-summary.txt` and `trace-probes.txt` in the same folder. `docs/CONTENT_AUDIT.md` row 7 marked drafted.

**Commands → result**: `vitest` 395 of 395 passed; article compiled and rendered through `compileMdx`. MOKS backend from a clean export: 835 passed, 3 failed (terminal chart tests), 4 skipped. Lint, typecheck and build not run (content and static assets only).

**Open**: four gaps listed in the article are unfixed in MOKS (citation existence only, freshness labels with no prompt rule, prompt truncation of passages, no knowledge effect in rule-based reports). No MOKS code changed.

## Content audit, Batch 1 (2026-11-01, owner request)

**What changed** (uncommitted, nothing published)
- `docs/CONTENT_AUDIT.md`: inventory, plan, SEO fields, redirects, open questions and validation.
- Rewrote `content/blog/deploy-roboshop-ai-amazon-eks.mdx` and `content/blog/roboshop-ai-microservices.mdx` (which absorbs `-architecture`), both `status: review`.
- Replaced `content/projects/jithendar-com.mdx` with `content/projects/nextjs-site-on-kubernetes.mdx`, matching the live slug.
- New diagrams `roboshop-ai-eks-services.svg` and `roboshop-ai-eks-delivery.svg`, with `.mmd` sources and two functions in `build_diagrams.py`.
- `tests/pages-media.test.ts`: title assertion follows the new article title.

**Commands → result**: `npm test` 394 passed / 1 failed (`article-route` future-post: fixture date 2026-11-01 has passed; unrelated, fails CI until moved); lint, typecheck and production build pass. Full table in `docs/CONTENT_AUDIT.md` section 10.

**Open**: live posts are in PostgreSQL, so approved drafts must be applied in the editor (audit section 6). Owner decisions are in audit section 7. Batches 2 and 3 wait for editorial review.

## Draft article: LangChain vs LangGraph for an SRE agent (2026-11-01, owner request)

**What changed**
- New `content/blog/langchain-vs-langgraph-sre-agent-moks.mdx` (analysis, `status: draft`; not published), written against moks commit `9c150e9`. The requested title changed because MOKS installs `langchain-core`, not `langchain`.
- Two Mermaid diagrams: sources in `docs/diagrams/moks-langgraph/*.mmd`, rendered with mermaid-cli 11.4.2 to `public/images/moks/moks-langgraph-*.svg`.
- `docs/diagrams/moks-langgraph/VERIFICATION.md`, plus the trace test and its output.

**Commands → result**: `vitest` 3 failed / 392 passed; the same 3 fail without this article (`article-route` future-post, `editor-workflow` deploy-roboshop-ai-amazon-eks, `pages-media` bundled posts). A fourth `article-route` test timed out once and passes alone. Lint, typecheck and build not run (content and static assets only).

**Manual steps**: review the `<Todo>`; publish `moks-rag-and-skills-design` first or remove the links to it; set `status`/`publishedAt`.

## Draft article: MOKS RAG and skills design (2026-10-31, owner request)

**What changed**
- New `content/blog/moks-rag-and-skills-design.mdx` (analysis, `status: review`; never published by this change), reviewed against moks commit `9b94516`. Includes the design-questions section the owner wants for interview preparation.
- Four diagrams in `public/images/moks/moks-*.svg`, generated by `docs/diagrams/moks-rag-skills/build_diagrams.py` (stdlib; reuses the RoboShop generator's helpers). This one has no Mermaid copies: the script is the editable source.

**Commands → result**

| Command | Result |
|---|---|
| moks backend `pytest` at `9b94516` (local PostgreSQL 17, Python 3.11) | 829 passed, 4 skipped |
| moks RAG and skills eval gates | all pass; recall@5 1.0 on 11 synthetic documents, keyword mode |
| `npm test` | pass (41 files, 394 tests) |
| `npm run lint` / `npm run typecheck` / `npm run build` | pass |
| Local preview (`CONTENT_PREVIEW=true`) | article 200 with the preview badge, 4 figures, 2 tables; SVGs served as `image/svg+xml`. Only warning: no local site-config database, so defaults were used |
| Diagram inspection | SVGs pass `xmllint`; each rendered with macOS Quick Look and checked for overlaps |

**Manual steps (owner)**
1. Review the `<Todo>`, update the proof section if Pinecone, a chat model or the lab have since run on mk4, add commentary, set `status`/`publishedAt`.

## Draft articles: RoboShop AI on Amazon EKS — system design + deployment guide (2026-10-30, owner request)

**What changed**
- New `content/blog/roboshop-ai-eks-system-design.mdx` (analysis) and `content/blog/deploy-roboshop-ai-amazon-eks.mdx` (tutorial), both `status: review` (visible only in `npm run preview`; never published by this change). Written against roboshop-ai commit `692e72d` plus its uncommitted `deploy/eks/` folder, which is the authoritative configuration; the articles link to it instead of copying files.
- Eight diagrams in `public/images/roboshop-eks/eks-*.svg`, copied from `roboshop-ai/deploy/eks/diagrams/svg/` (generated there by `build_diagrams.py`, stdlib; Mermaid sources beside it). 720 px wide, `<title>` + `<desc>` on each, alt text and captions in the articles.

**Commands → result**
| Command | Result |
|---|---|
| `npx vitest run tests/content.test.ts tests/links.test.ts tests/editor-workflow.test.ts` | pass (3 files, 41 tests) |
| `npm test` | pass (40 files, 383 tests) |
| `npm run lint` / `npm run typecheck` | pass |
| `npm run build` | pass |
| Local preview (`CONTENT_PREVIEW=true CONTENT_DIR=content next dev`) | both pages 200 with the preview badge; 8 figures render; SVGs served as `image/svg+xml` |
| Diagram inspection | each SVG rendered with macOS Quick Look and checked for overlaps/clipping; fixed several before copying |

**Manual steps (owner)**
1. Commit/push `roboshop-ai/deploy/eks`, then pin the `tree/master`/`blob/master` links in both articles to that commit.
2. The guide has not been run on AWS: deploy once, record region/date and fixes, then remove the "not yet run" wording.
3. The roboshop-ai licence is "all rights reserved": decide whether readers may deploy their own copy before publishing.
4. Review the `<Todo>` notes, add commentary, set `status`/`publishedAt`.

## Draft article: RoboShop AI microservices, benefits and trade-offs (2026-10-29, owner request)

**What changed**
- New draft `content/blog/roboshop-ai-microservices.mdx` (`status: draft`), written against roboshop-ai commit `8cded0b` (working tree had only doc/script changes). Complements, does not replace, the existing `roboshop-ai-microservices-architecture` draft, which still describes separate `frontend`/`nginx` workloads.
- Four diagrams in `public/images/roboshop-ai/roboshop-ai-{overview,ai-paths,checkout-events,observability}.svg`, generated by `docs/diagrams/roboshop-ai-microservices/build_diagrams.py` (stdlib only); matching editable Mermaid sources beside it. The overview is laid out at 560 px wide for phones.

**Commands**: Mermaid sources parsed and rendered with mermaid-cli 11.4.2; SVGs checked with `xmllint` and inspected in headless Chrome at full size and at a 358 px column; vitest 37 files / 361 tests pass (one editor-fidelity failure fixed by adding blank lines before lists). Lint, typecheck and build not run (content and static assets only).

**Manual steps**: review the `<Todo>`, add commentary, then set `status`/`publishedAt`. The two RabbitMQ reference URLs return 403 to scripted requests and were not fetch-verified.

## Tracing, logs, metrics and Grafana dashboards (2026-10-29, owner request)

**What changed**
- Tracing was already on (Jaeger lists `jithendar-com`); spans are now always recorded so request metrics can be derived from them.
- Metrics (`src/lib/metrics.ts`, no new dependency): per-route request rate/status/latency from Next.js server spans, process and event-loop metrics, email/comment counters, database gauges; served on cluster-internal port 9464.
- Logs: `event` slug, `errorType`/`errorCode`, `route` on request lines, matching the fields the cluster's Alloy pipeline keeps (it drops `msg`).
- Manifests (`k8s/` and `www/deploy/base`): metrics container port, NetworkPolicy rule for Prometheus only, headless Service, Role/RoleBinding for Alloy.
- `tools` repo (platform, synced by Argo CD): Alloy collects namespace `jithendar`; Prometheus job `jithendar-com` (DNS discovery) + 3 alerts; Grafana folder "Jithendar.com" with Overview and Logs dashboards; Loki trace-id links to Jaeger.
- Docs: `docs/OBSERVABILITY.md`.

**Commands**: lint pass; typecheck pass; vitest 37 files / 360 tests pass; production build pass; local `next start`: `/metrics` showed per-route counts after real requests; dashboard queries validated against live Prometheus/Loki (36/36 parse); kustomize renders + server dry-run for `k8s/`; Grafana chart rendered with new values.

**Manual steps**: deploy the site, then push `tools` (see docs/OBSERVABILITY.md → Rolling it out).

## Email provider choice: SMTP, Mailgun, Amazon SES (2026-10-29, owner request)

**What changed**
- Admin → Storage & email → Email: one selector (Disabled / SMTP / Mailgun / Amazon SES); only the selected provider's fields are shown and submitted; the others' settings are kept; no failover (`docs/EMAIL.md`).
- `src/lib/mail.ts`: versioned settings (old SES-only settings read as SES), per-provider validation with field errors, encrypted secrets never returned (empty field keeps the stored one), SES with the server's AWS credentials (SDK default chain) or stored keys incl. temporary keys + session token, Mailgun HTTP API (US/EU) without a new dependency, SMTP with TLS/STARTTLS only, reply-to, "configured" vs "tested", explicit test email to a typed address, secrets redacted from errors/logs/audit, `SMTP_URL` fallback only until an admin saves a choice (and only when it is a valid smtp(s) URL). All transactional email (verification, reset, contact) goes through it. System status reports the active provider without sending.
- Fixed during browser checks: React's automatic form reset after an action cleared typed values on validation errors and reset the provider select (next save turned email off); forms now submit without the reset. All missing-field errors are reported at once.

**Files**: `src/lib/mail.ts`, `src/lib/health.ts`, `src/app/admin/storage/{page,EmailSettings}.tsx`, `src/app/admin/storage/email-actions.ts`, `src/components/admin/ui.tsx`, `tests/mail.test.ts`, `docs/EMAIL.md`, `docs/DEPLOYMENT.md`, `.env.example`.

**Commands**: lint pass; typecheck pass; vitest 36 files / 355 tests pass; production build pass; browser checks (1440px, 390px) 10/10 pass.

**Manual steps**: choose and configure a provider in the admin, then Send test email. Provider-console and DNS steps: `docs/EMAIL.md`. No live provider was tested (no credentials).

## Sign-out, password toggles, discussions, social-login audit, article header (2026-10-29, owner request)

**What changed**
- Sign-out (`docs/AUTH.md`): one `signOutAndLeave()` for every control — server-side session deletion, private browser data cleared, full `replace()` to `/login?signedOut=1`. Mobile admin menu now has Sign out (the sidebar block is desktop-only). `SessionGuard` on admin/account layouts (bfcache reload, session ended elsewhere/expired → login). `no-store` on admin, admin API, comment API and login. Accurate "session expired" vs "not signed in". A race between the guard and sign-out (found in browser checks) is handled by `isSigningOut()`.
- `PasswordInput` with show/hide toggle on all password fields (login, sign-up, setup, admin secrets).
- Discussions (`docs/COMMENTS.md`): replies (2 visible levels), Markdown + preview with server-side sanitising, likes, reports, edit/delete, permalinks, sort + paging, moderation tabs/actions with audit, per-post open/locked/closed, approval and edit-window settings. Replaces `CommentForm`/old `approvedComments`.
- Article page: header spans the reading column plus the right column from `lg` (title 952px vs body 688px at 1440); standfirst stays at reading width; the cover image block is removed (cover still stored, edited, on cards, in Open Graph and Article JSON-LD). The now-unused "Cover image" Appearance toggle was removed (schema field kept).
- Social login audit: already complete (Google/GitHub, PKCE/state/nonce, lowest role, no implicit linking, explicit linking, error messages). No code changes; added tests for comment-anchor return URLs and off-site/protocol-relative refusal.
- Migration `0008_discussions.sql` (additive). New dev dependency `happy-dom@20.14.6` (DOM for the password toggle interaction tests only).

**Files**: `src/lib/{sign-out,comments,comment-markdown,comment-types,session,settings}.ts`, `src/components/{SessionGuard,AccountMenu,Comments,icons}.tsx`, `src/components/ui/PasswordInput.tsx`, `src/components/discussion/*`, `src/components/admin/{AdminNav,ui}.tsx`, `src/app/{account/SignOutButton,account/layout,account/settings/SessionControls,admin/layout,admin/comments/page,login/page,login/LoginForm,setup/SetupForm,admin/storage/page,admin/backups/page,admin/appearance/panels}.tsx`, `src/app/_actions/{comments,public}.ts`, `src/app/api/comments/[postId]/route.ts`, `src/lib/pages/article.tsx`, `src/lib/site-config/schema.ts`, `src/db/schema.ts`, `src/db/migrations/0008_discussions.sql`, `src/app/globals.css`, `next.config.ts`, tests `discussions`, `password-input`, `sign-out`, `social-auth` (+ sign-out/return URL cases), `article-route.test.tsx` (renamed from .ts; cover case), docs `AUTH.md`, `COMMENTS.md`.

**Commands**: lint pass; typecheck pass; vitest 35 files / 345 tests pass; production build pass; browser checks (Chrome, `next start`, 1440px and 390px) 45/45 pass.

**Manual steps**: OAuth clients still need creating (`docs/AUTH.md`); no other configuration. Review comment settings in Admin → Appearance → General → Features before publishing.

**Open**: no password-reset/change-password pages exist (reset emails point nowhere useful); social login not tested against real providers.

## Appearance & site settings (2026-10-29, owner request)

**What changed**
- Admin → Appearance & settings (`/admin/appearance`, admins only): General, Branding, Header, Navigation, Footer, Typography & colours, Homepage, Blog & articles, Media, SEO & integrations, Advanced, Revision history. Details and the full control list: `docs/APPEARANCE.md`.
- Typed, versioned `SiteConfig` (zod) with safe links, plain text, hex colours, bounded values, own-media images, contrast and navigation rules; legacy settings migrated; per-section fallbacks.
- Lifecycle: shared private draft with autosave and conflict detection → preview of the real pages (admin-only cookie token, no-store, noindex, phone/tablet/desktop) → atomic publish (transaction, revision, audit, cache bus) → history with restore; export/import of non-secret settings into the draft.
- Public site now reads the configuration: theme tokens/fonts via CSS variables, header (presets, inverse backgrounds, CTA, social, nested menus with keyboard submenus), dismissible announcement, footer, homepage section registry, listing/article presentation and page size, share links, date format/time zone, favicon/icons, configurable default share image.
- Maintenance mode in the proxy (503 + Retry-After, staff bypass, indexing untouched). Same-origin framing allowed for previews.
- Migration `0007_site_config.sql` (additive). No new dependencies. Old `/admin/settings` redirects.

**Files**: `src/lib/site-config/*`, `src/app/admin/appearance/*`, `src/app/api/admin/appearance/preview/route.ts`, `src/components/{SiteHeader,NavLinks,SiteFooter,Logo,AnnouncementBar,DismissAnnouncement,PreviewBanner,ShareLinks,CopyLink,ArticleList,CoverImage,TopicGrid}.tsx`, `src/components/sections/HomeSections.tsx`, `src/components/site/*`, `src/app/{layout,page,opengraph-image}.tsx`, `src/lib/{settings,dates,media}.ts`, `src/lib/pages/{article,listing,listings}.tsx|ts`, `src/lib/og/card.tsx`, `src/proxy.ts`, `next.config.ts`, `src/app/globals.css`, `src/db/schema.ts`, tests `site-config` (+ `indexing`, `seo-integrations`, `social-auth` adjusted), `docs/APPEARANCE.md`.

**Commands**: see the final report of this change (lint, typecheck, 32 test files, production build, browser flows and width audit).

**Manual steps**: none required; after deploying, review the draft in Admin → Appearance and publish when ready.

## Redesign + social sign-in, profiles and header account menu (2026-10-29, owner request)

**What changed**
- Design system (`docs/DESIGN_SYSTEM.md`): semantic colour tokens with one blue accent and a neutral grey scale, fluid type tokens, reading/page widths, radii, shadows, section rhythm; dark mode now follows the system *and* remembers an explicit choice (header toggle, footer System/Light/Dark) without a flash. Removed gradients, glass, grid backgrounds and the decorative hero mosaic; calmer category/type badges.
- Public pages: new header (accent underline for the current section, search, theme, account control far right; search/theme move into the mobile menu on phones), footer, homepage (text intro, one primary action, featured + recent, compact topics, projects only when published), article page (≈70-character column, TOC in the right margin ≥1280px, labelled code blocks, contained sources/corrections, separated ad slot), listings, static pages, author, search, 404 and a new runtime error page.
- Shared components: buttons/inputs/fields/alerts with sizes and states (16px inputs), pagination, tags, breadcrumbs, cards; ~40 files moved from duplicated light/dark class pairs to tokens.
- Admin: full-height sidebar shell, full-width header, accent current state, table/stat/header primitives, loading skeleton; editor action bar no longer slides under the sticky header; an expired session during save/autosave shows a message instead of navigating away (draft kept locally).
- Auth (`docs/AUTH.md`): Google + GitHub via Better Auth (PKCE, state, OIDC nonce, minimal scopes), buttons only when configured, readable callback errors, safe `next` handling, lowest role for every self-registration, no implicit account linking, explicit link/unlink with fresh-session rule and last-method protection, encrypted provider tokens, `/update-user` disabled.
- Accounts: `/account` (avatar, display name, bio, website, social links; server-validated allowlist) and `/account/settings` (email, sign-in methods, sign out / sign out everywhere); header account menu (keyboard, outside click, Escape, focus return, viewport-safe). Avatars re-encoded to 512px WebP without metadata, stored in R2 under `images/avatars/{user-id}/`, old uploads deleted on replace/remove. App rate limits for profile and avatar changes. `Cache-Control: private, no-store` on account and auth routes.
- Migration `0006_account_profile.sql` (additive, defaults). New direct dependency: `sharp@0.35.5` (already installed as Next's image engine; now declared because avatars use it directly).

**Files**: `src/app/globals.css`, `src/app/{layout,page,error,not-found}.tsx`, `src/app/account/**`, `src/app/login/**`, `src/app/admin/{layout,loading}.tsx`, admin pages (token pass), `src/app/media/avatars/[userId]/[file]/route.ts`, `src/components/{AccountMenu,UserAvatar,HideOnAdmin,SiteHeader,NavLinks,SiteFooter,Logo,Container,PageHeader,ArticleList,TopicGrid,CodeBlock,TableOfContents,Pagination,TagList,Breadcrumbs,AuthorCard,CoverImage,ContentTypeBadge,categoryStyle,icons}.tsx`, `src/components/theme/*`, `src/components/ui/form.tsx`, `src/components/admin/{ui,AdminNav}.tsx`, `src/lib/{auth,auth-providers,auth-errors,avatar,avatar-url,profile,rate-limit,safe-next,session,admin}.ts`, `src/lib/mdx/compile.ts`, `src/lib/pages/*.tsx`, `src/db/schema.ts`, `next.config.ts`, `deploy/base/networkpolicy.yaml` (comment only), `scripts/set-oauth-config.sh`, `.env.example`, `package.json`, tests `social-auth`, `account-helpers`, docs `AUTH.md`, `DESIGN_SYSTEM.md`.

**Commands**: see the final report of this change (lint, typecheck, 31 test files (278 tests), production build, browser checks at 320–1920px light/dark, account-menu keyboard flow, profile form, theme persistence).

**Manual steps**: create the Google and GitHub OAuth clients (`docs/AUTH.md`), `scripts/set-oauth-config.sh mk4`, restart; verify live sign-in and avatar upload with R2.

## Search engines, analytics, AdSense and the block editor (2026-10-29, owner request)

**What changed**
- SEO: SEO/social/noindex fields for posts and pages; image sitemap entries; noindex posts and pages left out of sitemaps; staging crawlable with `X-Robots-Tag: noindex` (was `Disallow: /`, which hides noindex); Google/Bing verification meta from runtime config; IndexNow with a Postgres job queue (retries, dedupe, never blocks publishing); HSTS and Permissions-Policy; `/search` rendered per request.
- GA4 (Consent Mode v2 defaults, manual de-duplicated page views, `article_engaged`, no PII, never on private routes) and AdSense (one tag, labelled reserved slot after articles, test mode outside production, `/ads.txt` verbatim, Google's certified CMP + "Privacy choices" link). Draft privacy and cookies pages bundled for owner review (not auto-published). Details: `docs/SEO_ANALYTICS_ADS.md`.
- Editor: visual block editor over canonical Markdown with protected shortcode blocks and a fidelity check, slash commands, searchable inserter, block move/duplicate/delete, code languages, figures/galleries, safe links; publish/schedule/update/unpublish; server autosave + recovery; optimistic concurrency; revisions with preview/restore; device previews; trash/restore/duplicate; posts and pages dashboards; media search/paging/drag-drop/paste, alt editing and usage warnings; server-side scheduler. Details: `docs/EDITOR.md`.
- Migration `0005_editor_seo.sql`: new columns (defaults keep existing behaviour), `revision` (baseline revision for all existing content), `autosave`, `job`. Additive only; rollback = deploy the previous image (it ignores the new columns/tables), but note it does not know about trash or scheduling: trashed posts would show again and scheduled posts would stay unpublished until rolled forward.
- Security: render-time filter for unsafe URL schemes (`lib/mdx/safe-urls.ts`), save-time link validation.

**Commands**: see the final report (lint, typecheck, 29 test files, build, HTTP checks, browser flows).

**Manual steps**: Search Console/Bing/GA4/AdSense/consent checklist in `docs/SEO_ANALYTICS_ADS.md`; `scripts/set-public-config.sh mk4`; review and publish the bundled privacy/cookies drafts (Admin → Pages); complete "Owner input needed" items.

## Responsive pages, R2 media, Gemini "Generate image" (2026-10-29, owner request)

**What changed**
- Media storage moved from S3 to Cloudflare R2 (S3 API): keys `jithendar/www/media/{type}/{yyyy}/{mm}/{id}.{ext}`; images, video, audio, PDF; presigned direct uploads with server-side verification (size, SHA-256, magic bytes); private files via 5-minute signed links; legacy S3 rows still served until migrated; resumable, verified, non-destructive S3 → R2 migration with dry run, manifest and rollback (Admin → Storage). Details: `docs/MEDIA.md`.
- "Generate image" beside the cover controls: Gemini Interactions API (model from `GEMINI_IMAGE_MODEL`), preview → Use as cover / Regenerate / Discard, alt text required, per-user hourly + concurrency and site-wide daily limits, timeout + cancel, temp storage with 1 h app cleanup and 1-day R2 lifecycle backstop; prompts never stored.
- Responsive: fixed page-level overflow on static pages (sidebar nav) and the contact form (Turnstile compact below 300 px); collapsible admin menu below `lg`; shared accessible dialog (full-screen on phones, focus trap, Escape); tables scroll in their own region; `::video`, `::audio`, `::embed` shortcodes in fixed-ratio frames; cover focal point; footer touch targets; `minmax(0,1fr)` grids.
- Image pipeline bounded: fixed widths/quality, 12 MB source cap, no redirects, 200 MB LRU disk cache; LCP images eager + high priority (Next 16 deprecates `priority`).
- Fixed: server-action uploads were capped at Next's 1 MB default (now 11 MB); local dev without `DATABASE_URL` crashed (PGlite bundled by Turbopack → now external).
- New dependency: `@aws-sdk/s3-request-presigner@3.1157.0` (Cloudflare's documented way to presign R2 URLs; same SDK version as `client-s3`). Gemini uses `fetch` (no SDK).

**Files**: `src/lib/{storage,storage-legacy,media,media-migration,gemini,image-generation,health,db-admin}.ts`, `src/lib/mdx/{shortcodes,tables,compile,html}.ts`, `src/app/media/[id]/[name]/route.ts`, `src/app/api/admin/{images,media-migration}/…`, `src/app/admin/{storage,media}/…`, `src/app/admin/_actions/shared.ts`, `src/components/admin/{Dialog,GenerateImageDialog,CoverImagePicker,MediaPicker,AdminNav}.tsx`, `src/components/{CoverImage,ContentImage,ContentMedia,Mdx,Turnstile,ContactForm,SiteFooter}.tsx`, `src/lib/pages/{article,page-view}.tsx`, `src/app/admin/layout.tsx`, `src/app/globals.css`, `src/db/{schema.ts,migrations/0004_r2_media.sql}`, `next.config.ts`, `deploy/base/{deployment,networkpolicy}.yaml`, `deploy/r2/{cors,lifecycle}.json`, `scripts/set-media-config.sh`, `.env.example`, `docs/{MEDIA,DEPLOYMENT}.md`, tests `media-storage`, `r2-config`, `image-generation`, `media-migration`, `responsive-content`.

**Commands**: see the final report of this change (lint, typecheck, tests, build, browser audit at 320–1920 px).

**Manual steps**: create the R2 bucket, token, CORS and lifecycle rules; `scripts/set-media-config.sh mk4`; choose `GEMINI_IMAGE_MODEL`; deploy; migrate legacy media if any (`docs/MEDIA.md`). Update the privacy policy to mention Gemini (editor-only) and YouTube/Vimeo embeds if used.

## CI deploys with kubectl, Argo CD removed (2026-10-27, owner request)

- **Why the live site did not change:** the owner ran `kubectl apply -k` from a checkout one commit behind `origin/master`. The local overlay pinned the old image (`dcdd3d7`), and CI had already pinned the new one (`d54da88`, `sha256:430f…`). The CI `deploy` job for that run was also waiting for an Argo CD app that had been deleted.
- **New deploy job:** loads `JITHENDAR_KUBECONFIG` (environment `production`), pins the digest built in the same run, then server dry-runs and applies `deploy/production`. It waits for `rollout status` (`rollout undo` on failure), waits for `/api/health` to report the commit, and runs the smoke test. The credential file is removed in an `always()` step.
- **CI identity:** `deploy/ci-access/rbac.yaml` (ServiceAccount, Role, RoleBinding; namespace `jithendar`; get/list/watch/create/update/patch on only the kinds in the overlay; read-only pods, events, replicasets; no delete; no Secrets). `scripts/ci-kubeconfig.sh` mints a 1-year token, refuses over-privileged or non-working credentials, and stores the GitHub secret.
- **Argo CD:** removed `argocd/jithendar-com.yaml` and its catalog entry, reverted the auto-sync exception in `scripts/argocd/validate.py`, updated `argocd/README.md`, and set `tests/test_argocd_catalog.py` to 25 apps. That test was already failing on `master` (26 expected, 25 present) after jithendar-com was commented out. During this change, a first edit accidentally commented out `jaeger.yaml`; caught by the validator count and fixed before reporting.
- **Checks:** actionlint, shellcheck, `validate.py` (25 apps, 79 resources), catalog tests 11 passed, RBAC server dry run passed.
- **Not done (blocked by the agent permission policy, owner to run):** `kubectl apply -f deploy/ci-access/rbac.yaml` and `scripts/ci-kubeconfig.sh mk4`. Until then the `deploy` job fails at "Load cluster credentials" with a clear message.

## Phases 3 + 4 — Transparency pages and content platform (2026-10-27, owner request: "implement complete website")

**Status:** complete locally. Not yet pushed; CI deploys on push. Phase 5 (n8n/OpenAI) and Phase 8 (monetisation scaffolding, observability) are not website features and were not started. Phase 7 (WordPress migration) is unnecessary; see AUD-008.

**Phase 3, transparency**
- `content/pages/`: about, contact, editorial-policy, corrections-policy, ai-use-policy, privacy-policy, terms. Rendered by `src/app/[page]`, editable as MDX, with `updatedAt` shown.
- Policies describe only the workflow that exists in this repo. Unverifiable facts (bio, contact email, legal entity, jurisdiction, log retention, licences, sponsorship rules, AI providers) are `<Todo>` blocks: visible in dev/preview, **render nothing in production**.
- Author profile: verified GitHub link (`github.com/mrjithendar`, name matches), bio TODO. "Open-source" wording avoided because the RoboShop AI repo has no licence.
- Article page: distinct badges for News / Analysis / Tutorial / Opinion / Curated summary / Project / Sponsored; byline → author page; published, updated, reading time; category link; sources; corrections log (links to the policy); curated and sponsored disclosures; tags.
- `docs/GOOGLE_NEWS_READINESS.md`.

**Phase 4, platform features**
- Category (`/category/<c>`), tag (`/tag/<t>`), collection and author listings with `/page/<n>` pagination (`/page/1` → 308 to base, out of range → 404). Taxonomy pages with < 3 items or no intro are `noindex, follow` and kept out of the sitemap; tag pages are always noindex. Category intros live in `src/config/taxonomy.ts`.
- Related reading: explicit `related` frontmatter first, then category (3) / related-category pair (1) / shared tag (2) scoring, deterministic tie-break, published only.
- Reading time; "On this page" TOC from h2/h3 (ids by rehype-slug, collected in the same compile); Shiki highlighting at render time (light/dark); copy button with an `aria-live` announcement.
- Search: `/search-index.json` (published only), lazy-loaded client search at `/search` (noindex).
- RSS 2.0: `/feed.xml` and `/category/<c>/feed.xml`, autodiscovery link in `<head>`.
- Broken-internal-link check (`src/lib/content/links.ts`), run by `npm test` against real content, so CI fails on a broken link.
- `npm run preview` (`CONTENT_PREVIEW=true`) shows `review` items locally with a badge; forced off when `APP_ENV=production` (tested).
- Site icon; redesigned header, footer (topics, policies, RSS) and homepage (news, articles, projects, topics, empty state).
- Two drafts for owner review, `status: review` (not public): `projects/roboshop-ai` (facts from the repo README only) and `blog/deploy-nextjs-kubernetes-argo-cd` (from this repo's real manifests and workflow).

**New dependencies:** `shiki` + `@shikijs/rehype` (build-time highlighting, no client JS), `rehype-slug` (heading ids), `hast-util-to-string` + `unist-util-visit` (TOC plugin; already transitive deps of MDX), `@types/hast`.

**Fixed along the way:** inline code was dark-on-dark in dark mode (typography plugin `lab()` fallback), now an explicit pill style; `/favicon.ico` 404 console error, now fixed with an icon; a `setState`-in-effect lint error in search, removed by dropping the `?q=` prefill.

**Commands run → result** (Node 26.8.2)
| Command | Result |
|---|---|
| `npm run lint` | Pass. 0 problems |
| `npm run typecheck` | Pass |
| `npm test` | Pass. 11 files, 88 tests |
| `APP_ENV=production npm run build` | Pass. No warnings |
| `kubectl kustomize deploy/production` | Pass |
| `shellcheck scripts/*.sh` | Pass |
| Production server + curl, fixture content | Pass. Status, single `<h1>`, canonical and robots correct on 19 routes; feeds valid; search index and sitemap published-only |
| Production server + curl, real content | Pass. 7 pages 200 and indexable; 0 `TODO(owner)` in HTML; review drafts 404 |
| Lighthouse 12.8.2, local `http://` | Home mobile 96/100/79/100 (perf/a11y/bp/seo), desktop 100/100/–/100; about mobile 96/100; blog 96–100 perf, a11y 100 (SEO 66 because the empty listing is noindex by design); article (staging preview) mobile 95, desktop 100, a11y 100 (SEO 66 because staging is noindex). Best-practices deductions are only HTTPS/HTTP2 audits from serving locally over http. Mobile LCP 2.7–2.9 s includes ~1.1 s of a local HTTPS-upgrade fallback; on HTTPS it would be about 1.6–1.8 s (estimate, not measured). These are lab scores, not field data |

**Open:** owner TODOs (see `GOOGLE_NEWS_READINESS.md`); AUD-018 (client-rendered 404 body on dynamic routes); no published content yet.

## Deployment to mk4 over HTTPS (2026-10-27, owner request; ahead of the Phase 6 plan)

**Status:** manifests, Dockerfile, CI and Argo app written and validated; ECR repo created. **Waiting on the owner to commit and push.**

**Update (owner request: "CI should build and deploy"):** CI now deploys end to end without cluster credentials. `publish` commits the image digest to `deploy/production`, Argo CD auto-syncs `jithendar-com` (no prune, no self-heal; allow-listed exception in `scripts/argocd/validate.py`), and `deploy` waits for `/api/health` to report the commit, then runs `scripts/smoke.sh`. This replaces the earlier one-off `kubectl apply` plan; the only manual cluster step is creating the Argo Application once. Checks: actionlint + shellcheck clean; `validate.py` 26 apps OK; catalog tests 11 passed; Argo app and digest-pinned overlay pass server dry run; site tests 67 passed.

**Changes**
- `src/app/api/health/route.ts` + test: probe endpoint.
- `Dockerfile`, `.dockerignore`: multi-stage, `node:26-alpine`, non-root UID 1000, standalone output.
- `deploy/base/*`, `deploy/production/*`: see `docs/DEPLOYMENT.md`.
- Outside the site folder (shared files): `argocd/jithendar-com.yaml`, an entry in `argocd/kustomization.yaml`, `.github/workflows/ci-jithendar-com.yml`.
- AWS: created ECR repository `jithendar-com` (immutable tags, scan on push, lifecycle keeps 30).

**Commands run → result**
| Command | Result |
|---|---|
| Read-only `kubectl get` on mk4 | Nodes arm64 ×4; `letsencrypt-prod` Ready; `/` unclaimed on jithendar.com; **Certificate `jithendar-com` missing** (AUD-003) |
| `kubectl kustomize deploy/production \| kubectl apply --dry-run=server` | Pass. All 11 objects accepted (incl. cert-manager and Traefik CRDs); nothing persisted |
| `python scripts/argocd/validate.py` | Pass. 26 Applications, 90 unique resources, no overlapping ownership |
| `pytest tests/test_argocd_catalog.py` | Pass. 11 tests |
| `npm run lint` / `typecheck` / `test` / `build` | Pass / pass / 66 tests pass / pass |
| `docker build` | **Not run.** No local Docker engine; owner chose GitHub Actions |
| Workflow run | **Not run.** Needs a push |

**Open**
- Whether the self-hosted runner's AWS identity can push to the new repository is unverified (it pushes `roboshop-*` today).
- `node:26-alpine` is pinned by tag, not digest (same as the RoboShop images).
- WordPress leftovers in `jithendar`: PVCs `wordpress-mysql` and `wordpress-wordpress`, and Secret `wordpress-credentials`. Untouched; delete only with owner approval.

## Phase 2 — Content model & SEO foundation (2026-10-27)

**Status:** complete. Not deployed (Phase 6). jithendar.com still returns 503.

**What changed**
- Scaffolded Next.js 16.4.3 (App Router, React 19.3, TS 5.9, Tailwind 4) with `output: "standalone"`. It has its own `package.json`, separate from the RoboShop root.
- Zod content schema, a loader that reports every error at once, and `getPublishedContent()` as the single read path. Collection ↔ contentType rules.
- Routes: `/`, `/blog`, `/news`, `/projects`, `/<collection>/<slug>`, `/authors/<slug>`, `/sitemap.xml`, `/news-sitemap.xml`, `/robots.txt`.
- Metadata: `%s | Jithendar.com` titles, per-page absolute canonicals (none at root level), Open Graph and Twitter cards, one `<h1>` per page (MDX `#` demoted to `<h2>`).
- Non-production: `noindex, nofollow` meta tag (build time, `APP_ENV`), `X-Robots-Tag` header and disallow-all `robots.txt` (request time, `APP_ENV` + host).
- JSON-LD builders (Person, Organization, WebSite, ProfilePage, NewsArticle/BlogPosting/CreativeWork, BreadcrumbList) with `<` escaping.
- `src/config/redirects.ts` (empty, one-hop tested) and `src/config/gone.ts`: 410 for the 21 hijacked WordPress URLs (AUD-002). The proxy does its own trailing-slash 308, so gone URLs answer 410 in one hop.
- Baseline headers: `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`; `X-Powered-By` removed.

**New dependencies (justification)**
- `@mdx-js/mdx`: official MDX compiler, chosen over the less-maintained `next-mdx-remote`.
- `yaml`: frontmatter parser using the YAML 1.2 core schema, so timestamps stay strings with their offset. `gray-matter`/js-yaml would turn them into `Date` objects and lose the offset.
- `zod`: schema validation (required by the spec).
- Dev: `vitest` (TypeScript/TSX tests; the root's `node --test` would need extra tooling); `fast-xml-parser` (XML validity assertions); `@tailwindcss/typography` (article prose); `eslint-config-next`.
- `eslint` stays on 9.x (npm marks it deprecated). The plugins bundled with `eslint-config-next` 16.4.3 only accept ESLint ≤ 9. Revisit when they support 10.
- `typescript` 5.9.3 rather than the root's 7.0.2: `typescript-eslint` supports TS < 6.1 only.

**Files touched** (all under `sites/jithendar-com/`)
- Config: `package.json`, `package-lock.json`, `.nvmrc`, `.gitignore`, `.env.example`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`
- `src/config/{site,taxonomy,redirects,gone}.ts`, `src/proxy.ts`
- `src/lib/content/{schema,frontmatter,load,index}.ts`, `src/lib/seo/{canonical,jsonld,news-sitemap,sitemap,robots,xml}.ts`, `src/lib/dates.ts`, `src/lib/pages/{collection,article}.tsx`
- `src/components/{JsonLd,SiteHeader,SiteFooter,Mdx,ArticleList,Breadcrumbs}.tsx`
- `src/app/**` (layout, home, not-found, 3 collections × 2 routes, author, sitemap, news-sitemap, robots)
- `content/authors/jithendar-dharmapuri.mdx` (name only, `TODO(owner)` for the rest); empty `content/{blog,news,projects}/`
- `tests/*.test.ts` (8 files, 65 tests), `tests/fixtures/content/**` (9 articles covering every status and edge case)
- Docs: `README.md`, `docs/CONTENT_MODEL.md`; updated `AGENTS.md`, `docs/SEO_AUDIT.md`, `docs/IMPLEMENTATION_PLAN.md`

**Commands run → result** (Node 26.8.2)
| Command | Result |
|---|---|
| `npm install` | Pass. 505 packages. `unrs-resolver` postinstall not run (npm allowScripts); lint works without it |
| `npm run lint` | Pass. 0 problems |
| `npm run typecheck` (`next typegen && tsc --noEmit`) | Pass |
| `npm test` (vitest) | Pass. 8 files, 65 tests |
| `APP_ENV=production npm run build` | Pass. No warnings; standalone output holds `server.js`, `node_modules`, `content` only |
| Standalone server + curl, **fixture content** | Pass. Published article 200; draft/review/archived/future/wrong-collection 404; external canonical respected; single `<h1>`; JSON-LD dates match the page; sitemap excludes non-indexable URLs; news sitemap 48 h window (by real clock); 410s; 308 slash redirect relative, one hop; staging host → `X-Robots-Tag` + disallow-all robots |
| Standalone server + curl, **real content** | Pass. `/` 200 indexable; empty listings and author page `noindex, follow`; sitemap = homepage only; news sitemap valid and empty; CSS served; no server errors |
| Lighthouse | **Not run.** Phase 4 |
| Root `npm test` (RoboShop) | **Not run.** No RoboShop files changed |

**Note on the server check:** one intermediate run was answered by a stale server still bound to the port (`EADDRINUSE`). That run was discarded; results above come from fresh servers on the final builds.

**Open issues**
- Author bio, `jobTitle`, `sameAs` and the publication name: `TODO(owner)` (Phase 3).
- There is no published content yet, so the live site would be a homepage only. That's intentional: no fabricated posts.
- AUD-003 (shared TLS certificate) still unverified on the cluster.
- `www` → apex redirect must be recreated at ingress (Phase 6).

**Manual steps required (owner)**
1. Use Node 26: `export PATH=/opt/homebrew/bin:$PATH` (or reorder `PATH` in `~/.zshrc`).
2. Consider excluding `sites/jithendar-com/node_modules` and `.next` from Google Drive sync (AUD-016).
3. Phase 1 owner items 1, 2, 4 and 5 below are still open.

## Phase 1 — Audit & plan (2026-10-27)

**Status:** complete. Awaiting owner actions in IMPLEMENTATION_PLAN.md Phase 1.5.

**What changed**
- Stopped at first inspection: no Next.js repo existed, and the live site was a hijacked self-hosted WordPress. The owner removed WordPress (`argocd/wordpress.yaml` deleted, `argocd/kustomization.yaml` updated, both uncommitted) and confirmed its data is not needed.
- Created the site folder with standing rules and the audit/plan docs. No application code.

**Files touched**
- `sites/jithendar-com/AGENTS.md` — standing context and rules, adapted to verified state
- `sites/jithendar-com/docs/SEO_AUDIT.md` — findings AUD-001 to AUD-017
- `sites/jithendar-com/docs/IMPLEMENTATION_PLAN.md` — decisions D-1 to D-6, rescoped phases, risks
- `sites/jithendar-com/docs/PROGRESS.md` — this log

**Commands run → result**
| Command | Result |
|---|---|
| `curl` against public jithendar.com URLs (`/`, robots, sitemaps, feed, WP REST listings) | Ran. Evidence recorded in SEO_AUDIT.md |
| `openssl s_client` against jithendar.com:443 | Ran. Let's Encrypt cert for apex + www, valid until 2027-01-25 |
| `lint`, `typecheck`, `test`, `build` | **Not run.** No site code exists yet (Phase 2 scaffolds it) |
| Root `npm test` (RoboShop) | **Not run.** Out of scope; this phase changed no RoboShop code |
| `kubectl` against the cluster | **Not run.** AGENTS.md A3.3: agents do not touch the live cluster |

**Open issues:** AUD-002, AUD-003, AUD-004, AUD-005, AUD-007, AUD-010 to AUD-016.

**Manual steps required (owner)**
1. Check the shared TLS Certificate/Secret in namespace `jithendar` (AUD-003).
2. Check the workloads the hijacked pod could reach and rotate the credentials it could see (AUD-001).
3. Install Node ≥ 24 locally (AUD-015).
4. Confirm the publication name and host provider/spec (AUD-009).
5. Say whether an older WordPress.com export with real posts exists (AUD-008).
