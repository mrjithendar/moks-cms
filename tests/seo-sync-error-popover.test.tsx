// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { SyncErrorCell } = await import("@/components/seo/SyncErrorCell");

const LONG = "Search Console returned 403 PERMISSION_DENIED: User does not have sufficient permission for site 'sc-domain:jithendar.com'. See also https://support.google.com/webmasters/answer/2451999.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const pointer = (el: Element, type: string, pointerType: string) => act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType })));

describe("Sync history error popover", () => {
  it("shows a compact chip and the full error on mouse hover", () => {
    act(() => root.render(<SyncErrorCell error={LONG} errorCode="auth" correlationId="0f3c9a1e-1111-4111-8111-111111111111" job="gsc_sync" />));
    const btn = host.querySelector("button")!;
    expect(btn.textContent).toContain("auth");
    expect(btn.textContent!.length).toBeLessThan(60); // truncated in the table
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    pointer(btn, "pointerover", "mouse");
    act(() => void vi.advanceTimersByTime(300));
    const tip = host.querySelector('[role="tooltip"]')!;
    expect(tip.textContent).toContain(LONG);
    expect(tip.textContent).toContain("0f3c9a1e-1111-4111-8111-111111111111");
    expect(btn.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("opens as a dialog with a copy button on tap/click", () => {
    act(() => root.render(<SyncErrorCell error={LONG} errorCode={null} correlationId="c-1" job="ga4_sync" />));
    act(() => host.querySelector("button")!.click());
    const dlg = host.querySelector('[role="dialog"]')!;
    expect(dlg.textContent).toContain(LONG);
    expect([...dlg.querySelectorAll("button")].some((b) => b.textContent === "Copy error")).toBe(true);
  });

  it("renders a dash when the run had no error", () => {
    act(() => root.render(<SyncErrorCell error={null} errorCode={null} correlationId="c" job="gsc_sync" />));
    expect(host.textContent).toBe("—");
    expect(host.querySelector("button")).toBeNull();
  });
});
