// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/admin/keywords";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const { AdminNav, NAV_STORE_KEY, currentOf } = await import("@/components/admin/AdminNav");
type NavItem = Parameters<typeof AdminNav>[0]["items"][number];

const ITEMS: NavItem[] = [
  { href: "/admin", label: "Dashboard", section: "Overview" },
  { href: "/admin/posts", label: "Posts", section: "Content" },
  { href: "/admin/review", label: "Review queue", badge: 3, section: "Editorial & AI" },
  { href: "/admin/news", label: "News desk", section: "Editorial & AI" },
  { href: "/admin/keywords", label: "Keywords", section: "Insights" },
  { href: "/admin/messages", label: "Messages", badge: 2, section: "Community" },
  { href: "/admin/automation", label: "Automation & AI", section: "Site settings" },
  { href: "/admin/automation/mcp", label: "MCP access", section: "Site settings" },
];

let container: HTMLDivElement;
let root: Root;
const header = (section: string) => container.querySelector<HTMLButtonElement>(`[data-section="${section}"] > button`)!;
const list = (section: string) => container.querySelector<HTMLUListElement>(`[data-section="${section}"] > ul`)!;
const render = () => act(() => root.render(<AdminNav items={ITEMS} />));

beforeEach(() => {
  pathname = "/admin/keywords";
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("admin sidebar categories", () => {
  it("renders every category as a disclosure: Overview and the current page's category open, the rest collapsed", () => {
    render();
    for (const s of ["Overview", "Insights"]) {
      expect(header(s).getAttribute("aria-expanded")).toBe("true");
      expect(list(s).hidden).toBe(false);
    }
    for (const s of ["Content", "Editorial & AI", "Community", "Site settings"]) {
      expect(header(s).getAttribute("aria-expanded")).toBe("false");
      expect(list(s).hidden).toBe(true);
    }
    expect(header("Insights").getAttribute("aria-controls")).toBe(list("Insights").id);
    expect(container.querySelector('a[aria-current="page"]')!.textContent).toBe("Keywords");
  });

  it("server and first browser render agree (no hydration mismatch)", () => {
    const html = renderToStaticMarkup(<AdminNav items={ITEMS} />);
    expect(html).toContain('aria-expanded="true"');
    expect((html.match(/hidden=""/g) ?? []).length).toBe(4);
  });

  it("a collapsed category shows the total of its badges, an open one shows them per item", () => {
    render();
    expect(header("Editorial & AI").textContent).toContain("3");
    expect(header("Community").textContent).toContain("2");
    act(() => header("Community").click());
    expect(header("Community").textContent).not.toContain("2");
    expect(list("Community").textContent).toContain("2");
  });

  it("toggling expands and collapses a category and remembers the choice", () => {
    render();
    act(() => header("Content").click());
    expect(list("Content").hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem(NAV_STORE_KEY)!)).toContain("Content");
    act(() => header("Content").click());
    expect(list("Content").hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(NAV_STORE_KEY)!)).not.toContain("Content");
  });

  it("applies saved choices after mounting, but always opens the current page's category", () => {
    localStorage.setItem(NAV_STORE_KEY, JSON.stringify(["Community", "Unknown"]));
    render();
    expect(list("Community").hidden).toBe(false);
    expect(list("Overview").hidden).toBe(true); // closed earlier by the reader
    expect(list("Insights").hidden).toBe(false); // the current page's category
  });

  it("navigating to another category opens it", () => {
    render();
    pathname = "/admin/automation/mcp";
    render();
    expect(list("Site settings").hidden).toBe(false);
    expect(container.querySelector('a[aria-current="page"]')!.textContent).toBe("MCP access");
  });

  it("Expand all / Collapse all (collapse keeps Overview and the current category)", () => {
    render();
    const toggleAll = () => [...container.querySelectorAll("button")].find((b) => /all$/.test(b.textContent ?? ""))!;
    expect(toggleAll().textContent).toBe("Expand all");
    act(() => toggleAll().click());
    expect(["Overview", "Content", "Editorial & AI", "Insights", "Community", "Site settings"].every((s) => !list(s).hidden)).toBe(true);
    expect(toggleAll().textContent).toBe("Collapse all");
    act(() => toggleAll().click());
    expect(list("Content").hidden).toBe(true);
    expect(list("Insights").hidden).toBe(false);
  });

  it("works when storage is blocked", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render();
    act(() => header("Content").click());
    expect(list("Content").hidden).toBe(false);
    spy.mockRestore();
  });

  it("the current item is the longest matching link", () => {
    expect(currentOf(ITEMS, "/admin/automation/mcp")?.label).toBe("MCP access");
    expect(currentOf(ITEMS, "/admin/automation")?.label).toBe("Automation & AI");
    expect(currentOf(ITEMS, "/admin")?.label).toBe("Dashboard");
  });
});
