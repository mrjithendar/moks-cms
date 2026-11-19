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
  | "newsroom"
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

type GroupDef = { id: string; label: string; icon: MenuIconName; /** The group's name for someone who cannot see `unless` (authors have a profile but no Users page). */ alt?: { unless: string; label: string } };

/** Top-level groups, in menu order. Every group opens a submenu, even one with a single page. */
export const MENU_GROUPS: GroupDef[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "posts", label: "Posts", icon: "posts" },
  { id: "editorial", label: "Editorial", icon: "editorial" },
  { id: "media", label: "Media", icon: "media" },
  { id: "pages", label: "Pages", icon: "pages" },
  { id: "newsroom", label: "Newsroom", icon: "newsroom" },
  { id: "ai", label: "AI room", icon: "ai" },
  { id: "insights", label: "SEO & insights", icon: "insights" },
  { id: "community", label: "Community", icon: "comments" },
  { id: "billing", label: "Billing", icon: "billing" },
  { id: "practice", label: "Practice", icon: "practice" },
  { id: "appearance", label: "Appearance", icon: "appearance" },
  { id: "users", label: "Users", icon: "users", alt: { unless: "/admin/users", label: "Your account" } },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "system", label: "System", icon: "tools" },
];

type Place = { group: string; /** Name inside the group, when the page's own label would repeat the group's. */ title?: string; /** Sub-heading above this page and the ones after it. */ heading?: string };

/** Every known page: its group, and (by position here) its order within the group. */
export const MENU_PLACES: [href: string, place: Place][] = [
  ["/admin", { group: "dashboard", title: "Home" }],

  ["/admin/posts", { group: "posts", title: "All posts" }],
  ["/admin/posts/new", { group: "posts", title: "Add new" }],
  ["/admin/categories", { group: "posts" }],
  ["/admin/tags", { group: "posts" }],

  // Planning, drafting and promoting: from an idea to a published, shared article.
  ["/admin/calendar", { group: "editorial" }],
  ["/admin/review", { group: "editorial" }],
  ["/admin/promotion", { group: "editorial" }],

  ["/admin/media", { group: "media", title: "Library" }],

  ["/admin/pages", { group: "pages", title: "All pages" }],
  ["/admin/pages/new", { group: "pages", title: "Add new" }],
  ["/admin/appearance?section=hireMe", { group: "pages" }],

  // The news desk: watched sources turned into news drafts.
  ["/admin/news", { group: "newsroom", title: "Jobs" }],
  ["/admin/news/runs", { group: "newsroom" }],
  ["/admin/news/sources", { group: "newsroom" }],
  ["/admin/news/topics", { group: "newsroom" }],
  ["/admin/news/profiles", { group: "newsroom" }],
  ["/admin/news/analytics", { group: "newsroom" }],
  ["/admin/news/settings", { group: "newsroom" }],

  // The AI that works on the site: the SEO agent's flows, its models and data, and access for AI clients.
  ["/admin/crewai", { group: "ai", title: "CrewAI console" }],
  ["/admin/crewai/runs", { group: "ai", title: "Flow runs" }],
  ["/admin/crewai/flows", { group: "ai", title: "Flows" }],
  ["/admin/crewai/schedules", { group: "ai", title: "Schedules" }],
  ["/admin/crewai/crews", { group: "ai", title: "Crews" }],
  ["/admin/crewai/config", { group: "ai", title: "CrewAI import / export" }],
  ["/admin/automation", { group: "ai" }],
  ["/admin/automation/skills", { group: "ai" }],
  ["/admin/models", { group: "ai" }],
  ["/admin/lancedb", { group: "ai" }],
  ["/admin/automation/mcp", { group: "ai" }],

  ["/admin/search", { group: "insights", heading: "Traffic" }],
  ["/admin/analytics", { group: "insights" }],
  ["/admin/page-insights", { group: "insights" }],
  ["/admin/reports", { group: "insights" }],
  ["/admin/keywords", { group: "insights", heading: "Content" }],
  ["/admin/recommendations", { group: "insights" }],
  ["/admin/content-audit", { group: "insights" }],
  ["/admin/links", { group: "insights" }],
  ["/admin/backlinks", { group: "insights", heading: "Authority & health" }],
  ["/admin/ai-visibility", { group: "insights" }],
  ["/admin/technical", { group: "insights" }],

  ["/admin/comments", { group: "community" }],
  ["/admin/messages", { group: "community" }],
  ["/admin/bookings", { group: "community" }],

  ["/admin/invoices", { group: "billing" }],
  ["/admin/payments", { group: "billing" }],

  ["/admin/practice", { group: "practice" }],

  ["/admin/appearance", { group: "appearance", title: "Customise" }],
  ["/admin/appearance?section=navigation", { group: "appearance", title: "Menus" }],
  ["/admin/appearance?section=homepage", { group: "appearance", title: "Homepage" }],
  ["/admin/appearance?section=theme", { group: "appearance", title: "Typography & colours" }],

  ["/admin/users", { group: "users", title: "All users" }],
  ["/admin/profile", { group: "users", title: "Your profile" }],
  ["/admin/api-keys", { group: "users" }],

  ["/admin/appearance?section=general", { group: "settings", title: "General" }],
  ["/admin/integrations", { group: "settings" }],
  ["/admin/storage", { group: "settings" }],
  ["/admin/email", { group: "settings" }],
  ["/admin/advanced", { group: "settings" }],

  ["/admin/system", { group: "system" }],
  ["/admin/backups", { group: "system" }],
  ["/admin/database", { group: "system" }],
  ["/admin/sync", { group: "system" }],
  ["/admin/audit", { group: "system" }],
];

/** The manual is help, not a place to work: it is drawn at the foot of the menu, outside the groups. */
export const HELP_HREF = "/admin/user-manual";

/** A page as the menu shows it: `title` inside its group, `label` (its full name) where there is no group around it. */
export type MenuEntry = NavItem & { title: string; heading?: string };
export type MenuGroup = { id: string; label: string; icon: MenuIconName; items: MenuEntry[]; badge: number };
export type Menu = { groups: MenuGroup[]; help: MenuEntry | null };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Put the pages a person may see into groups. Groups without a page for them are left out. */
export function arrangeMenu(items: NavItem[]): Menu {
  const order = new Map(MENU_PLACES.map(([href], i) => [href, i]));
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
      list.push({ ...item, title: p.title ?? item.label, heading: p.heading });
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
    const label = def.alt && !list.some((i) => i.href === def.alt?.unless) ? def.alt.label : def.label;
    groups.push({ id: def.id, label, icon: def.icon, items: list, badge: total(list) });
  }
  for (const [id, g] of extra) groups.push({ id, label: g.label, icon: "more", items: g.items, badge: total(g.items) });
  return { groups, help };
}

// --- Which page is the current one ----------------------------------------------------------------------------------

type Query = { get(name: string): string | null } | null | undefined;

/**
 * How well a menu link fits the address: -1 when it does not. A link with a query (?section=theme) fits only that
 * exact page and query, and then beats the plain link to the same page; otherwise the longest path wins, so
 * /admin/automation/mcp does not also light up Automation.
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
