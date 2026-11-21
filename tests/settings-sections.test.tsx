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

/**
 * The sectioned settings layout shared by Appearance & site settings (sections kept in the browser) and AI & SEO
 * settings (each section its own server render at ?section=<id>).
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
  window.history.replaceState(null, "", "/admin/automation");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("sections rendered by the server (?section=<id>)", () => {
  const render = (dirty = false, current = "general") =>
    act(() =>
      root.render(
        <SettingsSections sections={SECTIONS} current={current} basePath="/admin/automation">
          <Form dirty={dirty} />
        </SettingsSections>,
      ),
    );

  it("lists every section as a link, marks the open one, and offers a select on a narrow screen", () => {
    render();
    expect(links().map((a) => a.getAttribute("href"))).toEqual(["/admin/automation?section=general", "/admin/automation?section=theme", "/admin/automation?section=history"]);
    expect(links().map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null]);
    expect(links()[1]!.textContent).toContain("2");
    expect(select().value).toBe("general");
    expect([...select().options].map((o) => o.textContent)).toEqual(["General", "Typography & colours (2 to fix)", "Revision history"]);
    expect(container.querySelector("#field-one")).not.toBeNull();
  });

  it("the select opens the chosen section's address", () => {
    render();
    choose("history");
    expect(push).toHaveBeenCalledWith("/admin/automation?section=history");
    choose("general"); // the open one: nothing to do
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("asks before leaving a section with unsaved changes, by link and by select; staying keeps the section", () => {
    confirm.mockReturnValue(false);
    render(true);
    act(() => {
      links()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(confirm).toHaveBeenCalledWith(LEAVE_QUESTION);
    expect(stopped).toBe(true);
    choose("theme");
    expect(push).not.toHaveBeenCalled();
    // The open section's own link never asks.
    confirm.mockClear();
    act(() => {
      links()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
    // Agreeing to leave goes on.
    confirm.mockReturnValue(true);
    act(() => {
      links()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(stopped).toBe(false);
    choose("theme");
    expect(push).toHaveBeenCalledWith("/admin/automation?section=theme");
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
    choose("history");
    expect(confirm).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/admin/automation?section=history");
  });

  it("sends an old #tab-<id> link on to its section, and ignores one that names no section", () => {
    window.history.replaceState(null, "", "/admin/automation#tab-history");
    render();
    expect(replace).toHaveBeenCalledWith("/admin/automation?section=history");
    replace.mockClear();
    act(() => root.unmount());
    root = createRoot(container);
    window.history.replaceState(null, "", "/admin/automation#tab-nope");
    render();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a link to one field scrolls to it and puts the cursor in it", () => {
    window.history.replaceState(null, "", "/admin/automation?section=general#field-one");
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
