import { describe, expect, it } from "vitest";
import { seoRedirectTarget } from "@/lib/seo-intel/old-urls";

describe("old /admin/seo links land on the CMS pages", () => {
  it.each([
    [[], "/admin"],
    [["calendar"], "/admin/calendar"],
    [["review", "abc"], "/admin/review/abc"],
    [["settings"], "/admin/settings/seo"],
    [["settings", "mcp"], "/admin/settings/assistants?section=mcp"],
    [["pages"], "/admin/page-insights"],
    [["content"], "/admin/content-audit"],
    [["integrations"], "/admin/settings/seo?section=search-console"],
    [["articles", "1f0e"], "/admin/posts/1f0e/insights"],
    [["reports", "r1"], "/admin/reports/r1"],
    [["models", "labels"], "/admin/models/labels"],
    [["nope"], "/admin"],
  ])("%j → %s", (rest, target) => {
    expect(seoRedirectTarget(rest)).toBe(target);
  });
});
