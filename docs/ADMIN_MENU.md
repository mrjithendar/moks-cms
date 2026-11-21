# The admin menu

Status: reorganised 2026-11-15; regrouped and changed to submenus on 2026-11-18 (owner request: "every menu should
have a submenu; no expand on desktop or tablet; expand and collapse on mobile"). Checked in Chrome on 2026-11-18 at
1440, 820 and 390 px against a local build. **WordPress order since 2026-11-21** (owner: "reorganize all the menus in
wordpress style"; moks-cms #179): Dashboard; the content menus; the plugin-like menus; then Appearance, Users, Tools
and Settings, with a line between the three parts. There is no Newsroom since the same day: news is one kind of
content a crew job writes, under AI & SEO.

## What a person sees

One entry per area of work, each with an icon, and **every entry opens a submenu**, even one with a single page.

- **Tablet and desktop (768 px and wider; the sidebar is beside the page):** pointing at an entry, or clicking it,
  opens its pages in a panel beside the sidebar, one entry at a time. Nothing expands inside the sidebar. The panel
  stays open for 200 ms after the pointer leaves, so it can be reached across the gap; Escape, a click elsewhere or
  scrolling the sidebar closes it. The entry holding the current page is highlighted.
- **Phone:** the Menu button opens the list; an entry expands and collapses in place, the current page's entry is
  open, and the browser remembers which entries were opened.

| Entry | Pages |
|---|---|
| Dashboard | Home |
| — | |
| Posts | All posts, Add new post, Categories, Tags. **Editorial:** Editorial calendar, Review queue, Promotion |
| Media | Library |
| Pages | All pages, Add new page, Hire me page |
| Comments | All comments, Messages, Bookings |
| — | |
| AI & SEO | **Crew jobs:** CrewAI console, Jobs (content jobs and system jobs), Job runs, Flow runs, Flows (with Custom flows), Crews (with Custom crews), Skills, Import / export. **Content:** Content sources, Topics, Profiles & playground, Content analytics, Keywords, Recommendations, Content audit, Internal linking. **Traffic:** Search performance, Visitor analytics, Page insights, Reports. **Authority & health:** Backlinks, AI visibility, Technical health. **Models & data:** ML models, LanceDB. **Settings:** Settings, MCP access |
| Billing | Invoices, Payments |
| Practice | Python practice |
| — | |
| Appearance | Customise, Menus, Homepage, Typography & colours |
| Users | All users, Profile, API keys ("Your account" for someone without the Users page) |
| Tools | Site health (was System status), Cache, Backups (export / import), Data sync, Database, Audit log |
| Settings | General, Integrations, Media & storage, Email |

Every settings page (Settings → Integrations, Media & storage, Email, and AI & SEO → Settings) has the sectioned layout
of Settings → General: the sections on the left (a select on a phone), one at a time, the open one in the address
(`?section=`; moks-cms #181).

**Crew jobs (2026-11-21).** The Newsroom's pages moved under AI & SEO and old `/admin/news/*` addresses redirect
(`src/lib/news/old-addresses.ts`): Jobs → `/admin/crewai/jobs`, Run history → Job runs, Sources / Topics / Profiles &
playground / Analytics → `/admin/content/*`. The news settings page is gone; each value is on the page that owns it
(`src/lib/news/settings-fields.ts`). The CrewAI console's Schedules page is the System jobs tab of Jobs.

Below the entries: **Help** (the user manual) and **Collapse menu**.

**AI & SEO (2026-11-21).** "AI room" and "SEO & insights" became one entry. Only the menu moved: every page kept its
address, so bookmarks and links still work. What moved where:

| Before | Now |
|---|---|
| AI room → CrewAI console, Flow runs, Flows, Schedules, Crews, CrewAI import / export, Skills | AI & SEO → Agent (Import / export is the last one) |
| AI room → ML models, LanceDB | AI & SEO → Models & data |
| AI room → Automation & AI | AI & SEO → Settings → Settings |
| AI room → MCP access | AI & SEO → Settings → MCP access |
| SEO & insights → Traffic, Content, Authority & health | AI & SEO → the same three headings |

A sub-heading is drawn above the first page a person can see under it (`arrangeMenu`), so a heading is not lost when
the page that declares it is hidden from them. Posts (Editorial) has a sub-heading too.

## The admin bar (2026-11-20)

A dark toolbar fixed at the top of every page for staff, on the public site and in the admin, like WordPress's
(`src/components/admin-bar/AdminBar.tsx`, `src/lib/admin-bar.ts`). Left to right: Dashboard (on the site; its arrow
opens a short admin menu) or Visit site (in the admin), **New** (post, page, media; invoice and user for admins), the
page's own link (Edit post / Edit page / Customize homepage / Edit categories… on the site, View post or View page in
the editor once it is live), the Comments, Messages and Review queue counts, **Cache** (admins), and the person's menu
(profile, account, Hide/Show toolbar on the site, Sign out). 44 px high on phones (icons only), 32 px from 768 px.

- **Never in cached HTML.** Public pages are cached for everyone (the ISR page cache and any CDN in front, which keys
  on the URL only), so the bar is drawn in the browser after the session says the reader is staff, with its data from
  `GET /api/admin/bar?path=…` (no-store; authors get only their own Edit links).
- **No layout jump.** A hint cookie, `moks-adminbar` (`on` / `off`, readable by scripts, grants nothing), lets a
  head script add `html.has-adminbar` before the first paint; the bar's height is `--adminbar-h` (0 for readers) and
  every sticky element offsets by `--spacing-chrome` (header + bar). The cookie is set by the bar API on a staff
  member's first page and removed when the session ends; `off` is kept (the person hid the bar on the site).
- **Not shown** in `/preview/*`, inside frames (the device previews), in the editor's focus mode, or in print.

- **One address is new:** Email moved out of Storage & email to `/admin/email`. Every other page is where it was.
  Menus, Homepage, Typography & colours and General are sections of Appearance & settings
  (`/admin/appearance?section=…`); the editor now follows such a link when it is already open.
- **Filter menu** finds a page by name across all entries (every word typed must appear in the page's name, its short
  name, its sub-heading or its entry). Enter opens the first match, Escape clears.
- **Pins:** the star beside a page pins it; pinned pages are listed first under "Pinned" (at most 8), directly in the
  sidebar on a tablet or desktop.
- **Collapse menu** narrows the sidebar to icons on a tablet or desktop; an icon opens its panel the same way. On a
  phone the setting changes nothing.
- An entry shows the total of its badges while its pages are not shown; in the narrow menu a dot marks an entry with
  something waiting.
- Authors see only what they may open: Dashboard, Posts, Media, Pages, Community (Comments), Practice and Your account.

## How it is built

| Concern | File |
|---|---|
| Which pages a person may see, and the badge counts | `src/app/admin/layout.tsx` (the `items` list) |
| Where each page sits: entry, order, short name, sub-heading | `src/lib/admin-menu.ts` (`MENU_GROUPS`, `MENU_PLACES`, `arrangeMenu`) |
| Current page, filter, preferences cookie | `src/lib/admin-menu.ts` (`currentOf`, `filterMenu`, `readNavPrefs`) |
| The sidebar | `src/components/admin/AdminNav.tsx` (`AdminSidebar`), icons in `menu-icons.tsx` |
| Tests | `tests/admin-nav.test.tsx` |

**Adding a page:** add it to `items` in the layout (role, badge) and give it a place in `MENU_PLACES`. A page without
a place is not lost: it shows in an entry named after its `section`, after the known entries, and
`tests/admin-nav.test.tsx` fails until it has a place. `tests/user-guide.test.ts` still requires a guide entry for it.

**What is remembered, and where:**

- Which entries are open: `localStorage` (`admin-nav-open-v2`), applied after the page loads, as before.
- The narrow menu and the pins: one cookie, `admin_nav`, path `/admin`, one year, `SameSite=Lax`, set by the browser
  when a person changes them. The layout reads it, so the sidebar is drawn the way it was left (a preference kept
  only in `localStorage` would make the sidebar jump after every page load). It holds
  `{"rail":true,"pins":["/admin/posts"]}` and nothing about the person; `readNavPrefs` drops anything unexpected.
  It is not sent to `/api/*` or to public pages.

The current page is the menu link with the longest matching path; a link with a query (`?section=theme`) matches only
that page and query, and then wins over the plain link to the same page.
