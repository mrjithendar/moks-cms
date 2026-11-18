import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { isBlockedAddress, isBlockedLiteral, publicFetcher, safeFetcher, parseRobots, robotsAllows, allowedHosts } = await import("@/lib/seo-intel/crawler");
const { crawl, parsePage, parseSitemap, runTechnicalScan, latestScan } = await import("@/lib/seo-intel/technical");
import type { FetchResult } from "@/lib/seo-intel/crawler";

describe("SSRF protection", () => {
  it.each([
    ["127.0.0.1", true], ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.49.2", true], ["169.254.169.254", true], ["100.64.0.5", true], ["0.0.0.0", true], ["224.0.0.1", true],
    ["::1", true], ["fe80::1", true], ["fd00::1", true], ["::ffff:10.0.0.1", true], ["::ffff:127.0.0.1", true],
    // The same IPv4-mapped addresses as `URL` spells them, and other ways an IPv6 address carries a private IPv4 one.
    ["::ffff:a00:1", true], ["::ffff:7f00:1", true], ["0:0:0:0:0:ffff:c0a8:3102", true], ["2002:7f00:1::", true], ["64:ff9b::a00:1", true], ["::", true],
    ["::ffff:808:808", false], ["2002:808:808::", false], ["2a01:4f8::1", false],
    ["46.224.38.14", false], ["8.8.8.8", false], ["2606:4700::1111", false],
  ])("%s blocked=%s", (ip, blocked) => expect(isBlockedAddress(ip)).toBe(blocked));

  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect-out") return res.writeHead(302, { location: "http://evil.example/" }).end();
      res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(5000));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses loopback even when the host is on the allowlist (checked at connect time)", async () => {
    const f = safeFetcher(new URL(`http://localhost`), { timeoutMs: 2000, maxBytes: 10_000, maxRedirects: 3 });
    const r = await f(`http://localhost/`);
    expect(r.status).toBe(0);
    // Port is outside 80/443 → refused before connecting; on 80 the DNS guard refuses 127.0.0.1.
    const r2 = await safeFetcher(new URL("http://localhost"), { timeoutMs: 2000, maxBytes: 10_000, maxRedirects: 3 })(`http://localhost:${port}/`);
    expect(r2.status).toBe(0);
    expect(r.error ?? "").toMatch(/non-public address/);
  });

  // Node never calls the socket's `lookup` for a host that is already an IP address, so the DNS guard alone let
  // http://127.0.0.1/ and http://169.254.169.254/ through the link checker (any public host is allowed there).
  it.each([
    ["127.0.0.1", true], ["[::1]", true], ["169.254.169.254", true], ["10.96.0.1", true], ["[::ffff:10.0.0.1]", true], ["[fd00::1]", true],
    ["8.8.8.8", false], ["[2606:4700::1111]", false], ["jithendar.com", false], ["localhost", false],
  ])("literal host %s blocked=%s", (host, blocked) => expect(isBlockedLiteral(host)).toBe(blocked));

  it.each(["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://2130706433/", "http://0x7f.1/", "https://10.96.0.1/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:7f00:1]/"])(
    "the link checker's fetcher refuses %s before connecting",
    async (url) => {
      const r = await publicFetcher({ timeoutMs: 2000, maxBytes: 10_000, maxRedirects: 3 })(url);
      expect(r.status).toBe(0);
      expect(r.error ?? "").toMatch(/non-public address/);
    },
  );

  it("refuses hosts outside the allowlist, including through redirects", async () => {
    const f = safeFetcher(new URL("https://jithendar.com"), { timeoutMs: 2000, maxBytes: 10_000, maxRedirects: 3 });
    const r = await f("https://evil.example/");
    expect(r).toMatchObject({ status: 0, error: expect.stringMatching(/outside the allowlist/) });
    expect([...allowedHosts(new URL("https://jithendar.com"))].sort()).toEqual(["jithendar.com", "www.jithendar.com"]);
  });
});

describe("robots.txt", () => {
  const r = parseRobots("User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /grafana$\n\nUser-agent: badbot\nDisallow: /\n\nSitemap: https://jithendar.com/sitemap.xml\n");
  it("parses groups and sitemaps and applies longest-match", () => {
    expect(r.sitemaps).toEqual(["https://jithendar.com/sitemap.xml"]);
    expect(robotsAllows(r, "/blog/x")).toBe(true);
    expect(robotsAllows(r, "/api/health")).toBe(false);
    expect(robotsAllows(r, "/grafana")).toBe(false);
    expect(robotsAllows(r, "/grafana-tips")).toBe(true);
    expect(robotsAllows(r, "/blog/x", "badbot")).toBe(false);
  });
});

// --- A small fake site (FIXTURE) ----------------------------------------------------------------------------------
const ORIGIN = new URL("https://jithendar.com");
const head = (o: { title?: string; desc?: string; canonical?: string; robots?: string; viewport?: boolean; ld?: string; og?: boolean }) =>
  `<head>${o.title ? `<title>${o.title}</title>` : ""}${o.desc ? `<meta name="description" content="${o.desc}">` : ""}${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ""}${o.robots ? `<meta name="robots" content="${o.robots}">` : ""}${o.viewport === false ? "" : '<meta name="viewport" content="width=device-width">'}${o.og === false ? "" : '<meta property="og:title" content="t"><meta property="og:image" content="/i.png">'}${o.ld ?? '<script type="application/ld+json">{"@type":"BlogPosting"}</script>'}</head>`;
const SITE: Record<string, { status?: number; html?: string; location?: string; xrobots?: string; type?: string }> = {
  "/robots.txt": { type: "text/plain", html: "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /blog/secret\nSitemap: https://jithendar.com/sitemap.xml\n" },
  "/sitemap.xml": { type: "application/xml", html: `<urlset><url><loc>https://jithendar.com/</loc></url><url><loc>https://jithendar.com/blog/a</loc></url><url><loc>https://jithendar.com/blog/orphan</loc></url><url><loc>https://jithendar.com/blog/hidden</loc></url><url><loc>https://jithendar.com/old</loc></url><url><loc>http://other.example/x</loc></url></urlset>` },
  "/": { html: `<html>${head({ title: "Home", desc: "d0", canonical: "https://jithendar.com/" })}<body><h1>Home</h1><a href="/blog/a">a</a><a href="/blog/b">b</a><a href="/admin">admin</a><a href="/blog/secret">s</a><a href="/old">old</a><a href="/blog/hidden">h</a></body></html>` },
  "/blog/a": { html: `<html>${head({ title: "Same title", desc: "d1", canonical: "https://jithendar.com/blog/a" })}<body><h1>A</h1><h3>skip</h3><img src="/x.png"><a href="/blog/missing">broken</a></body></html>` },
  "/blog/b": { html: `<html>${head({ title: "Same title", desc: "d2", canonical: "https://jithendar.com/blog/b", viewport: false, ld: '<script type="application/ld+json">{not json</script>' })}<body><h1>B</h1></body></html>` },
  "/blog/orphan": { html: `<html>${head({ title: "Orphan", desc: "d3", canonical: "https://jithendar.com/blog/orphan" })}<body><h1>O</h1></body></html>` },
  "/blog/hidden": { html: `<html>${head({ title: "Hidden", desc: "d4", canonical: "https://jithendar.com/blog/hidden", robots: "noindex, follow" })}<body><h1>H</h1></body></html>` },
  "/old": { status: 308, location: "/older" },
  "/older": { status: 308, location: "/blog/a" },
  "/blog/missing": { status: 404, html: "<html><head><title>404</title></head></html>" },
};
const requested: string[] = [];
async function fakeFetch(url: string): Promise<FetchResult> {
  const redirects: FetchResult["redirects"] = [];
  let u = new URL(url);
  for (;;) {
    requested.push(u.pathname);
    const page = SITE[u.pathname] ?? { status: 404, html: "" };
    if (page.location) {
      const next = new URL(page.location, u);
      redirects.push({ from: u.href, to: next.href, status: page.status! });
      u = next;
      continue;
    }
    return { url, finalUrl: u.href, status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...(page.xrobots ? { "x-robots-tag": page.xrobots } : {}) }, body: page.html ?? "", redirects, truncated: false };
  }
}

describe("technical crawl (fixture site)", () => {
  it("parses pages and sitemaps", async () => {
    const p = parsePage(await fakeFetch("https://jithendar.com/blog/b"), ORIGIN);
    expect(p).toMatchObject({ title: "Same title", viewport: false, h1: 1 });
    expect(p.jsonLd[0]!.valid).toBe(false);
    expect(parseSitemap(SITE["/sitemap.xml"]!.html!).urls).toHaveLength(6);
  });

  it("finds the planted issues, never crawls private or disallowed paths, and paces requests", async () => {
    requested.length = 0;
    const sleeps: number[] = [];
    const r = await crawl(fakeFetch, ORIGIN, { maxPages: 50, requestsPerSecond: 1, sleep: async (ms) => void sleeps.push(ms) });
    const has = (check: string, path: string) => r.issues.some((i) => i.check === check && new URL(i.url).pathname === path);
    expect(has("broken_link", "/blog/a")).toBe(true);
    expect(has("status_code", "/blog/missing")).toBe(true);
    expect(has("orphan", "/blog/orphan")).toBe(true);
    expect(has("indexability", "/blog/hidden")).toBe(true);
    expect(has("redirect_chain", "/old")).toBe(true);
    expect(has("sitemap_redirect", "/old")).toBe(true);
    expect(has("duplicate_title", "/blog/a") && has("duplicate_title", "/blog/b")).toBe(true);
    expect(has("viewport", "/blog/b")).toBe(true);
    expect(has("json_ld", "/blog/b")).toBe(true);
    expect(has("alt_text", "/blog/a")).toBe(true);
    expect(has("headings", "/blog/a")).toBe(true);
    expect(r.issues.some((i) => i.check === "sitemap_url" && i.url.startsWith("http://other.example"))).toBe(true);
    expect(requested).not.toContain("/admin");
    expect(requested).not.toContain("/blog/secret");
    expect(sleeps.every((ms) => ms === 1000)).toBe(true);
    expect(has("orphan", "/blog/a")).toBe(false);
  });

  describe("as a job", () => {
    let db: Db;
    beforeEach(async () => {
      db = await freshDb();
      await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
      const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
      await saveSeoSettings(settingsInput(), "admin");
    });
    afterEach(() => setDbForTests(undefined));
    it("stores the scan and issues; URL Inspection and PageSpeed stay off by default", async () => {
      const { getSeoSettings } = await import("@/lib/seo-intel/settings");
      const calls: string[] = [];
      const ctx = { db, settings: await getSeoSettings(), stats: { apiRequests: 0, retries: 0 }, correlationId: "c", payload: { type: "technical_scan" as const, trigger: "manual" as const }, now: new Date(), deps: { sleep: async () => {}, env: { SITE_URL: "https://jithendar.com", PAGESPEED_API_KEY: "k" }, fetchImpl: (async (u: string) => { calls.push(u); return new Response("{}"); }) as unknown as typeof fetch }, heartbeat: async () => {} };
      const out = await runTechnicalScan(ctx, { fetcher: fakeFetch });
      expect(out.status).toBe("succeeded");
      expect(calls).toEqual([]);
      const latest = await latestScan();
      expect(latest!.scan.pagesCrawled).toBeGreaterThan(4);
      expect(latest!.byCheck.some((b) => b.check === "orphan")).toBe(true);
    });
  });
});
