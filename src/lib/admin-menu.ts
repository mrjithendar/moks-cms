/**
 * How the admin menu is arranged (components/admin/AdminNav.tsx draws it).
 *
 * `app/admin/layout.tsx` still decides WHICH pages a person may see (their role) and counts the badges; this file
 * decides WHERE each page sits: its top-level group, its order and the short name it has inside the group. A page the
 * layout lists but this file does not know is not lost: it lands in a group named after its old category, after the
 * known groups, so adding a page never needs a change here to be reachable.
 *
 * Pure and dependency-free: the layout (server), the menu (browser) and the tests all import it.
 */

export type NavItem = { href: string; label: string; badge?: number; section: string; exact?: boolean };

export type MenuIconName =
  | "dashboard"
  | "posts"
  | "editorial"
  | "media"
  | "pages"
  | "comments"
  | "inbox"
  | "billing"
  | "ai"
  | "insights"
  | "practice"
  | "appearance"
  | "users"
  | "tools"
  | "settings"
  | "help"
  | "pin"
  | "more";

type GroupDef = {
  id: string;
  label: string;
  icon: MenuIconName;
  /** The group's name for someone who cannot see `unless` (authors have a profile but no Users page). */ alt?: { unless: string; label: string };
  /** A line above the group, as WordPress draws between the core content menus, the plugin menus and the site menus. */ separator?: boolean;
};

/**
 * Top-level groups, in menu order: WordPress's own (owner, 2026-11-21: "reorganize all the menus in wordpress style").
 * Dashboard; the content menus (Posts, Media, Pages, Comments); then, like plugin menus (WooCommerce, Yoast), AI & SEO,
 * Billing and Practice; then Appearance, Users, Tools and Settings. Every group opens a submenu, even one with a
 * single page.
 */
export const MENU_GROUPS: GroupDef[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "posts", label: "Posts", icon: "posts", separator: true },
  { id: "media", label: "Media", icon: "media" },
  { id: "pages", label: "Pages", icon: "pages" },
  { id: "comments", label: "Comments", icon: "comments" },
  // The SEO agent, its flows and crews and what they work from (no Newsroom since 2026-11-21, no jobs since 2026-11-23).
  // Drawn only while the SEO agent module is set up (lib/modules.ts menuForModules, D-100).
  { id: "ai", label: "AI & SEO", icon: "ai", separator: true },
  { id: "billing", label: "Billing", icon: "billing" },
  { id: "practice", label: "Practice", icon: "practice" },
  { id: "appearance", label: "Appearance", icon: "appearance", separator: true },
  { id: "users", label: "Users", icon: "users", alt: { unless: "/admin/users", label: "Your account" } },
  { id: "tools", label: "Tools", icon: "tools" },
  { id: "settings", label: "Settings", icon: "settings" },
];

type Place = { group: string; /** Name inside the group, when the page's own label would repeat the group's. */ title?: string; /** Sub-heading above this page and the ones after it in the group, up to the next heading. */ heading?: string };

/** Every known page: its group, and (by position here) its order within the group. */
export const MENU_PLACES: [href: string, place: Place][] = [
  ["/admin", { group: "dashboard", title: "Home" }],

  // Posts, as in WordPress; the editorial calendar, the review queue and promotion sit under it like editorial plugins.
  ["/admin/posts", { group: "posts", title: "All posts" }],
  ["/admin/posts/new", { group: "posts", title: "Add new post" }],
  ["/admin/categories", { group: "posts" }],
  ["/admin/tags", { group: "posts" }],
  ["/admin/calendar", { group: "posts", heading: "Editorial" }],
  ["/admin/review", { group: "posts" }],
  ["/admin/promotion", { group: "posts" }],

  ["/admin/media", { group: "media", title: "Library" }],

  ["/admin/pages", { group: "pages", title: "All pages" }],
  ["/admin/pages/new", { group: "pages", title: "Add new page" }],
  ["/admin/appearance?section=hireMe", { group: "pages" }],

  // Comments, and the other things people send: messages and bookings.
  ["/admin/comments", { group: "comments", title: "All comments" }],
  ["/admin/messages", { group: "comments" }],
  ["/admin/bookings", { group: "comments" }],

  // The flows (content flows, custom and built-in) and the crews they run, their runs, what they write from, the models
  // and data, what the site measures (traffic, content, authority) and the settings. No jobs since 2026-11-23: a crew job
  // is a content flow, under Flows.
  ["/admin/crewai", { group: "ai", title: "CrewAI console", heading: "Flows & crews" }],
  ["/admin/crewai/flows", { group: "ai", title: "Flows" }],
  ["/admin/crewai/runs", { group: "ai", title: "Runs" }],
  ["/admin/crewai/crews", { group: "ai", title: "Crews" }],
  ["/admin/crewai/categories", { group: "ai", title: "Categories" }],
  ["/admin/automation/skills", { group: "ai" }],
  ["/admin/crewai/config", { group: "ai", title: "Configuration" }],
  ["/admin/content/sources", { group: "ai", title: "Content sources", heading: "Content" }],
  ["/admin/content/topics", { group: "ai", title: "Topics" }],
  ["/admin/content/profiles", { group: "ai", title: "Profiles & playground" }],
  ["/admin/content/analytics", { group: "ai", title: "Content analytics" }],
  ["/admin/keywords", { group: "ai" }],
  ["/admin/recommendations", { group: "ai" }],
  ["/admin/content-audit", { group: "ai" }],
  ["/admin/links", { group: "ai" }],
  ["/admin/search", { group: "ai", heading: "Traffic" }],
  ["/admin/analytics", { group: "ai" }],
  ["/admin/page-insights", { group: "ai" }],
  ["/admin/reports", { group: "ai" }],
  ["/admin/backlinks", { group: "ai", heading: "Authority & health" }],
  ["/admin/ai-visibility", { group: "ai" }],
  ["/admin/technical", { group: "ai" }],
  ["/admin/models", { group: "ai", heading: "Models & data" }],
  ["/admin/lancedb", { group: "ai" }],
  ["/admin/automation", { group: "ai", title: "Settings", heading: "Settings" }],
  ["/admin/automation?section=mcp", { group: "ai", title: "MCP" }],

  ["/admin/invoices", { group: "billing" }],
  ["/admin/payments", { group: "billing" }],

  ["/admin/practice", { group: "practice" }],

  ["/admin/appearance", { group: "appearance", title: "Customise" }],
  ["/admin/appearance?section=navigation", { group: "appearance", title: "Menus" }],
  ["/admin/appearance?section=homepage", { group: "appearance", title: "Homepage" }],
  ["/admin/appearance?section=theme", { group: "appearance", title: "Typography & colours" }],

  ["/admin/users", { group: "users", title: "All users" }],
  ["/admin/profile", { group: "users", title: "Profile" }],
  ["/admin/api-keys", { group: "users" }],

  // Tools, as in WordPress: site health first, then import/export and the data tools, then the records.
  ["/admin/system", { group: "tools", title: "Site health" }],
  ["/admin/cache", { group: "tools" }],
  ["/admin/backups", { group: "tools", title: "Backups (export / import)" }],
  ["/admin/sync", { group: "tools" }],
  ["/admin/database", { group: "tools" }],
  ["/admin/audit", { group: "tools" }],

  ["/admin/appearance?section=general", { group: "settings", title: "General" }],
  ["/admin/integrations", { group: "settings" }],
  ["/admin/storage", { group: "settings", title: "Media & storage" }],
  ["/admin/email", { group: "settings" }],
];

/** The manual is help, not a place to work: it is drawn at the foot of the menu, outside the groups. */
export const HELP_HREF = "/admin/user-manual";

/** A page as the menu shows it: `title` inside its group, `label` (its full name) where there is no group around it. */
export type MenuEntry = NavItem & { title: string; heading?: string };
export type MenuGroup = { id: string; label: string; icon: MenuIconName; items: MenuEntry[]; badge: number; /** Draw a line above it (GroupDef.separator; never above the first group shown). */ separator?: boolean };
export type Menu = { groups: MenuGroup[]; help: MenuEntry | null };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Put the pages a person may see into groups. Groups without a page for them are left out. */
/** The sub-heading each page sits under: its own, or the nearest one above it in the same group. */
function headings(): Map<string, string> {
  const last = new Map<string, string>();
  const out = new Map<string, string>();
  for (const [href, p] of MENU_PLACES) {
    if (p.heading) last.set(p.group, p.heading);
    const h = last.get(p.group);
    if (h) out.set(href, h);
  }
  return out;
}

export function arrangeMenu(items: NavItem[]): Menu {
  const order = new Map(MENU_PLACES.map(([href], i) => [href, i]));
  const under = headings();
  const place = new Map(MENU_PLACES);
  const byGroup = new Map<string, MenuEntry[]>();
  const extra = new Map<string, { label: string; items: MenuEntry[] }>();
  let help: MenuEntry | null = null;

  for (const item of items) {
    if (item.href === HELP_HREF) {
      help = { ...item, title: item.label };
      continue;
    }
    const p = place.get(item.href);
    if (p) {
      const list = byGroup.get(p.group) ?? [];
      list.push({ ...item, title: p.title ?? item.label });
      byGroup.set(p.group, list);
    } else {
      const id = `more-${slug(item.section) || "pages"}`;
      const group = extra.get(id) ?? { label: item.section || "More", items: [] };
      group.items.push({ ...item, title: item.label });
      extra.set(id, group);
    }
  }

  const total = (list: MenuEntry[]) => list.reduce((n, i) => n + (i.badge ?? 0), 0);
  const groups: MenuGroup[] = [];
  for (const def of MENU_GROUPS) {
    const list = byGroup.get(def.id);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => (order.get(a.href) ?? 0) - (order.get(b.href) ?? 0));
    // A heading is drawn above the first page a person can see under it, so it survives when the page that
    // declares it is not theirs to see.
    let shown: string | undefined;
    for (const entry of list) {
      const h = under.get(entry.href);
      if (h && h !== shown) entry.heading = h;
      shown = h ?? shown;
    }
    const label = def.alt && !list.some((i) => i.href === def.alt?.unless) ? def.alt.label : def.label;
    groups.push({ id: def.id, label, icon: def.icon, items: list, badge: total(list), ...(def.separator && groups.length > 0 ? { separator: true } : {}) });
  }
  let first = true;
  for (const [id, g] of extra) {
    groups.push({ id, label: g.label, icon: "more", items: g.items, badge: total(g.items), ...(first && groups.length > 0 ? { separator: true } : {}) });
    first = false;
  }
  return { groups, help };
}

// --- Which page is the current one ----------------------------------------------------------------------------------

type Query = { get(name: string): string | null } | null | undefined;

/**
 * How well a menu link fits the address: -1 when it does not. A link with a query (?section=theme) fits only that
 * exact page and query, and then beats the plain link to the same page; otherwise the longest path wins, so
 * /admin/automation/skills does not also light up Automation.
 */
function fit(item: NavItem, pathname: string, query: Query): number {
  const [path = "", search = ""] = item.href.split("?");
  const onPath = item.exact || path === "/admin" ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
  if (!onPath) return -1;
  if (!search) return path.length * 2;
  if (pathname !== path || !query) return -1;
  for (const [k, v] of new URLSearchParams(search)) if (query.get(k) !== v) return -1;
  return path.length * 2 + 1;
}

/** The one current page among `items`, or undefined when the address is none of them. */
export function currentOf<T extends NavItem>(items: T[], pathname: string, query?: Query): T | undefined {
  let best: T | undefined;
  let bestFit = -1;
  for (const item of items) {
    const f = fit(item, pathname, query);
    if (f > bestFit) {
      best = item;
      bestFit = f;
    }
  }
  return best;
}

// --- Filter ---------------------------------------------------------------------------------------------------------

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export type MenuMatch = { entry: MenuEntry; group: string };

/** Pages whose name, in-group name, sub-heading or group contains every word typed. */
export function filterMenu(menu: Menu, text: string): MenuMatch[] {
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: MenuMatch[] = [];
  for (const g of menu.groups) {
    let heading = "";
    for (const entry of g.items) {
      heading = entry.heading ?? heading;
      const hay = fold(`${entry.label} ${entry.title} ${g.label} ${heading}`);
      if (words.every((w) => hay.includes(w))) out.push({ entry, group: g.label });
    }
  }
  if (menu.help && words.every((w) => fold(`${menu.help?.label ?? ""} help`).includes(w))) out.push({ entry: menu.help, group: "Help" });
  return out;
}

// --- What a person chose: the narrow menu and their pinned pages ------------------------------------------------------

/** Kept in one small cookie (path /admin), so the server draws the menu as it was left: no jump after the page loads. */
export const NAV_PREFS_COOKIE = "admin_nav";
export const MAX_PINS = 8;
export type NavPrefs = { rail: boolean; pins: string[] };

const PIN = /^\/admin(\/[A-Za-z0-9_-]+)*(\?[A-Za-z0-9_=&-]+)?$/;

/** Read the cookie's value. Anything unexpected (it is sent by the browser, so it can be anything) is dropped. */
export function readNavPrefs(value: string | null | undefined): NavPrefs {
  const none: NavPrefs = { rail: false, pins: [] };
  if (!value || value.length > 2000) return none;
  try {
    const v = JSON.parse(decodeURIComponent(value)) as { rail?: unknown; pins?: unknown } | null;
    if (typeof v !== "object" || v === null) return none;
    const pins = Array.isArray(v.pins) ? [...new Set(v.pins.filter((p): p is string => typeof p === "string" && p.length <= 100 && PIN.test(p)))].slice(0, MAX_PINS) : [];
    return { rail: v.rail === true, pins };
  } catch {
    return none;
  }
}

/** The cookie's value for `prefs`. */
export const writeNavPrefs = (prefs: NavPrefs): string => encodeURIComponent(JSON.stringify({ rail: prefs.rail, pins: prefs.pins.slice(0, MAX_PINS) }));
