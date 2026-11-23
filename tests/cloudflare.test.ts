import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const env: Record<string, string | undefined> = {};
vi.mock("@/lib/runtime-settings", () => ({ effectiveEnv: async () => ({ ...env }) }));

const { batches, checkCloudflare, describeFailure, parseCustomPurge, purgeCloudflare, siteUrls } = await import("@/lib/cloudflare");
const { flushCdnPurge, purgePolicy, queueCdnPurge, relatedPostPaths } = await import("@/lib/cdn-purge");

const CFG = { zoneId: "0123456789abcdef0123456789abcdef", token: "cf-token-secret-value-0123456789" };
const ORIGIN = "https://example.com";

type Call = { url: string; method: string; auth: string | null; body: unknown };
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetcher };
}
const OK = { status: 200, body: { success: true, errors: [], result: { id: "x" } } };

describe("Cloudflare purge requests", () => {
  it("purges everything with one request to the zone's purge_cache, with the token as a bearer", async () => {
    const f = fakeFetch([OK]);
    expect(await purgeCloudflare(CFG, { everything: true }, f.fetcher)).toEqual({ ok: true, requests: 1, items: 0 });
    expect(f.calls).toEqual([{ url: `https://api.cloudflare.com/client/v4/zones/${CFG.zoneId}/purge_cache`, method: "POST", auth: `Bearer ${CFG.token}`, body: { purge_everything: true } }]);
  });

  it("sends at most 100 items per request, without duplicates", async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `${ORIGIN}/p/${i}`);
    const f = fakeFetch([OK]);
    const r = await purgeCloudflare(CFG, { kind: "files", items: [...urls, urls[0]!] }, f.fetcher);
    expect(r).toEqual({ ok: true, requests: 3, items: 250 });
    expect(f.calls.map((c) => (c.body as { files: string[] }).files.length)).toEqual([100, 100, 50]);
    expect(batches([1, 1, 2], 1)).toEqual([[1], [2]]);
  });

  it("stops at the first refusal and says why, without the token", async () => {
    const f = fakeFetch([OK, { status: 429, body: { success: false, errors: [{ code: 1134, message: "Too many purge requests" }] } }]);
    const r = await purgeCloudflare(CFG, { kind: "prefixes", items: Array.from({ length: 300 }, (_, i) => `example.com/${i}/`) }, f.fetcher);
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(2);
    if (!r.ok) {
      expect(r.error).toMatch(/purge limit/);
      expect(r.error).not.toContain(CFG.token);
    }
    expect(describeFailure(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] })).toMatch(/Cache Purge → Purge/);
    expect(describeFailure(404, null)).toMatch(/zone ID/);
  });

  it("reports an unreachable API instead of throwing", async () => {
    const r = await purgeCloudflare(CFG, { everything: true }, async () => {
      throw new TypeError("fetch failed");
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/could not be reached/) });
  });
});

describe("Cloudflare connection test", () => {
  it("tries a purge of an address the site never serves, then the zone against the site's host", async () => {
    vi.stubEnv("SITE_URL", "https://example.com");
    const ok = fakeFetch([OK, { status: 200, body: { success: true, result: { name: "example.com", status: "active", plan: { name: "Free Website" } } } }]);
    expect(await checkCloudflare(CFG, ok.fetcher)).toMatchObject({ ok: true, zone: { name: "example.com", plan: "Free Website" } });
    expect(ok.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", `https://api.cloudflare.com/client/v4/zones/${CFG.zoneId}/purge_cache`, { files: ["https://example.com/__cloudflare-purge-check"] }],
      ["GET", `https://api.cloudflare.com/client/v4/zones/${CFG.zoneId}`, undefined],
    ]);
    const other = fakeFetch([OK, { status: 200, body: { success: true, result: { name: "other.org" } } }]);
    expect(await checkCloudflare(CFG, other.fetcher)).toMatchObject({ ok: false, message: expect.stringMatching(/not this site's/) });
    const noZoneRead = fakeFetch([OK, { status: 403, body: { success: false, errors: [{ code: 9109 }] } }]);
    expect(await checkCloudflare(CFG, noZoneRead.fetcher)).toMatchObject({ ok: true, message: expect.stringMatching(/can purge this zone/) });
    const noPurge = fakeFetch([{ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } }]);
    expect(await checkCloudflare(CFG, noPurge.fetcher)).toMatchObject({ ok: false, message: expect.stringMatching(/Cache Purge → Purge/) });
    expect(noPurge.calls).toHaveLength(1);
    const unknown = fakeFetch([{ status: 401, body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] } }]);
    expect(await checkCloudflare(CFG, unknown.fetcher)).toMatchObject({ ok: false, message: expect.stringMatching(/does not recognise this API token/) });
    vi.unstubAllEnvs();
  });

  it("never asks /user/tokens/verify, which refuses account-owned tokens that purge fine", async () => {
    vi.stubEnv("SITE_URL", "https://example.com");
    const f = fakeFetch([OK, { status: 403, body: { success: false, errors: [{ code: 9109 }] } }]);
    expect((await checkCloudflare({ ...CFG, token: "cfat_account-owned-token-0123456789" }, f.fetcher)).ok).toBe(true);
    expect(f.calls.some((c) => c.url.includes("/tokens/verify"))).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("custom purge input", () => {
  it("normalises URLs, prefixes, hostnames and tags, and lists what it did not understand", () => {
    expect(parseCustomPurge("files", "/blog/a\nhttps://example.com/news/feed.xml\n\n/blog/a\nftp://x/y", ORIGIN)).toEqual({ items: [`${ORIGIN}/blog/a`, `${ORIGIN}/news/feed.xml`], invalid: ["ftp://x/y"] });
    expect(parseCustomPurge("prefixes", "/blog/\nhttps://example.com/news\nexample.com\nnot a prefix", ORIGIN)).toEqual({ items: ["example.com/blog/", "example.com/news", "example.com/"], invalid: ["not a prefix"] });
    expect(parseCustomPurge("hosts", "https://WWW.example.com/x\nexample.com\nlocalhost", ORIGIN)).toEqual({ items: ["www.example.com", "example.com"], invalid: ["localhost"] });
    expect(parseCustomPurge("tags", "post-1\nhas space", ORIGIN)).toEqual({ items: ["post-1"], invalid: ["has space"] });
    expect(siteUrls(["/", "/blog", "/blog"], ORIGIN)).toEqual([`${ORIGIN}/`, `${ORIGIN}/blog`]);
  });
});

describe("purge on publish", () => {
  const counts = { collection: new Map([["blog", 13], ["news", 2]]), category: new Map([["kubernetes", 30]]), tag: new Map([["argo-cd", 1]]), author: new Map([["jd", 5]]) };

  it("names the post and every page that lists it, including the next listing page", () => {
    const paths = relatedPostPaths({ collection: "blog", slug: "argo", category: "kubernetes", tags: ["Argo CD"], authorId: "u1" }, counts, "jd");
    expect(paths).toEqual(
      expect.arrayContaining(["/", "/blog/argo", "/feed.xml", "/sitemap.xml", "/search-index.json", "/blog", "/blog/page/2", "/category/kubernetes", "/category/kubernetes/page/3", "/category/kubernetes/feed.xml", "/tag/argo-cd", "/authors/jd"]),
    );
    expect(paths).not.toContain("/blog/page/3"); // 13 + 1 posts fit on two pages of 12
    expect(paths).not.toContain("/news/feed.xml");
    const news = relatedPostPaths({ collection: "news", slug: "s", category: "", tags: [], authorId: "u1" }, counts, null);
    expect(news).toEqual(expect.arrayContaining(["/news/s", "/news", "/news/feed.xml", "/news-sitemap.xml"]));
    expect(news.some((p) => p.startsWith("/authors/") || p.startsWith("/category/"))).toBe(false);
  });

  it("is on by default (related), and can be everything or off", () => {
    expect(purgePolicy({})).toBe("related");
    expect(purgePolicy({ CLOUDFLARE_PURGE_ON_PUBLISH: "everything" })).toBe("everything");
    expect(purgePolicy({ CLOUDFLARE_PURGE_ON_PUBLISH: "off" })).toBe("off");
    expect(purgePolicy({ CLOUDFLARE_PURGE_ON_PUBLISH: "bogus" })).toBe("related");
  });

  describe("sending", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      for (const k of Object.keys(env)) delete env[k];
      vi.stubEnv("SITE_URL", ORIGIN);
      fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(OK.body), { status: 200 }));
    });
    afterEach(() => {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    });
    const sent = () => fetchSpy.mock.calls.map((call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)));

    it("does nothing until Cloudflare is set up, or when turned off", async () => {
      queueCdnPurge({ paths: ["/about", "/"] });
      expect(await flushCdnPurge()).toBeNull();
      Object.assign(env, { CLOUDFLARE_ZONE_ID: CFG.zoneId, CLOUDFLARE_API_TOKEN: CFG.token, CLOUDFLARE_PURGE_ON_PUBLISH: "off" });
      queueCdnPurge({ paths: ["/about"] });
      expect(await flushCdnPurge()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("sends the collected addresses as one URL purge", async () => {
      Object.assign(env, { CLOUDFLARE_ZONE_ID: CFG.zoneId, CLOUDFLARE_API_TOKEN: CFG.token });
      queueCdnPurge({ paths: ["/about", "/"] });
      queueCdnPurge({ paths: ["/contact", "/"] });
      const r = await flushCdnPurge();
      expect(r?.outcome.ok).toBe(true);
      expect(sent()).toEqual([{ files: [`${ORIGIN}/about`, `${ORIGIN}/`, `${ORIGIN}/contact`] }]);
      expect(await flushCdnPurge()).toBeNull(); // the queue is empty again
    });

    it("purges everything for a site-wide change, or always under the everything policy", async () => {
      Object.assign(env, { CLOUDFLARE_ZONE_ID: CFG.zoneId, CLOUDFLARE_API_TOKEN: CFG.token });
      queueCdnPurge({ paths: ["/about"] });
      queueCdnPurge({ everything: true });
      await flushCdnPurge();
      env.CLOUDFLARE_PURGE_ON_PUBLISH = "everything";
      queueCdnPurge({ paths: ["/about"] });
      await flushCdnPurge();
      expect(sent()).toEqual([{ purge_everything: true }, { purge_everything: true }]);
    });
  });
});
