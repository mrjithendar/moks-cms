# Editor

Status: implemented 2026-10-29.

## Architecture and canonical format

**Markdown is the single source of truth** (`post.body`, `page.body`), exactly what the site renders with
`lib/mdx/compile.ts` (format `md`: raw HTML, JSX, imports and expressions are never executed). The visual editor
(Tiptap 3, already a dependency; MIT, no paid parts) is a view over it:

```
stored Markdown ─parse─▶ editor document ─serialize─▶ stored Markdown      (lib/editor/markdown.ts)
```

- Standard blocks map 1:1: paragraphs, H2–H6 (the title is H1), bold/italic/strike/inline code/links, bulleted,
  numbered and task lists, quotes, dividers, code blocks with language, tables, images with alt text.
- Shortcodes (`:::callout`, `:::figure`, `:::gallery`, `::button`, `::embed`, `::video`, `::audio`, `:::details`,
  `::toc`), HTML comments and raw HTML/JSX blocks become **protected blocks**: shown as cards, edited as source,
  serialized byte for byte. Unknown shortcodes are preserved too (rendered as plain text on the site).
- Before opening visually, `fidelity()` round-trips the document. If anything meaningful would change (e.g. inline
  raw HTML), the editor opens in **Markdown** mode with the reason, and switching to visual asks first.
  All bundled content round-trips losslessly (tested).
- Safety: links/images accept only `http(s)`, `mailto`, site paths and anchors (editor, save validation, and a
  render-time filter for older content). Embeds only YouTube (privacy mode) and Vimeo (dnt), sandboxed. Pasted HTML
  is reduced to the editor schema. No remote fetching (no SSRF surface).

## Authoring

- Insert blocks with **+** (searchable) or by typing **/** in an empty paragraph (↑/↓, Enter, Esc).
- Block actions (toolbar or keys): move **Alt Shift ↑/↓**, duplicate **Ctrl/⌘ Shift D**, delete **Alt Shift Backspace**;
  undo/redo **Ctrl/⌘ Z / Shift Z**; save **Ctrl/⌘ S**. Drag handles are not required for any action.
- Images: library picker with search and paging; upload by choosing, dropping or pasting; alt text required;
  caption, alignment (centered/wide/full) and size (small/medium/large) via `:::figure`. Galleries via `:::gallery`.
  Removing an image from a post never deletes the file; Media shows where a file is used and refuses deletion while used.
- Featured image: choose, upload, **Generate image** (Gemini, see MEDIA.md), focal point; social image optional.
- In the article: the toolbar's **✨🖼** / **✨🎬** buttons and the `/generate` slash commands create an image or a short
  video for the selected text (or the section the cursor is in; the prompt is prefilled from it and editable). Images go
  through the usual alt text / caption step; videos insert `::video{… loop="true"}` (muted, autoplaying, repeating:
  GIF-style, controls kept) or a normal player; when an admin has switched on more than one video destination
  (R2, Cloudflare Stream, Mux, Bunny Stream) the dialog asks where to save it, and external ones insert `::embed`. Both are disabled with the reason as a tooltip until configured
  (MEDIA.md → *Generate image*, *Generate video*).
- **Members only** (sidebar → Access): signed-out readers get the first part of the article and a prompt to sign in or
  create an account; any signed-in reader gets all of it. How much is public: the site default (Admin → Advanced
  settings → Members-only articles, `MEMBERS_PREVIEW_PERCENT`, 30 when unset) or the post's own "Public preview (%)"
  (5–95). The cut is between blocks (never inside a paragraph, list, table or code block), so the preview is the
  smallest run of whole blocks reaching the percentage; an article of a single block cannot be gated. The rest is not
  in the public page at all: `lib/members.ts` splits the body, the page renders the preview, and
  `app/_actions/members.tsx` returns the remainder only to a signed-in session. The public "Ask" index gets the
  preview only (re-index after changing the setting). Structured data marks the page `isAccessibleForFree: false`
  with the gated section `.members-only`. Search engines therefore see and index only the preview. The API
  (`/api/v1/posts`, key with `posts:read`) and the editor preview show the whole article. In MDX files:
  `membersOnly: true`, optional `previewPercent`.
- Focus mode hides the admin chrome; on phones the settings open as a full-screen drawer.

## Saving and publishing

| Action | Effect |
|---|---|
| Typing | autosaved after 2.5 s as **your** working copy (server, per user and document; browser storage for new posts). Readers never see it. |
| Save draft | commits a draft (new revision) |
| Publish | publishes now, or **schedules** when the publish time (IST) is in the future |
| Update | commits changes to a published post (until then the live version is unchanged) |
| Switch to draft | unpublishes |

- **Optimistic concurrency**: every commit carries the version it was based on; a newer save elsewhere returns a
  conflict with *Load latest* (your edits are kept as a recovery copy) or *Overwrite with mine* (the overwritten version
  stays in history).
- **Recovery**: after a refresh/crash/offline period the editor offers the newer autosaved copy (restore/discard).
- **Revisions**: every commit (create, save, publish, schedule, update, unpublish, restore, scheduled publish) stores a
  snapshot with author and time. Preview any revision; *Load into editor* then Save creates a new revision — history is
  never rewritten. Existing content got a `baseline` revision in migration 0005.
- **Scheduling** is server-side (`lib/scheduler.ts`, every 30 s in each pod): conditional updates publish each post
  exactly once, across replicas and restarts; overdue posts publish as soon as the site is back. Status: Admin → System
  status ("Scheduled publishing & IndexNow"). Times are entered and shown in Asia/Kolkata and stored in UTC.
- After every committed change: content caches are invalidated on all replicas, sitemaps/feeds reflect it on the next
  request, and IndexNow is queued (idempotent job queue; failures never block saving).
- Original publication dates are kept when republishing (imports keep theirs).
- Previews (`/preview/<token>`): staff only, 1-hour tokens, `noindex`, `private, no-store`; the Preview dialog renders
  the unsaved document with the real site components at mobile/tablet/desktop widths.

## Sending MDX files without a build (`npm run push-post`)

Files in `content/{blog,news,projects}/` reach Admin → Posts through the content image: at server start every file that
is not a post yet becomes a **draft** automatically (`bundled-posts.ts`, `syncBundledPosts()`; there is no "Import as
draft" step any more). Each file is imported once (table `bundled_import`), so a post you delete permanently does not
come back on the next start; nothing is published automatically. Without a deploy, `scripts/push-post.ts` sends them to the live site through `/api/v1/posts`
instead:

```sh
export JITHENDAR_API_KEY=jk_…        # Admin → API keys, scopes posts:read + posts:write
npm run push-post -- content/blog/my-post.mdx [more.mdx] --dry-run   # check, send nothing
npm run push-post -- content/blog/my-post.mdx
```

- New slug → created as a **draft**, whatever the file's `status`/`publishedAt` say; the byline is the key's owner.
  Review and publish in the editor (the script prints the `/admin/posts/<id>` link).
- Slug already a draft or in review → updated in place from the file (overwrites editor changes to the same fields;
  the previous version stays in Revisions).
- Published, scheduled or archived → skipped (exit 1) unless `--update-live`, which changes the content but never the
  status or publication date; the live page changes at once.
- Everything is validated before anything is sent (frontmatter schema, slug = file name; then the API's own checks).
- Images: `/images/…` files ship only with an image build. The script refuses a post whose `/images/` file answers
  non-2xx on the site; upload it in Admin → Media and use its `/media/…` URL, or deploy once. `/media/…` URLs need no
  build. Media uploads have no API yet, and the media library rejects SVG.
- `--site=https://…` or `JITHENDAR_SITE_URL` targets another site (default `https://jithendar.com`).
- `--create-only` creates new drafts and never changes an existing post (reported as `exists`, exit 0).

**CI does this for you.** When a push to `master` adds an article that is not published and `ci-content.yml` skips the
restart, the workflow runs `push-post --create-only` for each new file, so the draft appears in Admin → Posts within
about a minute of the push, with no restart. It needs the repository secret `JITHENDAR_API_KEY` (Admin → API keys,
scopes `posts:read` + `posts:write`; **Requires manual configuration**). A file it cannot send (no key, or an
`/images/` file that is not live yet, because new images only ship with a restart) is listed in the run summary, and
the workflow then does a rolling restart, which imports it as a draft and makes its images live. Edits to files that are already posts are never sent from CI:
edit those in the editor, or run `push-post` yourself.

Code and design changes still need the image; only articles skip it. Tests: `tests/push-post.test.ts`.

## Dashboards

Posts: status tabs (all, drafts, review, scheduled, published, archived, trash) with counts, search, pagination,
edit/preview/duplicate/trash per row, bulk publish/draft/archive/trash, and in Trash restore/delete permanently
(confirmed). Duplicates are drafts with a unique `-copy` slug. Pages: search, trash/restore/delete, menu order,
SEO fields, revisions; bundled policy drafts (content/pages) are offered for review and never auto-published.

## Permissions (existing roles)

| | admin | author | user |
|---|---|---|---|
| Create, edit, publish, schedule, trash, restore, delete, duplicate posts | all posts | own posts | — |
| Revisions / autosave | all posts | own posts (own autosaves only) | — |
| Pages | ✓ | ✓ | — |
| Media upload/alt text/delete | ✓ | ✓ | — |

Every action is checked server-side (server actions carry Next.js's same-origin check; the JSON image-generation
endpoint checks `Origin`). Autosaves and revisions contain draft text and are only readable through these checks;
logs never include post bodies.

## Not included

- Editor-side syntax highlighting (the language is chosen in the editor; highlighting shows in Preview and on the site).
- Reassigning a post's author (shown read-only).
- Page parents (pages live at the top level by design).
