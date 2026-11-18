import { describe, expect, it, vi } from "vitest";
import type { Article } from "@/lib/content";
import type { FetchResult } from "@/lib/seo-intel/crawler";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { AI_CRAWLERS, aiCrawlerPolicy } = await import("@/lib/seo/ai-crawlers");
const { robotsTxt } = await import("@/lib/seo/robots");
const { buildLlmsTxt } = await import("@/lib/seo/llms");
const { parseRobots, robotsAllows } = await import("@/lib/seo-intel/crawler");
const { checkAiCrawlers, checkPages, clickDepths, parsePage, visibleWords } = await import("@/lib/seo-intel/technical");

const ORIGIN = new URL("https://jithendar.com");
const res = (path: string, body: string, extra: Partial<FetchResult> = {}): FetchResult => ({ url: `https://jithendar.com${path}`, finalUrl: `https://jithendar.com${path}`, status: 200, headers: { "content-type": "text/html" }, body, redirects: [], truncated: false, ...extra });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const page = (title: string, main: string, links: string[] = [], o: { desc?: string; scripts?: number; nav?: boolean } = {}) =>
  `<html><head><title>${title}</title><meta name="description" content="${o.desc ?? "A description that is long enough to sit inside the recommended range for snippets."}"><link rel="canonical" href="x"></head><body>${o.nav === false ? "" : '<nav><a href="/">Home</a></nav>'}<main>${main}${links.map((l) => `<a href="${l}">l</a>`).join("")}</main>${"<script></script>".repeat(o.scripts ?? 0)}</body></html>`;

describe("robots.txt AI crawler policy", () => {
  it("allows every AI crawler by default, repeating the * rules, and blocks only what the policy blocks", () => {
    const allow = parseRobots(robotsTxt(true));
    for (const c of AI_CRAWLERS) {
      expect(robotsAllows(allow, "/blog/x", c.token.toLowerCase())).toBe(true);
      expect(robotsAllows(allow, "/api/x", c.token.toLowerCase())).toBe(false);
    }
    const noTraining = parseRobots(robotsTxt(true, { search: "allow", training: "block" }));
    expect(robotsAllows(noTraining, "/", "gptbot")).toBe(false);
    expect(robotsAllows(noTraining, "/", "google-extended")).toBe(false);
    expect(robotsAllows(noTraining, "/", "oai-searchbot")).toBe(true);
    expect(robotsAllows(noTraining, "/", "claude-user")).toBe(true);
    expect(robotsAllows(noTraining, "/", "googlebot")).toBe(true);
  });

  it("reads the policy from site.json and treats anything but \"block\" as allow", () => {
    expect(aiCrawlerPolicy({})).toEqual({ search: "allow", training: "allow" });
    expect(aiCrawlerPolicy({ aiCrawlers: { training: "block", search: "nope" } })).toEqual({ search: "allow", training: "block" });
  });
});

describe("llms.txt", () => {
  const art = (slug: string, category: string, extra: Record<string, unknown> = {}) => ({ collection: "blog", slug, path: `/blog/${slug}`, body: "", file: "", frontmatter: { title: `Title ${slug}`, description: `Description of ${slug}\nacross lines`, category, noindex: false, ...extra } }) as unknown as Article;
  it("lists indexable self-canonical articles by category and links the MCP server only when it is on", () => {
    const txt = buildLlmsTxt({ articles: [art("a", "kubernetes"), art("b", "ai"), art("hidden", "ai", { noindex: true }), art("syndicated", "ai", { canonicalUrl: "https://elsewhere.example/x" })], categoryLabel: (s) => s.toUpperCase(), mcpEnabled: false });
    expect(txt).toMatch(/^# .+\n\n> .+/);
    expect(txt.indexOf("## AI")).toBeLessThan(txt.indexOf("## KUBERNETES"));
    expect(txt).toContain("- [Title a](https://jithendar.com/blog/a): Description of a across lines");
    expect(txt).not.toContain("hidden");
    expect(txt).not.toContain("syndicated");
    expect(txt).not.toContain("/mcp/public");
    expect(buildLlmsTxt({ articles: [], mcpEnabled: true })).toContain("https://jithendar.com/mcp/public");
  });
});

describe("content, speed and structure checks", () => {
  const pages = (entries: [string, FetchResult][]) => new Map(entries.map(([u, r]) => [u, parsePage(r, ORIGIN)]));
  const u = (p: string) => `https://jithendar.com${p}`;

  it("counts visible main text only", () => {
    expect(visibleWords(`<body><nav>a b c</nav><main><p>one two</p><script>var x = 1</script><style>.a{}</style> three &amp; four</main><footer>z</footer></body>`)).toBe(4);
    expect(visibleWords(`<body><header>x</header><p>just body text</p></body>`)).toBe(3);
  });

  it("flags thin, JavaScript-only, slow, dead-end, deep and badly sized pages", () => {
    const chain = ["/", "/d1", "/d2", "/d3", "/d4", "/d5"];
    const site = pages([
      ...chain.map((p, i): [string, FetchResult] => [u(p), res(p, page(`Page at depth ${i} here`, words(400), chain[i + 1] ? [chain[i + 1]!] : ["/"]))]),
      [u("/thin"), res("/thin", page("A thin page title", words(120), ["/"]))],
      [u("/shell"), res("/shell", page("A shell page title", "<div id=root></div>", ["/"], { scripts: 4 }))],
      [u("/slow"), res("/slow", page("A slow page title", words(400), ["/"]), { elapsedMs: 3200 })],
      [u("/end"), res("/end", page("A dead end page", words(400), [], { desc: "short", nav: false }))],
      [u("/x"), res("/x", page("x", words(400), ["/"]))],
    ]);
    const sitemap = new Set([...site.keys()]);
    const issues = checkPages(site, sitemap, ORIGIN);
    const at = (check: string) => issues.filter((i) => i.check === check).map((i) => new URL(i.url).pathname);
    expect(at("thin_content")).toEqual(["/thin"]);
    expect(at("js_rendering")).toEqual(["/shell"]);
    expect(at("slow_response")).toEqual(["/slow"]);
    expect(issues.find((i) => i.check === "slow_response")!.severity).toBe("warning");
    expect(at("dead_end")).toEqual(["/end"]);
    expect(at("click_depth")).toEqual(["/d4", "/d5"]);
    expect(issues.find((i) => i.check === "click_depth" && i.url.endsWith("/d5"))!.severity).toBe("warning");
    expect(at("title_length")).toEqual(["/x"]);
    expect(at("description_length")).toEqual(["/end"]);
    expect(clickDepths(site, ORIGIN).get(u("/thin"))).toBeUndefined();
  });
});

describe("AI crawler access", () => {
  const sleep = async () => {};
  const opts = (fetchAs?: (url: string, ua: string) => Promise<FetchResult>) => ({ homeStatus: 200, fetchAs, sleep, gap: 0 });

  it("reports robots.txt that disagrees with the policy, errors for answer engines", async () => {
    const robots = parseRobots("User-agent: *\nAllow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n");
    const issues = await checkAiCrawlers(robots, ORIGIN, { search: "allow", training: "block" }, opts());
    const bad = issues.filter((i) => i.severity !== "info");
    expect(bad.find((i) => i.detail?.token === "PerplexityBot")!.severity).toBe("error");
    expect(bad.filter((i) => i.detail?.purpose === "training").length).toBe(AI_CRAWLERS.filter((c) => c.purpose === "training").length);
  });

  it("requests the home page as each allowed crawler and reports CDN blocks and challenge pages", async () => {
    const seen: string[] = [];
    const fetchAs = async (url: string, ua: string) => {
      seen.push(ua);
      if (ua.includes("GPTBot")) return res("/", "", { status: 403 });
      if (ua.includes("PerplexityBot")) return res("/", "<title>Just a moment...</title>");
      return res("/", "<html>ok</html>");
    };
    const issues = await checkAiCrawlers(parseRobots("User-agent: *\nAllow: /\n"), ORIGIN, { search: "allow", training: "allow" }, opts(fetchAs));
    expect(seen.length).toBe(AI_CRAWLERS.filter((c) => c.userAgent).length);
    const blocked = issues.filter((i) => i.severity !== "info").map((i) => [i.detail?.token, i.severity]);
    expect(blocked).toEqual([["PerplexityBot", "error"], ["GPTBot", "warning"]]);
  });

  it("skips the live requests when the home page itself failed", async () => {
    const fetchAs = vi.fn(async () => res("/", ""));
    await checkAiCrawlers(parseRobots("User-agent: *\nAllow: /\n"), ORIGIN, { search: "allow", training: "allow" }, { ...opts(fetchAs), homeStatus: 500 });
    expect(fetchAs).not.toHaveBeenCalled();
  });
});
