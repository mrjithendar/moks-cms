import { describe, expect, it } from "vitest";
import { seoRedirectTarget } from "@/lib/seo-intel/old-urls";

describe("old /admin/seo links land on the CMS pages", () => {
  it.each([
    [[], "/admin"],
    [["calendar"], "/admin/calendar"],
    [["review", "abc"], "/admin/review/abc"],
    [["settings"], "/admin/automation"],
    [["settings", "mcp"], "/admin/automation/mcp"],
    [["pages"], "/admin/page-insights"],
    [["content"], "/admin/content-audit"],
    [["integrations"], "/admin/integrations"],
    [["articles", "1f0e"], "/admin/posts/1f0e/insights"],
    [["reports", "r1"], "/admin/reports/r1"],
    [["models", "labels"], "/admin/models/labels"],
    [["nope"], "/admin"],
  ])("%j → %s", (rest, target) => {
    expect(seoRedirectTarget(rest)).toBe(target);
  });
});
