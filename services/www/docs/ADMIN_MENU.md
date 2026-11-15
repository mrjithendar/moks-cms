# The admin menu

Status: reorganised 2026-11-15 (owner request, first step of the admin UI plan). The look has **not been seen in a
browser** by its author: check it on a desktop and a phone after deploying.

## What a person sees

One entry per area of work, each with an icon. An entry with several pages opens to show them; an entry with one page
is a link.

| Entry | Pages |
|---|---|
| Dashboard | Home |
| Posts | All posts, Add new, Categories, Tags, Editorial calendar, Review queue |
| Media | Library |
| Pages | All pages, Add new, Hire me page |
| Comments | Comments |
| Inbox | Messages, Bookings |
| Billing | Invoices (when that page exists), Payments |
| AI newsroom | News desk, Promotion, Automation & AI, ML models, MCP access |
| SEO & insights | **Traffic:** Search performance, Visitor analytics, Page insights, Reports. **Content:** Keywords, Recommendations, Content audit, Internal linking. **Authority & health:** Backlinks, AI visibility, Technical health |
| Practice | Python practice |
| Appearance | Customise, Menus, Homepage, Typography & colours |
| Users | All users, Your profile, API keys ("Your account" for someone without the Users page) |
| Tools | Backups, Database, Data sync, Audit log, System status |
| Settings | General, Integrations, Storage & email, Advanced settings |

Below the entries: **Help** (the user manual) and **Collapse menu**.

- **No address changed.** Every page is where it was; only the grouping and some names inside a group are new.
  Menus, Homepage, Typography & colours and General are sections of Appearance & settings
  (`/admin/appearance?section=…`); the editor now follows such a link when it is already open.
- **Filter menu** finds a page by name across all entries (every word typed must appear in the page's name, its short
  name, its sub-heading or its entry). Enter opens the first match, Escape clears.
- **Pins:** the star beside a page pins it; pinned pages are listed first under "Pinned" (at most 8).
- **Collapse menu** narrows the sidebar to icons on large screens. An icon with several pages opens them in a panel
  beside it (one at a time; Escape or a click elsewhere closes it). On a phone the setting changes nothing: the Menu
  button opens the same list as before.
- A closed entry shows the total of its badges; in the narrow menu a dot marks an entry with something waiting.
- Authors see only what they may open: Dashboard, Posts, Media, Pages, Comments, Practice and Your account.

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
