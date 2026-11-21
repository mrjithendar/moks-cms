// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavItem, NavPrefs } from "@/lib/admin-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/admin/keywords";
let search = "";
const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useSearchParams: () => new URLSearchParams(search), useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const { AdminSidebar, NAV_STORE_KEY } = await import("@/components/admin/AdminNav");
const { arrangeMenu, currentOf, filterMenu, HELP_HREF, MENU_GROUPS, MENU_PLACES, NAV_PREFS_COOKIE, readNavPrefs, writeNavPrefs } = await import("@/lib/admin-menu");

// What the layout would list for an admin (a sample), plus a page the menu has never heard of.
const ITEMS: NavItem[] = [
  { href: "/admin", label: "Dashboard", section: "Overview" },
  { href: "/admin/user-manual", label: "User manual", section: "Overview" },
  { href: "/admin/posts", label: "Posts", section: "Content" },
  { href: "/admin/posts/new", label: "New post", section: "Content" },
  { href: "/admin/media", label: "Media", section: "Content" },
  { href: "/admin/categories", label: "Categories", section: "Content" },
  { href: "/admin/review", label: "Review queue", badge: 3, section: "Editorial & AI" },
  { href: "/admin/keywords", label: "Keywords", section: "Insights" },
  { href: "/admin/search", label: "Search performance", section: "Insights" },
  { href: "/admin/comments", label: "Comments", badge: 4, section: "Community" },
  { href: "/admin/messages", label: "Messages", badge: 2, section: "Community" },
  { href: "/admin/bookings", label: "Bookings", section: "Community" },
  { href: "/admin/appearance", label: "Appearance & settings", section: "Site settings" },
  { href: "/admin/appearance?section=theme", label: "Typography & colours", section: "Site settings" },
  { href: "/admin/appearance?section=general", label: "General settings", section: "Site settings" },
  { href: "/admin/automation", label: "Automation & AI", section: "Site settings" },
  { href: "/admin/automation/mcp", label: "MCP access", section: "Site settings" },
  { href: "/admin/automation/skills", label: "Skills", section: "Site settings" },
  { href: "/admin/somewhere-new", label: "Brand new page", section: "Operations" },
];

let container: HTMLDivElement;
let root: Root;
let wideScreen = true;
const group = (id: string) => container.querySelector<HTMLLIElement>(`[data-group="${id}"]`);
const header = (id: string) => container.querySelector<HTMLButtonElement>(`[data-group="${id}"] > button`)!;
const list = (id: string) => container.querySelector<HTMLUListElement>(`[data-group="${id}"] > ul`)!;
const currentLink = () => container.querySelector('a[aria-current="page"]');
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name)!;
const filterBox = () => container.querySelector<HTMLInputElement>('input[type="search"]')!;
const render = (prefs?: NavPrefs) => act(() => root.render(<AdminSidebar items={ITEMS} role="admin" prefs={prefs} />));
function type(value: string) {
  const el = filterBox();
  act(() => {
    // React tracks the value it last set; the element's own setter is how a real keystroke changes it.
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (set) set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
// The last cookie the menu wrote (captured, so the test does not depend on the test browser's cookie rules).
let written = "";
const cookie = () => readNavPrefs(new RegExp(`^${NAV_PREFS_COOKIE}=([^;]+)`).exec(written)?.[1]);

beforeEach(() => {
  pathname = "/admin/keywords";
  search = "";
  wideScreen = true;
  push.mockClear();
  localStorage.clear();
  written = "";
  Object.defineProperty(document, "cookie", { configurable: true, get: () => written, set: (value: string) => void (written = value) });
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: (query: string) => ({ matches: wideScreen, media: query, addEventListener() {}, removeEventListener() {} }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("how the menu is arranged (lib/admin-menu.ts)", () => {
  it("puts pages into groups, in order, with their short names, sub-headings and badge totals", () => {
    const { groups, help } = arrangeMenu(ITEMS);
    expect(groups.map((g) => g.id)).toEqual(["dashboard", "posts", "media", "comments", "ai", "appearance", "settings", "more-operations"]);
    // WordPress style: a line above the content menus, the plugin-like menus (AI & SEO…) and the site menus.
    expect(groups.filter((g) => g.separator).map((g) => g.id)).toEqual(["posts", "ai", "appearance", "more-operations"]);
    const by = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(by.posts!.items.map((i) => i.title)).toEqual(["All posts", "Add new post", "Categories", "Review queue"]);
    expect(by.posts!.items.map((i) => i.label)).toEqual(["Posts", "New post", "Categories", "Review queue"]);
    expect(by.posts!.items.map((i) => i.heading)).toEqual([undefined, undefined, undefined, "Editorial"]); // the editorial pages sit under Posts
    // AI & SEO: the crew jobs, content, what the site measures, then its settings; a sub-heading sits on the first page under it.
    expect(by.ai!.label).toBe("AI & SEO");
    expect(by.ai!.items.map((i) => [i.title, i.heading])).toEqual([["Skills", "Crew jobs"], ["Keywords", "Content"], ["Search performance", "Traffic"], ["Settings", "Settings"], ["MCP access", undefined]]);
    expect(by.comments!.items.map((i) => i.title)).toEqual(["All comments", "Messages", "Bookings"]);
    expect(by.appearance!.items.map((i) => i.title)).toEqual(["Customise", "Typography & colours"]);
    expect(by.settings!.items.map((i) => i.title)).toEqual(["General"]);
    expect([by.posts!.badge, by.comments!.badge, by.media!.badge]).toEqual([3, 6, 0]);
    // The manual is help, drawn at the foot of the menu.
    expect(help?.href).toBe(HELP_HREF);
    expect(groups.flatMap((g) => g.items).some((i) => i.href === HELP_HREF)).toBe(false);
  });

  it("never loses a page it does not know: it gets a group named after its old category", () => {
    const more = arrangeMenu(ITEMS).groups.at(-1)!;
    expect(more).toMatchObject({ id: "more-operations", label: "Operations", icon: "more" });
    expect(more.items.map((i) => i.title)).toEqual(["Brand new page"]);
  });

  it("leaves out groups with nothing for this person, and calls Users “Your account” for someone without the Users page", () => {
    const author = arrangeMenu([
      { href: "/admin", label: "Dashboard", section: "Overview" },
      { href: "/admin/posts", label: "Posts", section: "Content" },
      { href: "/admin/profile", label: "Author profile", section: "Account" },
      { href: "/admin/api-keys", label: "API keys", section: "Account" },
    ]);
    expect(author.groups.map((g) => g.label)).toEqual(["Dashboard", "Posts", "Your account"]);
    expect(author.groups.at(-1)!.items.map((i) => i.title)).toEqual(["Profile", "API keys"]);
    expect(arrangeMenu([...ITEMS, { href: "/admin/users", label: "Users", section: "Site settings" }]).groups.find((g) => g.id === "users")?.label).toBe("Users");
  });

  it("knows a place for every page the admin layout lists, in a group that exists", () => {
    const layout = readFileSync(path.resolve(__dirname, "../src/app/admin/layout.tsx"), "utf8");
    const listed = [...layout.matchAll(/href: "(\/admin[^"]*)"/g)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(40);
    const placed = new Set(MENU_PLACES.map(([href]) => href));
    expect(listed.filter((href) => href !== HELP_HREF && !placed.has(href)), "pages without a place in lib/admin-menu.ts (they would show under their old category)").toEqual([]);
    const ids = new Set(MENU_GROUPS.map((g) => g.id));
    expect(MENU_PLACES.filter(([, place]) => !ids.has(place.group)).map(([href]) => href)).toEqual([]);
    expect(new Set(MENU_PLACES.map(([href]) => href)).size).toBe(MENU_PLACES.length);
  });

  it("the current page is the longest matching link, and a link with a query only matches that query", () => {
    expect(currentOf(ITEMS, "/admin/automation/mcp")?.label).toBe("MCP access");
    expect(currentOf(ITEMS, "/admin/automation/skills")?.label).toBe("Skills");
    expect(currentOf(ITEMS, "/admin/automation")?.label).toBe("Automation & AI");
    expect(currentOf(ITEMS, "/admin")?.label).toBe("Dashboard");
    expect(currentOf(ITEMS, "/admin/posts/new")?.label).toBe("New post");
    expect(currentOf(ITEMS, "/admin/posts/8c1f")?.label).toBe("Posts");
    expect(currentOf(ITEMS, "/admin/appearance", new URLSearchParams("section=theme"))?.label).toBe("Typography & colours");
    expect(currentOf(ITEMS, "/admin/appearance", new URLSearchParams("section=footer"))?.label).toBe("Appearance & settings");
    expect(currentOf(ITEMS, "/admin/appearance")?.label).toBe("Appearance & settings");
    expect(currentOf(ITEMS, "/admin/nowhere")).toBeUndefined();
  });

  it("filters by every word typed, across names, short names, sub-headings and groups", () => {
    const menu = arrangeMenu(ITEMS);
    const found = (text: string) => filterMenu(menu, text).map((m) => m.entry.label);
    expect(found("key")).toEqual(["Keywords"]);
    expect(found("add new")).toEqual(["New post"]);
    expect(found("traffic")).toEqual(["Search performance"]);
    expect(found("comments")).toEqual(["Comments", "Messages", "Bookings"]);
    expect(found("HELP")).toEqual(["User manual"]);
    expect(found("  ")).toEqual([]);
    expect(found("zzz")).toEqual([]);
    expect(filterMenu(menu, "key")[0]!.group).toBe("AI & SEO");
    expect(found("settings mcp")).toEqual(["MCP access"]); // found by the sub-heading it sits under
  });

  it("reads the preferences cookie defensively", () => {
    expect(readNavPrefs(writeNavPrefs({ rail: true, pins: ["/admin/posts", "/admin/appearance?section=theme"] }))).toEqual({ rail: true, pins: ["/admin/posts", "/admin/appearance?section=theme"] });
    for (const bad of [undefined, null, "", "not json", "%7B", encodeURIComponent("[1,2]"), encodeURIComponent('"x"'), "x".repeat(3000)]) expect(readNavPrefs(bad), String(bad)).toEqual({ rail: false, pins: [] });
    const messy = encodeURIComponent(JSON.stringify({ rail: "yes", pins: ["/admin/posts", "/admin/posts", "https://evil.example/admin", "/account", 7, "/admin/<script>", ...Array.from({ length: 20 }, (_, i) => `/admin/p${i}`)] }));
    expect(readNavPrefs(messy)).toEqual({ rail: false, pins: ["/admin/posts", ...Array.from({ length: 7 }, (_, i) => `/admin/p${i}`)] });
  });
});

describe("admin sidebar", () => {
  it("beside the page (tablet and larger), every group opens a submenu panel beside the sidebar; nothing expands in place", () => {
    render();
    // Every group is a button with a submenu, even one with a single page; none is open until it is asked for.
    for (const id of ["dashboard", "posts", "media", "comments", "ai", "appearance", "settings"]) {
      expect(header(id).getAttribute("aria-controls"), id).toBe(list(id).id);
      expect(header(id).getAttribute("aria-expanded"), id).toBe("false");
      expect(list(id).hidden, id).toBe(true);
    }
    expect(list("dashboard").querySelector("a")!.getAttribute("href")).toBe("/admin");
    // The group holding the current page is marked.
    expect(header("ai").className).toContain("md:bg-accent-soft");
    expect(currentLink()!.textContent).toBe("Keywords");

    act(() => header("posts").click());
    expect(header("posts").getAttribute("aria-expanded")).toBe("true");
    expect(list("posts").hidden).toBe(false);
    expect(list("posts").className).toContain("md:fixed");
    expect(list("posts").textContent).toContain("Posts"); // the panel names its group
    act(() => header("comments").click());
    expect(list("posts").hidden).toBe(true);
    expect(list("comments").hidden).toBe(false);
    act(() => header("comments").click());
    expect(list("comments").hidden).toBe(true);
    act(() => header("comments").click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(list("comments").hidden).toBe(true);
    act(() => header("comments").click());
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(list("comments").hidden).toBe(true);
    expect(container.querySelector(`a[href="${HELP_HREF}"]`)!.textContent).toBe("Help");
    expect(group("pinned")).toBeNull();
  });

  it("opens a submenu on hover and closes it shortly after the pointer leaves", async () => {
    render();
    act(() => {
      group("appearance")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(list("appearance").hidden).toBe(false);
    act(() => {
      group("appearance")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(list("appearance").hidden).toBe(false); // time to cross the gap to the panel
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260));
    });
    expect(list("appearance").hidden).toBe(true);
  });

  it("server and first browser render agree (no hydration mismatch)", () => {
    const html = renderToStaticMarkup(<AdminSidebar items={ITEMS} role="admin" />);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect((html.match(/ hidden=""/g) ?? []).length).toBe(7); // every group but the current one (AI & SEO)
    expect(html).not.toContain("data-rail");
    expect(renderToStaticMarkup(<AdminSidebar items={ITEMS} prefs={{ rail: true, pins: ["/admin/posts"] }} />)).toContain("data-rail");
  });

  it("a group shows the total of its badges while its pages are not shown", () => {
    render();
    expect(header("posts").textContent).toContain("3");
    expect(header("comments").textContent).toContain("6");
    act(() => header("comments").click());
    expect(header("comments").textContent).not.toContain("6");
    expect(list("comments").textContent).toContain("4");
    expect(list("comments").textContent).toContain("2");
  });

  it("on a phone, opening and closing a group is remembered in this browser", () => {
    wideScreen = false;
    render();
    act(() => header("posts").click());
    expect(list("posts").hidden).toBe(false);
    expect(list("posts").className).not.toContain("md:fixed");
    expect(JSON.parse(localStorage.getItem(NAV_STORE_KEY)!)).toContain("posts");
    act(() => header("posts").click());
    expect(list("posts").hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(NAV_STORE_KEY)!)).not.toContain("posts");
  });

  it("on a phone, applies saved choices after mounting, but always opens the current page's group", () => {
    wideScreen = false;
    localStorage.setItem(NAV_STORE_KEY, JSON.stringify(["comments", "no-such-group"]));
    render();
    expect(list("comments").hidden).toBe(false);
    expect(list("posts").hidden).toBe(true);
    expect(list("ai").hidden).toBe(false);
  });

  it("on a phone, navigating to a page in another group opens it", () => {
    wideScreen = false;
    render();
    expect(list("comments").hidden).toBe(true);
    pathname = "/admin/bookings";
    render();
    expect(list("comments").hidden).toBe(false);
    expect(currentLink()!.textContent).toBe("Bookings");
    pathname = "/admin/automation/mcp";
    render();
    expect(list("ai").hidden).toBe(false);
    expect(currentLink()!.textContent).toBe("MCP access");
  });

  it("follows the section of a page that holds several menu pages (?section=…)", () => {
    wideScreen = false;
    pathname = "/admin/appearance";
    search = "section=theme";
    render();
    expect(currentLink()!.textContent).toBe("Typography & colours");
    expect(list("appearance").hidden).toBe(false);
    search = "section=general";
    render();
    expect(currentLink()!.getAttribute("href")).toBe("/admin/appearance?section=general");
    expect(group("settings")!.contains(currentLink())).toBe(true);
    search = "section=footer";
    render();
    expect(currentLink()!.textContent).toBe("Customise");
  });

  it("filters the menu by name; Enter opens the first match and Escape clears", () => {
    render();
    type("key");
    expect(container.querySelector("[data-group]")).toBeNull();
    const results = [...container.querySelectorAll("[data-results] a")];
    expect(results.map((a) => a.getAttribute("href"))).toEqual(["/admin/keywords"]);
    expect(results[0]!.textContent).toContain("AI & SEO");
    act(() => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(push).toHaveBeenCalledWith("/admin/keywords");

    type("zzz");
    expect(container.querySelector("[data-results]")!.textContent).toContain("No page matches");
    act(() => {
      filterBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector("[data-results]")).toBeNull();
    expect(group("posts")).not.toBeNull();
  });

  it("pins pages to the top, by their full name, listed directly beside the page, and remembers them in the cookie", () => {
    render();
    act(() => header("posts").click());
    act(() => button("Pin New post").click());
    expect(container.querySelector("[data-group]")!.getAttribute("data-group")).toBe("pinned");
    expect([...list("pinned").querySelectorAll("a")].map((a) => a.textContent)).toEqual(["New post"]);
    expect(list("pinned").hidden).toBe(false);
    expect(list("pinned").className).not.toContain("md:fixed");
    expect(cookie()).toEqual({ rail: false, pins: ["/admin/posts/new"] });
    // For the admin only, kept for a year, never sent to other sites' requests.
    expect(written).toMatch(/; path=\/admin; max-age=31536000; samesite=lax/);
    expect(container.querySelectorAll('button[aria-label="Unpin New post"]')).toHaveLength(2); // under Pinned and under Posts

    act(() => button("Unpin New post").click());
    expect(group("pinned")).toBeNull();
    expect(cookie().pins).toEqual([]);
  });

  it("starts with the pins the server read from the cookie", () => {
    render({ rail: false, pins: ["/admin/keywords", "/admin/gone", "/admin/messages"] });
    expect([...list("pinned").querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Keywords", "Messages2 pending"]);
    expect(list("pinned").hidden).toBe(false);
  });

  it("collapses to icons: a group then opens as a panel beside the icons, one at a time", () => {
    render({ rail: true, pins: [] });
    const aside = container.querySelector("aside")!;
    expect(aside.hasAttribute("data-rail")).toBe(true);
    expect(aside.className).toContain("md:w-16");
    expect(header("posts").getAttribute("title")).toBe("Posts");
    expect(header("ai").getAttribute("aria-expanded")).toBe("false");

    act(() => header("posts").click());
    expect(list("posts").hidden).toBe(false);
    expect(list("posts").className).toContain("md:fixed");
    act(() => header("comments").click());
    expect(list("posts").hidden).toBe(true);
    expect(list("comments").hidden).toBe(false);

    act(() => button("Expand menu").click());
    expect(container.querySelector("aside")!.hasAttribute("data-rail")).toBe(false);
    expect(container.querySelector("aside")!.className).toContain("md:w-64");
    expect(cookie().rail).toBe(false);
    act(() => button("Collapse menu").click());
    expect(cookie().rail).toBe(true);
  });

  it("on a phone the collapsed setting changes nothing: groups open in place behind the Menu button", () => {
    wideScreen = false;
    render({ rail: true, pins: [] });
    expect(header("ai").getAttribute("aria-expanded")).toBe("true");
    act(() => header("posts").click());
    expect(list("posts").hidden).toBe(false);
    expect(list("posts").className).not.toContain("md:fixed");
    act(() => {
      group("appearance")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(list("appearance").hidden).toBe(true); // no hover menus on a phone
    const menuButton = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-controls") === "admin-nav")!;
    expect(menuButton.textContent).toContain("Menu · Keywords");
    expect(menuButton.textContent).toContain("9"); // 3 + 4 + 2 waiting
  });

  it("works when storage and cookies are blocked", () => {
    wideScreen = false;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render();
    act(() => header("posts").click());
    expect(list("posts").hidden).toBe(false);
    spy.mockRestore();
  });
});
