// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const { RecommendationItem } = await import("@/components/seo/RecommendationItem");

let host: HTMLDivElement;
let root: Root;
let calls: { url: string; body: unknown }[];
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  refresh.mockClear();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { reviewStatus?: string; implementationStatus?: string };
    calls.push({ url, body });
    return Response.json({ reviewStatus: body.reviewStatus ?? "approved", implementationStatus: body.implementationStatus ?? "not_started" });
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const click = async (label: string) => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent?.trim() === label)!;
  expect(b, label).toBeTruthy();
  await act(async () => b.click());
};
const render = (filter: string) =>
  act(() =>
    root.render(
      <ol>
        <RecommendationItem id="r1" filter={filter} reviewStatus="pending" implementationStatus="not_started">
          <p>Fix the title</p>
        </RecommendationItem>
      </ol>,
    ),
  );

describe("Recommendations: approving moves the item", () => {
  it("in the pending list, Approve replaces the card with a 'moved to approved' notice, View and Undo", async () => {
    render("pending");
    await click("Approve");
    expect(calls[0]).toEqual({ url: "/api/admin/seo/recommendations/r1", body: { reviewStatus: "approved" } });
    expect(host.textContent).toContain("moved to the approved list");
    expect(host.textContent).not.toContain("Fix the title");
    expect(host.querySelector("a")!.getAttribute("href")).toBe("?status=approved");
    expect(refresh).toHaveBeenCalled();
    await click("Undo");
    expect(calls[1]!.body).toEqual({ reviewStatus: "pending" });
    expect(host.textContent).toContain("Fix the title");
  });

  it("in the 'all' list, the card stays and offers the next steps", async () => {
    render("all");
    await click("Approve");
    expect(host.textContent).toContain("Fix the title");
    expect(host.textContent).toContain("Mark in progress");
    expect(host.textContent).not.toContain("moved to");
  });

  it("a failed request keeps the card and shows the error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Rate limited." }, { status: 429 }));
    render("pending");
    await click("Approve");
    expect(host.textContent).toContain("Fix the title");
    expect(host.textContent).toContain("Rate limited.");
  });
});
