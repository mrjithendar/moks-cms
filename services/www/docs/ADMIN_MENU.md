# The admin menu

Status: reorganised 2026-11-15; regrouped and changed to submenus on 2026-11-18 (owner request: "every menu should
have a submenu; no expand on desktop or tablet; expand and collapse on mobile"). Checked in Chrome on 2026-11-18 at
1440, 820 and 390 px against a local build.

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
| Posts | All posts, Add new, Categories, Tags |
| Editorial | Editorial calendar, Review queue, Promotion |
| Media | Library |
| Pages | All pages, Add new, Hire me page |
| Newsroom | Jobs, Run history, Sources, Topics, Profiles & playground, Analytics, Settings (the news desk) |
| AI room | Automation & AI (the SEO agent's flows), ML models, LanceDB, MCP access |
| SEO & insights | **Traffic:** Search performance, Visitor analytics, Page insights, Reports. **Content:** Keywords, Recommendations, Content audit, Internal linking. **Authority & health:** Backlinks, AI visibility, Technical health |
| Community | Comments, Messages, Bookings |
| Billing | Invoices, Payments |
| Practice | Python practice |
| Appearance | Customise, Menus, Homepage, Typography & colours |
| Users | All users, Your profile, API keys ("Your account" for someone without the Users page) |
| Settings | General, Integrations, Storage, Email, Advanced settings |
| System | System status, Backups, Database, Data sync, Audit log |

Below the entries: **Help** (the user manual) and **Collapse menu**.

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
