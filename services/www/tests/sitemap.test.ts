import { describe, expect, it } from "vitest";
import { buildSitemap } from "@/lib/seo/sitemap";
import { NOW } from "./helpers";

// CONTENT_DIR points at the fixtures (vitest.config.ts).
const urls = async () => (await buildSitemap(NOW)).map((e) => e.url);

describe("sitemap.xml", () => {
  it("lists canonical, published URLs as absolute https URLs on the production origin", async () => {
    expect(await urls()).toEqual(
      expect.arrayContaining([
        "https://jithendar.com",
        "https://jithendar.com/blog",
        "https://jithendar.com/news",
        "https://jithendar.com/projects",
        "https://jithendar.com/authors/test-author",
        "https://jithendar.com/news/fresh-news",
        "https://jithendar.com/news/stale-news",
        "https://jithendar.com/blog/published-tutorial",
        "https://jithendar.com/projects/sample-project",
      ]),
    );
    for (const url of await urls()) expect(url).toMatch(/^https:\/\/jithendar\.com(\/[a-z0-9/-]+)?$/);
  });

  it("omits drafts, review, future, archived and externally canonical items", async () => {
    for (const slug of ["draft-post", "review-news", "future-post", "archived-post", "syndicated-post"]) {
      expect((await urls()).some((u) => u.endsWith(`/${slug}`))).toBe(false);
    }
  });

  it("uses updatedAt for lastmod when present", async () => {
    const entry = (await buildSitemap(NOW)).find((e) => e.url.endsWith("/published-tutorial"));
    expect(entry?.lastModified).toBe("2026-10-22T10:00:00+05:30");
  });
});

describe("sitemap.xml: the public user manual", () => {
  it("is listed only while Public user manual is on", async () => {
    const { vi } = await import("vitest");
    const { defaultConfig } = await import("@/lib/site-config/schema");
    expect((await urls()).some((u) => u.endsWith("/user-manual"))).toBe(false); // default: off
    vi.resetModules();
    const config = defaultConfig();
    config.general.features.publicGuide = true;
    vi.doMock("@/lib/site-config/store", async (orig) => ({ ...(await orig<object>()), getPublishedConfig: async () => ({ config }) }));
    const { buildSitemap: build } = await import("@/lib/seo/sitemap");
    expect((await build(NOW)).map((e) => e.url)).toContain("https://jithendar.com/user-manual");
    vi.doUnmock("@/lib/site-config/store");
    vi.resetModules();
  });
});
