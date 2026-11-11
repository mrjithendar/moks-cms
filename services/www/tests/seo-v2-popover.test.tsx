// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditArticle } from "@/lib/seo-intel/audit-article";
import { issuesFor, metricCounts, scoreBreakdown } from "@/lib/seo-intel/issue-details";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { Popover } = await import("@/components/seo/Popover");
const { MetricCell } = await import("@/components/seo/MetricCell");

const article = {
  id: "a1",
  collection: "blog",
  slug: "x",
  title: "A title that is long enough to describe the page",
  description: "d".repeat(100),
  body: ["Intro.", "", "# Stray H1", "", "#### Skipped level", "", "![](/media/a.png)", "", "text", "", "![](/media/b.png)", "", "See [gone](/blog/missing)."].join("\n"),
  category: "kubernetes",
  tags: [],
  contentType: "tutorial",
  seoTitle: null,
  seoDescription: null,
  featuredImage: null,
  publishedAt: new Date("2026-01-01"),
  updatedAt: null,
  noindex: false,
  canonicalUrl: null,
};

describe("issue details: the same audit as the numbers", () => {
  const audit = auditArticle(article, { knownPaths: new Set(["/"]), now: new Date("2026-02-01") });
  it("counts located issues; each popover list has exactly that many items", () => {
    const c = metricCounts(audit, article.body);
    expect(c.missing_alt).toBe(2); // one finding about two images → two located issues
    expect(c.broken_links).toBe(1);
    for (const m of ["errors", "warnings", "notices", "broken_links", "missing_alt", "heading_issues"] as const) expect(issuesFor(m, audit, article.body)).toHaveLength(c[m]);
  });
  it("locates each issue (heading path / line / element) with why + how to fix", () => {
    const alt = issuesFor("missing_alt", audit, article.body);
    expect(alt.map((i) => i.line)).toEqual([7, 11]);
    expect(alt[0]!.location).toMatch(/line 7 · image \/media\/a\.png/);
    expect(alt[0]!.why).toMatch(/Screen-reader/);
    expect(alt[0]!.fixCategory).toBe("alt_text");
    const h1 = issuesFor("heading_issues", audit, article.body).find((i) => i.check === "h1_in_body")!;
    expect(h1).toMatchObject({ line: 3, severity: "warning" });
    expect(issuesFor("broken_links", audit, article.body)[0]).toMatchObject({ line: 13, fixCategory: null });
  });
  it("explains the score with its inputs and weights, matching the audit score", () => {
    const b = scoreBreakdown(audit);
    expect(b.score).toBe(Math.round(audit.score * 100));
    expect(b.weights.map((w) => w.weight)).toEqual([15, 7, 2]);
    expect(b.rows.reduce((s, r) => s + r.points, 0)).toBe(b.deducted);
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPopover() {
  act(() =>
    root.render(
      <Popover label="3 errors: details" trigger={<span>3</span>}>
        {() => (
          <div>
            <a href="#a">first</a>
            <button type="button">last</button>
          </div>
        )}
      </Popover>,
    ),
  );
  return container.querySelector("button[aria-haspopup]") as HTMLButtonElement;
}
const pointer = (el: Element, type: string, pointerType: string) => act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType })));
const key = (k: string, shift = false) => act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true })));

describe("popover: hover, tap and keyboard", () => {
  it("keyboard focus opens a tooltip linked by aria-describedby; focus stays on the trigger; Esc closes", () => {
    const btn = renderPopover();
    act(() => btn.focus());
    const tip = container.querySelector('[role="tooltip"]')!;
    expect(tip).not.toBeNull();
    expect(btn.getAttribute("aria-describedby")).toBe(tip.id);
    expect(document.activeElement).toBe(btn);
    key("Escape");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("mouse hover opens after a short delay (pointer type mouse only)", () => {
    vi.useFakeTimers();
    const btn = renderPopover();
    pointer(btn, "pointerover", "touch");
    act(() => void vi.advanceTimersByTime(300));
    expect(container.querySelector('[role="tooltip"]')).toBeNull(); // touch never opens on "hover"
    pointer(btn, "pointerover", "mouse");
    act(() => void vi.advanceTimersByTime(300));
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("click / tap opens a dialog, moves focus in and traps Tab; Esc returns focus to the trigger", () => {
    const btn = renderPopover();
    act(() => btn.click());
    const dlg = container.querySelector('[role="dialog"]')!;
    expect(dlg).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.getAttribute("aria-describedby")).toBeNull();
    const [first, last] = [dlg.querySelector("a")!, dlg.querySelector("button")!];
    expect(document.activeElement).toBe(first);
    act(() => last.focus());
    key("Tab");
    expect(document.activeElement).toBe(first); // wrapped
    key("Tab", true);
    expect(document.activeElement).toBe(last);
    key("Escape");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
});

describe("MetricCell: lazy, cached per audit run", () => {
  it("fetches details on first open only, shows ≤ 5 + 'View all N' and 'Fix with Claude' for fixable issues", async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ check: "alt_text", severity: "error", message: "m", location: `line ${i + 1} · image`, line: i + 1, field: "body", why: "w", fix: "f", fixCategory: "alt_text" }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? Response.json({ queued: true }, { status: 202 }) : Response.json({ run: "h1", total: 7, items })));
    vi.stubGlobal("fetch", fetchMock);
    act(() => root.render(<MetricCell articleId="a1" metric="missing_alt" value={7} run="h1" title="T" />));
    const btn = container.querySelector("button[aria-haspopup]") as HTMLButtonElement;
    expect(fetchMock).not.toHaveBeenCalled(); // lazy
    await act(async () => btn.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/seo/content/a1/details?metric=missing_alt&run=h1");
    const dlg = container.querySelector('[role="dialog"]')!;
    expect(dlg.querySelectorAll("li")).toHaveLength(5);
    expect(dlg.textContent).toContain("View all 7");
    expect((dlg.querySelector('a[href*="line=1"]') as HTMLAnchorElement).getAttribute("href")).toBe("/admin/posts/a1/insights?line=1#L1");
    const fixBtn = [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Fix with Claude")!;
    await act(async () => fixBtn.click());
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(post[0]).toBe("/api/admin/seo/drafts");
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ articleId: "a1", extra: expect.arrayContaining([expect.objectContaining({ category: "alt_text" })]) });
    expect(container.textContent).toMatch(/nothing is published until you approve/);
    // close and reopen: served from the per-run cache
    act(() => btn.click());
    await act(async () => btn.click());
    expect(fetchMock.mock.calls.filter((c) => !c[1]).length).toBe(1);
  });

  it("zero is plain text (nothing to open)", () => {
    act(() => root.render(<MetricCell articleId="a1" metric="errors" value={0} run="h" title="T" />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("0");
  });
});
