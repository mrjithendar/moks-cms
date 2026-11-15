import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isIndexableHost } from "@/config/site";
import { robotsTxt } from "@/lib/seo/robots";
import { proxy } from "@/proxy";

// These tests cover routing headers only; maintenance mode (a database read) is tested in site-config.test.ts.
vi.mock("@/lib/site-config/maintenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/site-config/maintenance")>()),
  maintenanceState: async () => ({ enabled: false, message: "", retryAfterMinutes: 30 }),
}));


const request = (url: string) => new NextRequest(url, { headers: { host: new URL(url).host } });

afterEach(() => vi.unstubAllEnvs());

describe("environment indexability", () => {
  it("only indexes production on the canonical host", async () => {
    vi.stubEnv("APP_ENV", "production");
    expect(isIndexableHost("jithendar.com")).toBe(true);
    expect(isIndexableHost("jithendar.com:443")).toBe(true);
    expect(isIndexableHost("www.jithendar.com")).toBe(false);
    expect(isIndexableHost("46.224.38.14")).toBe(false);
    vi.stubEnv("APP_ENV", "staging");
    expect(isIndexableHost("jithendar.com")).toBe(false);
  });

  it("adds X-Robots-Tag noindex outside production", async () => {
    vi.stubEnv("APP_ENV", "staging");
    expect((await proxy(request("https://staging.jithendar.com/"))).headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("leaves production responses indexable", async () => {
    vi.stubEnv("APP_ENV", "production");
    expect((await proxy(request("https://jithendar.com/"))).headers.get("x-robots-tag")).toBeNull();
  });

  it("never lets a client's invoice link be indexed or cached, in production too", async () => {
    vi.stubEnv("APP_ENV", "production");
    for (const path of ["/invoice/kJ8sQ2xYb7Lr0PzVn4TqWm1Ue9Ac3Df6Gh5Ij8Kl2Mo", "/invoice/kJ8sQ2xYb7Lr0PzVn4TqWm1Ue9Ac3Df6Gh5Ij8Kl2Mo/pdf"]) {
      const res = await proxy(request(`https://jithendar.com${path}`));
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
    }
    // Only that path: the admin's list of invoices and ordinary pages are not affected by this rule.
    expect((await proxy(request("https://jithendar.com/invoices"))).headers.get("cache-control")).toBeNull();
  });

  it("robots.txt stays crawlable outside production (so the noindex header is seen) and lists both sitemaps in production", async () => {
    expect(robotsTxt(false)).toBe("User-agent: *\nAllow: /\n");
    expect(robotsTxt(false)).not.toContain("Sitemap");
    const prod = robotsTxt(true);
    expect(prod).toContain("Sitemap: https://jithendar.com/sitemap.xml");
    expect(prod).toContain("Sitemap: https://jithendar.com/news-sitemap.xml");
    expect(prod).not.toMatch(/^Disallow: \/$/m);
    expect(prod).not.toMatch(/Googlebot/);
  });

  it("does not name other workloads' path routes (that only advertised them) and blocks only the API", () => {
    const prod = robotsTxt(true);
    // Each allowed AI crawler's group repeats the `*` rules (lib/seo/ai-crawlers.ts); still nothing but /api/.
    expect([...new Set(prod.match(/^Disallow: .*$/gm))]).toEqual(["Disallow: /api/"]);
    for (const route of ["argocd", "grafana", "vault", "db", "prometheus"]) expect(prod).not.toContain(route);
  });
});

describe("hijacked WordPress URLs", () => {
  it.each([
    "/2026/10/27/acronis-true-image-advanced-crack-license-intel-amd-full-version-mega/",
    "/2026/10/27/acronis-true-image-advanced-crack-license-intel-amd-full-version-mega",
    "/category/cracks/",
    "/wp-sitemap.xml",
  ])("returns 410 Gone for %s", async (path) => {
    vi.stubEnv("APP_ENV", "production");
    const res = await proxy(request(`https://jithendar.com${path}`));
    expect(res.status).toBe(410);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("does not touch real routes", async () => {
    expect((await proxy(request("https://jithendar.com/blog"))).status).toBe(200);
  });
});

describe("trailing slashes", () => {
  it("redirects to the slashless URL in one 308 hop", async () => {
    const res = await proxy(request("https://jithendar.com/blog/?page=2"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://jithendar.com/blog?page=2");
  });

  it("leaves the homepage alone", async () => {
    expect((await proxy(request("https://jithendar.com/"))).status).toBe(200);
  });
});
