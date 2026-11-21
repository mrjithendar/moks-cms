import { describe, expect, it } from "vitest";
import { MENU_GROUPS, MENU_PLACES } from "@/lib/admin-menu";
import { newsroomTarget } from "@/lib/news/old-addresses";
import { newsSettingsSchema, qualitySchema } from "@/lib/news/schema";
import { groupValues, JOB_SETTING_GROUPS } from "@/lib/news/settings-fields";

/**
 * There is no Newsroom since 2026-11-21: crew jobs and the content they write from live under AI & SEO. Old addresses
 * redirect, and every value of the news settings page has a home on the page that owns its subject.
 */
describe("old Newsroom addresses", () => {
  const UUID = "0b6e6a0e-6f3c-4c55-9f0e-3c1d2a9f8b11";
  it("send each page to where it lives now, keeping the run filters", () => {
    expect(newsroomTarget([])).toBe("/admin/crewai/jobs");
    expect(newsroomTarget(["jobs", "new"])).toBe("/admin/crewai/jobs/new");
    expect(newsroomTarget(["jobs", UUID])).toBe(`/admin/crewai/jobs/${UUID}`);
    expect(newsroomTarget(["runs"], new URLSearchParams({ job: UUID, status: "failed" }))).toBe(`/admin/crewai/jobs/runs?job=${UUID}&status=failed`);
    expect(newsroomTarget(["runs", UUID])).toBe(`/admin/crewai/jobs/runs/${UUID}`);
    for (const p of ["sources", "topics", "profiles"]) expect(newsroomTarget([p])).toBe(`/admin/content/${p}`);
    expect(newsroomTarget(["analytics"])).toBe("/admin/content/analytics");
    expect(newsroomTarget(["settings"])).toBe("/admin/crewai/jobs#jobs-switch");
  });

  it("never builds an address from an odd segment", () => {
    expect(newsroomTarget(["jobs", "../../evil"])).toBe("/admin/crewai/jobs");
    expect(newsroomTarget(["runs", "x?y=1"])).toBe("/admin/crewai/jobs/runs");
    expect(newsroomTarget(["somewhere"])).toBe("/admin/crewai/jobs");
  });
});

describe("the menu", () => {
  it("has no Newsroom group; jobs and content sit under AI & SEO", () => {
    expect(MENU_GROUPS.map((g) => g.id)).not.toContain("newsroom");
    const place = new Map(MENU_PLACES);
    for (const href of ["/admin/crewai/jobs", "/admin/crewai/jobs/runs", "/admin/content/sources", "/admin/content/topics", "/admin/content/profiles", "/admin/content/analytics"]) expect(place.get(href)?.group, href).toBe("ai");
    expect(MENU_PLACES.some(([href]) => href.startsWith("/admin/news"))).toBe(false);
  });

  it("follows WordPress's order: content menus, plugin-like menus, then Appearance, Users, Tools, Settings", () => {
    expect(MENU_GROUPS.map((g) => g.label)).toEqual(["Dashboard", "Posts", "Media", "Pages", "Comments", "AI & SEO", "Billing", "Practice", "Appearance", "Users", "Tools", "Settings"]);
  });
});

describe("crew job settings (setting row news)", () => {
  // What the news settings page edited before it was removed; `enabled` is the switch on the Jobs page.
  const EDITED = ["image_daily_usd", "image_monthly_usd", "max_drafts_per_day", "draft_concurrency", "image_provider", "writer_model", "fast_model", "vision_model", "classifier_threshold", "ranker_min_feedback", "paywalled_hosts", "primary_source_hosts", "log_retention_days", "item_retention_days", "max_items_per_source"];
  const QUALITY = ["max_ngram_overlap", "max_shared_run_words", "max_paragraph_cosine", "max_quote_words", "min_analysis_share", "readability_min", "readability_max", "title_max", "max_internal_links"];
  const fields = Object.values(JOB_SETTING_GROUPS).flatMap((g) => g.fields);

  it("every value the old page edited has exactly one home", () => {
    const top = fields.filter((f) => !(f.kind === "number" && f.quality)).map((f) => f.key);
    const quality = fields.filter((f) => f.kind === "number" && f.quality).map((f) => f.key);
    expect([...top].sort()).toEqual([...EDITED].sort());
    expect([...quality].sort()).toEqual([...QUALITY].sort());
  });

  it("names only fields the row has", () => {
    const row = Object.keys(newsSettingsSchema.shape);
    const q = Object.keys(qualitySchema.shape);
    for (const f of fields) expect(f.kind === "number" && f.quality ? q : row, f.key).toContain(f.key);
  });

  it("a group saves only its own part of the row", () => {
    const row = newsSettingsSchema.parse({});
    expect(Object.keys(groupValues(JOB_SETTING_GROUPS.limits, row)).sort()).toEqual(["draft_concurrency", "image_daily_usd", "image_monthly_usd", "max_drafts_per_day"]);
    const quality = groupValues(JOB_SETTING_GROUPS.quality, row);
    expect(Object.keys(quality)).toEqual(["quality"]);
    expect(Object.keys(quality.quality as object).sort()).toEqual([...QUALITY].sort());
    expect(newsSettingsSchema.safeParse({ ...row, ...groupValues(JOB_SETTING_GROUPS.fetching, row) }).success).toBe(true);
  });
});
