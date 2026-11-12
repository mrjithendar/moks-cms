import { describe, expect, it } from "vitest";
import { previewPercentFor, sitePreviewPercent, splitForMembers } from "@/lib/members";

const paragraph = (n: number, words = 40) => `Paragraph ${n} ${"word ".repeat(words).trim()}.`;
const BODY = ["## Introduction", paragraph(1), paragraph(2), "## Setup", paragraph(3), "```bash\nkubectl get pods\n\nkubectl get nodes\n```", paragraph(4), "## Results", paragraph(5), paragraph(6)].join("\n\n") + "\n";

describe("members-only preview percentage", () => {
  it("uses the post's own value, else the site default, else 30, always within 5–95", () => {
    expect(sitePreviewPercent({})).toBe(30);
    expect(sitePreviewPercent({ MEMBERS_PREVIEW_PERCENT: "45" })).toBe(45);
    expect(sitePreviewPercent({ MEMBERS_PREVIEW_PERCENT: "abc" })).toBe(30);
    expect(sitePreviewPercent({ MEMBERS_PREVIEW_PERCENT: "0" })).toBe(30);
    expect(sitePreviewPercent({ MEMBERS_PREVIEW_PERCENT: "500" })).toBe(95);
    expect(previewPercentFor(null, 30)).toBe(30);
    expect(previewPercentFor(undefined, 45)).toBe(45);
    expect(previewPercentFor(60, 30)).toBe(60);
    expect(previewPercentFor(1, 30)).toBe(5);
  });
});

describe("splitting an article for members", () => {
  it("cuts between blocks: nothing is lost, repeated or broken", () => {
    for (const percent of [5, 30, 50, 80, 95]) {
      const { preview, rest } = splitForMembers(BODY, percent);
      expect(rest).not.toBe("");
      expect(`${preview.trimEnd()}\n\n${rest}`).toBe(BODY);
      // A fenced code block is never split (its blank line is not a block boundary).
      expect((preview.match(/```/g) ?? []).length % 2).toBe(0);
      // The preview never ends on a heading whose text is behind the gate.
      expect(preview.trimEnd().split("\n").at(-1)!.startsWith("#")).toBe(false);
    }
  });

  it("shows more for a higher percentage, and about the share asked for", () => {
    const sizes = [10, 30, 60, 90].map((p) => splitForMembers(BODY, p).preview.length);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(sizes[0]!).toBeLessThan(sizes[3]!);
    const share = splitForMembers(BODY, 30).preview.length / BODY.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.55);
  });

  it("always shows something and always holds something back, except for a one-block article", () => {
    const two = `${paragraph(1)}\n\n${paragraph(2)}\n`;
    expect(splitForMembers(two, 5)).toEqual({ preview: `${paragraph(1)}\n`, rest: `${paragraph(2)}\n` });
    expect(splitForMembers(two, 95)).toEqual({ preview: `${paragraph(1)}\n`, rest: `${paragraph(2)}\n` });
    expect(splitForMembers(`${paragraph(1)}\n`, 30)).toEqual({ preview: `${paragraph(1)}\n`, rest: "" });
    expect(splitForMembers("", 30)).toEqual({ preview: "", rest: "" });
  });

  it("keeps shortcode blocks whole", () => {
    const body = `${paragraph(1)}\n\n:::callout{type="tip"}\nFirst line.\n\nSecond line.\n:::\n\n${paragraph(2)}\n\n${paragraph(3)}\n`;
    for (const percent of [20, 50, 70]) {
      const { preview, rest } = splitForMembers(body, percent);
      expect((preview.match(/^:::/gm) ?? []).length % 2).toBe(0);
      expect((rest.match(/^:::/gm) ?? []).length % 2).toBe(0);
    }
  });
});
