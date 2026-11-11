import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import PageCacheHandler, { pageCacheState } from "../cache-handler.mjs";
import { broadcastInvalidate } from "@/lib/cache-bus";
import { clearPageCache, onPageCacheCleared, pageCacheStats } from "@/lib/page-cache";
import { sitemapPaths, warmPages } from "@/lib/warm";
import { recordPageWarmup, renderPageCache } from "@/lib/metrics";

const page = (html: string) => ({ kind: "APP_PAGE", html, rscData: Buffer.from(html), headers: {}, status: 200 });

function reset() {
  const s = pageCacheState();
  s.entries.clear();
  s.pending.clear();
  s.bytes = 0;
}

describe("ISR page cache handler (cache-handler.mjs)", () => {
  beforeEach(reset);

  it("serves what was stored until the cache is cleared", async () => {
    const h = new PageCacheHandler({});
    expect(await h.get("/blog")).toBeNull();
    await h.set("/blog", page("<p>v1</p>"), { cacheControl: { revalidate: 300 } });
    // Next creates a handler per request: a new instance sees the same store.
    const hit = await new PageCacheHandler({}).get("/blog");
    expect(hit?.value.html).toBe("<p>v1</p>");
    expect(hit?.cacheControl).toEqual({ revalidate: 300 });
    clearPageCache();
    expect(await new PageCacheHandler({}).get("/blog")).toBeNull();
  });

  it("does not store a render that started before the cache was cleared", async () => {
    const h = new PageCacheHandler({});
    expect(await h.get("/news")).toBeNull(); // miss: a render starts with the old data
    clearPageCache(); // a publish lands while it runs
    await h.set("/news", page("<p>stale</p>"));
    expect(await h.get("/news")).toBeNull();
    await h.set("/news", page("<p>fresh</p>")); // the next render, started after the clear
    expect((await h.get("/news"))?.value.html).toBe("<p>fresh</p>");
  });

  it("revalidatePath/revalidateTag in this process clear every page", async () => {
    const h = new PageCacheHandler({});
    await h.set("/", page("home"));
    await h.revalidateTag(["_N_T_/layout"]);
    expect(await h.get("/")).toBeNull();
  });

  it("evicts the least recently used pages beyond the byte budget and skips oversized ones", async () => {
    const h = new PageCacheHandler({});
    const big = "x".repeat(6 * 1024 * 1024); // doubled below: ~36 MB, over a quarter of the 64 MB budget
    await h.set("/a", page("a".repeat(2 * 1024 * 1024)));
    await h.set("/b", page("b".repeat(2 * 1024 * 1024)));
    await h.get("/a"); // /a is now the most recently used
    for (let i = 0; i < 20; i++) await h.set(`/p${i}`, page("p".repeat(2 * 1024 * 1024)));
    const s = pageCacheState();
    expect(s.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(s.entries.has("/b")).toBe(false);
    await h.set("/huge", page(big.repeat(2)));
    expect(s.entries.has("/huge")).toBe(false);
  });

  it("set(null) removes the entry", async () => {
    const h = new PageCacheHandler({});
    await h.set("/x", page("x"));
    await h.set("/x", null);
    expect(await h.get("/x")).toBeNull();
  });
});

describe("page cache invalidation (lib/page-cache.ts)", () => {
  beforeEach(reset);

  it.each(["content", "categories", "settings", "integrations"] as const)("a %s change clears every cached page", async (kind) => {
    const h = new PageCacheHandler({});
    await h.set("/", page("home"));
    broadcastInvalidate(kind);
    expect(await h.get("/")).toBeNull();
  });

  it("a practice change does not (those pages are per user and never cached)", async () => {
    const h = new PageCacheHandler({});
    await h.set("/", page("home"));
    broadcastInvalidate("practice");
    expect((await h.get("/"))?.value.html).toBe("home");
  });

  it("notifies listeners (the warm-up) after each clear", () => {
    let n = 0;
    onPageCacheCleared(() => n++);
    const before = pageCacheStats().generation;
    clearPageCache();
    expect(n).toBe(1);
    expect(pageCacheStats().generation).toBe(before + 1);
  });
});

describe("page warm-up (lib/warm.ts)", () => {
  it("reads same-origin paths from the sitemap, home page first, without duplicates", () => {
    const xml = `<urlset><url><loc>https://jithendar.com</loc></url><url><loc>https://jithendar.com/blog</loc></url>
      <url><loc> https://jithendar.com/blog/a?x=1&amp;y=2 </loc></url><url><loc>https://evil.example/blog</loc></url>
      <url><loc>https://jithendar.com/blog</loc></url><url><loc>not a url</loc></url></urlset>`;
    expect(sitemapPaths(xml, "https://jithendar.com")).toEqual(["/", "/blog", "/blog/a", "/feed.xml", "/news/feed.xml", "/search-index.json"]);
  });

  it("requests every page and counts server errors", async () => {
    const seen: string[] = [];
    const sitemap = `<loc>https://jithendar.com/blog</loc><loc>https://jithendar.com/broken</loc><loc>https://jithendar.com/gone</loc>`;
    const r = await warmPages(async (p) => {
      seen.push(p);
      if (p === "/sitemap.xml") return { status: 200, body: sitemap };
      return { status: p === "/broken" ? 500 : p === "/gone" ? 404 : 200, body: "" };
    });
    expect(seen.slice(1).sort()).toEqual(["/", "/blog", "/broken", "/feed.xml", "/gone", "/news/feed.xml", "/search-index.json"]);
    expect(r).toMatchObject({ pages: 7, failed: 1 });
  });

  it("fails when the sitemap does not answer", async () => {
    await expect(warmPages(async () => ({ status: 503, body: "" }))).rejects.toThrow(/sitemap answered 503/);
  });
});

describe("public routes are ISR, not per request", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  const PUBLIC = [
    "page.tsx",
    "[page]/page.tsx",
    "ai-assistants/page.tsx",
    "authors/[slug]/page.tsx",
    "authors/[slug]/page/[n]/page.tsx",
    "blog/page.tsx",
    "blog/[slug]/page.tsx",
    "blog/page/[n]/page.tsx",
    "category/[category]/page.tsx",
    "category/[category]/page/[n]/page.tsx",
    "category/[category]/feed.xml/route.ts",
    "news/page.tsx",
    "news/[slug]/page.tsx",
    "news/page/[n]/page.tsx",
    "news/feed.xml/route.ts",
    "projects/page.tsx",
    "projects/[slug]/page.tsx",
    "projects/page/[n]/page.tsx",
    "tag/[tag]/page.tsx",
    "tag/[tag]/page/[n]/page.tsx",
    "feed.xml/route.ts",
    "sitemap.ts",
    "search-index.json/route.ts",
    "opengraph-image.tsx",
  ];

  it.each(PUBLIC)("%s revalidates every 300 s and is not force-dynamic", (f) => {
    const src = readFileSync(path.join(ROOT, "src/app", f), "utf8");
    expect(src).not.toMatch(/force-dynamic/);
    expect(src).toMatch(/export const revalidate = 300;/);
    if (f.includes("[")) expect(src).toMatch(/export async function generateStaticParams\(\)/);
  });

  it.each(["blog", "news", "projects"])("%s article Open Graph images are cached like their pages", (c) => {
    const src = readFileSync(path.join(ROOT, "src/app", c, "[slug]/opengraph-image.tsx"), "utf8");
    expect(src).toMatch(/export const revalidate = 300;/);
  });

  it("the news sitemap refreshes every minute (48-hour window) instead of per request", () => {
    const src = readFileSync(path.join(ROOT, "src/app/news-sitemap.xml/route.ts"), "utf8");
    expect(src).not.toMatch(/force-dynamic/);
    expect(src).toMatch(/export const revalidate = 60;/);
  });

  it("the root layout's config only reads cookies in draft mode (otherwise every page would be dynamic)", () => {
    const src = readFileSync(path.join(ROOT, "src/lib/site-config/index.ts"), "utf8");
    const draft = src.indexOf("(await draftMode()).isEnabled");
    expect(draft).toBeGreaterThan(0);
    expect(src.indexOf("(await cookies())")).toBeGreaterThan(draft);
  });
});

describe("page cache metrics (lib/metrics.ts)", () => {
  beforeEach(reset);

  it("exports hits, misses, clears, size and warm-ups", async () => {
    const h = new PageCacheHandler({});
    const before = pageCacheState();
    const hits = before.hits;
    await h.get("/m");
    await h.set("/m", page("m"));
    await h.get("/m");
    recordPageWarmup("startup", "ok", 2.5, 12, 1);
    recordPageWarmup("cache cleared", "failed", 1);
    const out = renderPageCache().join("\n");
    expect(out).toContain(`jithendar_page_cache_hits_total ${hits + 1}`);
    expect(out).toMatch(/jithendar_page_cache_entries 1\b/);
    expect(out).toMatch(/jithendar_page_cache_clears_total \d+/);
    expect(out).toContain('jithendar_page_warmups_total{reason="startup",outcome="ok"} 1');
    expect(out).toContain('jithendar_page_warmups_total{reason="cleared",outcome="failed"} 1');
    expect(out).toContain("jithendar_page_warmup_pages 12");
    expect(out).toContain("jithendar_page_warmup_failed_pages 1");
  });
});
