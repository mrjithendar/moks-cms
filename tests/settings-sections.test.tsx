// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search), useRouter: () => ({ push, replace, refresh: () => {} }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const { LEAVE_QUESTION, SettingsSections, useSettingsSection, useUnsavedChanges } = await import("@/components/admin/SettingsSections");
const { SettingsHub } = await import("@/components/admin/SettingsHub");

/**
 * The two settings layouts and the unsaved-changes guard they share: the Settings area (components/admin/SettingsHub:
 * categories and their sections, each section its own server render at /admin/settings/<category>?section=<id>) and
 * Appearance (components/admin/SettingsSections: every section kept in the browser).
 */
const SECTIONS = [
  { id: "general", label: "General" },
  { id: "theme", label: "Typography & colours", problems: 2 },
  { id: "history", label: "Revision history" },
] as const;

let container: HTMLDivElement;
let root: Root;
/** Whether the layout itself stopped the last click on a link (the unsaved-changes question was answered "stay"). */
let stopped: boolean | null = null;
const confirm = vi.fn(() => true);
const links = () => [...container.querySelectorAll<HTMLAnchorElement>("nav ul a")];
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("nav ul button")];
const select = () => container.querySelector<HTMLSelectElement>("nav select")!;
function choose(value: string) {
  act(() => {
    select().value = value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function Form({ dirty }: { dirty: boolean }) {
  useUnsavedChanges(dirty);
  return <input id="field-one" defaultValue="x" />;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // After React's own listener on the same element: note what the layout decided, then keep the test page where it is.
  container.addEventListener("click", (e) => {
    stopped = e.defaultPrevented;
    e.preventDefault();
  });
  stopped = null;
  confirm.mockReset();
  confirm.mockReturnValue(true);
  window.confirm = confirm;
  search = "";
  push.mockClear();
  replace.mockClear();
  window.history.replaceState(null, "", "/admin/settings/access");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("the Settings area: categories and their sections, each rendered by the server", () => {
  const CATEGORIES = [
    { id: "general", label: "General", href: "/admin/settings/general", sections: [{ id: "site", label: "Site identity", href: "/admin/settings/general?section=site" }] },
    {
      id: "access",
      label: "Users & access",
      href: "/admin/settings/access",
      sections: [
        { id: "social", label: "Social sign-in", href: "/admin/settings/access?section=social" },
        { id: "turnstile", label: "Human verification", href: "/admin/settings/access?section=turnstile" },
        { id: "members", label: "Members-only articles", href: "/admin/settings/access?section=members" },
      ],
    },
    { id: "email", label: "Email", href: "/admin/settings/email", sections: [{ id: "email", label: "Provider", href: "/admin/settings/email?section=email" }] },
  ];
  const listLinks = () => [...container.querySelectorAll<HTMLAnchorElement>("nav > div:last-child a")];
  const pills = () => [...container.querySelectorAll<HTMLAnchorElement>('nav ul[aria-label="Users & access sections"] a')].slice(0, 3);
  const render = (dirty = false, section = "social") =>
    act(() =>
      root.render(
        <SettingsHub categories={CATEGORIES} category="access" section={section}>
          <Form dirty={dirty} />
        </SettingsHub>,
      ),
    );

  it("lists every category, the open one with its sections, marks the open section, and offers a select and buttons on a narrow screen", () => {
    render();
    expect(listLinks().map((a) => a.getAttribute("href"))).toEqual([
      "/admin/settings",
      "/admin/settings/general",
      "/admin/settings/access",
      "/admin/settings/access?section=social",
      "/admin/settings/access?section=turnstile",
      "/admin/settings/access?section=members",
      "/admin/settings/email",
    ]);
    expect(listLinks().map((a) => a.getAttribute("aria-current"))).toEqual([null, null, "true", "page", null, null, null]);
    expect(select().value).toBe("access");
    expect([...select().options].map((o) => o.textContent)).toEqual(["General", "Users & access", "Email"]);
    expect(pills().map((a) => [a.textContent, a.getAttribute("aria-current")])).toEqual([
      ["Social sign-in", "page"],
      ["Human verification", null],
      ["Members-only articles", null],
    ]);
    expect(container.querySelector("#field-one")).not.toBeNull();
  });

  it("the category select opens the chosen category", () => {
    render();
    choose("email");
    expect(push).toHaveBeenCalledWith("/admin/settings/email");
    choose("access"); // the open one: nothing to do
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("asks before leaving a section with unsaved changes, by link and by select; staying keeps the section", () => {
    confirm.mockReturnValue(false);
    render(true);
    const turnstile = listLinks()[4]!;
    act(() => {
      turnstile.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(confirm).toHaveBeenCalledWith(LEAVE_QUESTION);
    expect(stopped).toBe(true);
    choose("email");
    expect(push).not.toHaveBeenCalled();
    // The open section's own link (and its button) never asks.
    confirm.mockClear();
    act(() => {
      listLinks()[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    act(() => {
      pills()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
    // Agreeing to leave goes on.
    confirm.mockReturnValue(true);
    act(() => {
      pills()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(stopped).toBe(false);
    choose("email");
    expect(push).toHaveBeenCalledWith("/admin/settings/email");
  });

  it("does not ask once the changes are saved, and warns the browser only while there are some", () => {
    confirm.mockReturnValue(false);
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    render(true);
    expect(leave()).toBe(true);
    render(false);
    expect(leave()).toBe(false);
    choose("email");
    expect(confirm).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/admin/settings/email");
  });

  it("sends an old #tab-<id> link (AI & SEO settings were tabs once) on to its section, and ignores one that names no section", () => {
    window.history.replaceState(null, "", "/admin/settings/agent#tab-runs");
    render(false, "seo-agent");
    expect(replace).toHaveBeenCalledWith("/admin/settings/agent?section=runs");
    replace.mockClear();
    act(() => root.unmount());
    root = createRoot(container);
    window.history.replaceState(null, "", "/admin/settings/access#tab-nope");
    render();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a link to one field scrolls to it and puts the cursor in it", () => {
    window.history.replaceState(null, "", "/admin/settings/access?section=social#field-one");
    const scrolled = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrolled;
    render();
    expect(scrolled).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe("field-one");
  });
});

describe("sections kept in the browser (Appearance)", () => {
  function Editor({ initial }: { initial?: string }) {
    const [section, setSection] = useSettingsSection(SECTIONS, initial, "general");
    return (
      <SettingsSections sections={SECTIONS} current={section} onSelect={(id) => setSection(id as typeof section)}>
        <p data-open>{section}</p>
      </SettingsSections>
    );
  }
  const open = () => container.querySelector("[data-open]")!.textContent;

  it("starts on the section in the address when it is a known one, else the fallback", () => {
    act(() => root.render(<Editor initial="theme" />));
    expect(open()).toBe("theme");
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<Editor initial="nope" />));
    expect(open()).toBe("general");
  });

  it("is a list of buttons: choosing one shows it and writes it to the address without loading the page", () => {
    act(() => root.render(<Editor />));
    expect(links()).toEqual([]);
    expect(new URL(window.location.href).searchParams.get("section")).toBe("general");
    act(() => buttons()[2]!.click());
    expect(open()).toBe("history");
    expect(buttons().map((b) => b.getAttribute("aria-current"))).toEqual([null, null, "page"]);
    expect(new URL(window.location.href).searchParams.get("section")).toBe("history");
    expect(push).not.toHaveBeenCalled();
    choose("theme");
    expect(open()).toBe("theme");
  });

  it("follows the address when a menu link changes it to another section of the same page", () => {
    act(() => root.render(<Editor />));
    search = "section=theme";
    act(() => root.render(<Editor />));
    expect(open()).toBe("theme");
    search = "section=nope";
    act(() => root.render(<Editor />));
    expect(open()).toBe("theme");
  });
});
