import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { readServiceAccount, SCOPES } from "./google/auth";
import { googleJson } from "./google/http";
import { AI_CRAWLERS, aiCrawlerAllowed, aiCrawlerPolicy, type AiCrawlerPolicy } from "@/lib/seo/ai-crawlers";
import { parseRobots, robotsAllows, safeFetcher, type FetchResult, type PageFetcher, type Robots } from "./crawler";
import type { RunContext, RunOutcome } from "./jobs";
import { normalizeUrl, siteOrigin } from "./urls";

/**
 * Weekly technical SEO audit of the public site (own host only). Checks: robots.txt, sitemaps, status codes,
 * redirect chains, canonicals, titles and meta descriptions (missing/duplicate), headings, alt text, JSON-LD
 * validity, Open Graph, viewport, indexability (meta robots, X-Robots-Tag, canonical conflicts), broken internal
 * links and orphaned pages; title and description length, thin content, pages that seem to need JavaScript to show
 * their text, slow responses, dead ends (no internal links), click depth from the home page, and AI-crawler access
 * (robots.txt against the site's policy, and the home page requested as each AI crawler). Optional: URL Inspection
 * (Google's last-known state) and PageSpeed Insights / CrUX.
 * Private paths are never crawled.
 */
export type Issue = { url: string; check: string; severity: "error" | "warning" | "info"; message: string; detail?: Record<string, unknown> };
export type PageInfo = {
  url: string;
  status: number;
  redirects: FetchResult["redirects"];
  finalUrl: string;
  title: string | null;
  description: string | null;
  canonical: string | null;
  metaRobots: string | null;
  xRobots: string | null;
  h1: number;
  headingSkip: boolean;
  imgNoAlt: number;
  jsonLd: { valid: boolean; types: string[] }[];
  ogTitle: boolean;
  ogImage: boolean;
  viewport: boolean;
  links: string[];
  html: boolean;
  /** Words of visible text in <main> (the whole body when there is none), scripts, styles and navigation removed. */
  words: number;
  scripts: number;
  elapsedMs: number | null;
  error?: string;
};

/** Thresholds for the content and performance checks. */
export const THIN_WORDS = 300;
export const JS_SHELL_WORDS = 50;
export const SLOW_MS = { info: 1500, warning: 3000 };
export const MAX_CLICK_DEPTH = 3;
export const TITLE_CHARS = { min: 15, max: 65 };
export const DESCRIPTION_CHARS = { min: 70, max: 160 };

export function visibleWords(body: string): number {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(body)?.[1] ?? body;
  const text = decode(
    main
      .replace(/<(script|style|noscript|template|svg|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const PRIVATE = /^\/(admin|api|account|login|setup|preview|_next)(\/|$)/;
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decode(m[2] ?? m[3] ?? "") : null;
};
const metaContent = (html: string, key: "name" | "property", value: string) => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if ((attr(m[0], key) ?? "").toLowerCase() === value) return attr(m[0], "content");
  return null;
};

export function parsePage(res: FetchResult, origin: URL): PageInfo {
  const html = (res.headers["content-type"] ?? "").includes("text/html");
  const body = html ? res.body : "";
  const head = body.slice(0, body.search(/<\/head>/i) > 0 ? body.search(/<\/head>/i) : body.length);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim() ?? null;
  const canonicalTag = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => (attr(t, "rel") ?? "").toLowerCase() === "canonical");
  const headings = [...body.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  const jsonLd = [...body.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
    try {
      const v = JSON.parse(m[1]!) as unknown;
      const items = Array.isArray(v) ? v : (v as { "@graph"?: unknown[] })["@graph"] ?? [v];
      const types = (items as { "@type"?: string | string[] }[]).flatMap((i) => (Array.isArray(i?.["@type"]) ? i["@type"] : i?.["@type"] ? [i["@type"]] : []));
      return { valid: types.length > 0, types };
    } catch {
      return { valid: false, types: [] };
    }
  });
  const links = [...body.matchAll(/<a\b[^>]*>/gi)]
    .map((m) => attr(m[0], "href"))
    .filter((h): h is string => Boolean(h) && !h!.startsWith("#") && !/^(mailto|tel|javascript):/i.test(h!))
    .map((h) => {
      try {
        return new URL(h, res.finalUrl).href;
      } catch {
        return null;
      }
    })
    .filter((h): h is string => h !== null && normalizeUrl(h, origin)?.internal === true);
  return {
    url: res.url,
    status: res.status,
    redirects: res.redirects,
    finalUrl: res.finalUrl,
    title: title ? decode(title) : null,
    description: metaContent(head, "name", "description"),
    canonical: canonicalTag ? attr(canonicalTag, "href") : null,
    metaRobots: metaContent(head, "name", "robots"),
    xRobots: res.headers["x-robots-tag"] ?? null,
    h1: headings.filter((h) => h === 1).length,
    headingSkip: headings.some((h, i) => i > 0 && h > headings[i - 1]! + 1),
    imgNoAlt: [...body.matchAll(/<img\b[^>]*>/gi)].filter((m) => attr(m[0], "alt") === null).length,
    jsonLd,
    ogTitle: Boolean(metaContent(head, "property", "og:title")),
    ogImage: Boolean(metaContent(head, "property", "og:image")),
    viewport: Boolean(metaContent(head, "name", "viewport")),
    links: [...new Set(links)],
    html,
    words: html ? visibleWords(body) : 0,
    scripts: [...body.matchAll(/<script\b/gi)].length,
    elapsedMs: res.elapsedMs ?? null,
    error: res.error,
  };
}

export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (tag: string) => [...xml.matchAll(new RegExp(`<${tag}>[\\s\\S]*?<loc>\\s*([^<]+?)\\s*</loc>`, "gi"))].map((m) => decode(m[1]!));
  return { urls: locs("url"), sitemaps: locs("sitemap") };
}

const noindex = (p: PageInfo) => /noindex/i.test(p.metaRobots ?? "") || /noindex/i.test(p.xRobots ?? "");

/** Pure checks over crawled pages (unit-tested). */
export function checkPages(pages: Map<string, PageInfo>, sitemapUrls: Set<string>, origin: URL): Issue[] {
  const issues: Issue[] = [];
  const norm = (u: string) => normalizeUrl(u, origin)?.url ?? u;
  const inbound = new Map<string, number>();
  for (const p of pages.values()) for (const l of p.links) if (norm(l) !== norm(p.url)) inbound.set(norm(l), (inbound.get(norm(l)) ?? 0) + 1);
  const titles = new Map<string, string[]>();
  const descs = new Map<string, string[]>();
  const depth = clickDepths(pages, origin);
  for (const p of pages.values()) {
    const u = p.url;
    if (p.error && p.status === 0) {
      issues.push({ url: u, check: "fetch_error", severity: "error", message: p.error });
      continue;
    }
    if (p.status >= 400) issues.push({ url: u, check: "status_code", severity: "error", message: `HTTP ${p.status}.`, detail: { linkedFrom: inbound.get(norm(u)) ?? 0, inSitemap: sitemapUrls.has(norm(u)) } });
    if (p.redirects.length > 1) issues.push({ url: u, check: "redirect_chain", severity: "warning", message: `Redirect chain of ${p.redirects.length} hops: ${[p.redirects[0]!.from, ...p.redirects.map((r) => r.to)].join(" → ")}.` });
    if (p.redirects.length && sitemapUrls.has(norm(u))) issues.push({ url: u, check: "sitemap_redirect", severity: "warning", message: "The sitemap lists a URL that redirects; list the final URL instead." });
    if (p.elapsedMs !== null && p.elapsedMs >= SLOW_MS.info) issues.push({ url: u, check: "slow_response", severity: p.elapsedMs >= SLOW_MS.warning ? "warning" : "info", message: `Took ${(p.elapsedMs / 1000).toFixed(1)} s to answer (audit crawler, redirects included).`, detail: { elapsedMs: p.elapsedMs } });
    if (p.status !== 200 || !p.html) continue;
    const indexable = !noindex(p);
    const isHome = new URL(norm(u)).pathname === "/";
    if (indexable && !isHome && sitemapUrls.has(norm(u))) {
      if (p.words < JS_SHELL_WORDS && p.scripts > 0) issues.push({ url: u, check: "js_rendering", severity: "warning", message: `Only ${p.words} words in the HTML: the text seems to need JavaScript, which AI crawlers and some search crawlers do not run.`, detail: { words: p.words, scripts: p.scripts } });
      else if (p.words < THIN_WORDS) issues.push({ url: u, check: "thin_content", severity: "warning", message: `Thin content: ${p.words} words of main text (under ${THIN_WORDS}).`, detail: { words: p.words } });
    }
    if (!p.links.some((l) => norm(l) !== norm(u))) issues.push({ url: u, check: "dead_end", severity: "warning", message: "No links to other pages on this site: readers and crawlers stop here." });
    const d = depth.get(norm(u));
    if (indexable && d !== undefined && d > MAX_CLICK_DEPTH) issues.push({ url: u, check: "click_depth", severity: d > MAX_CLICK_DEPTH + 1 ? "warning" : "info", message: `${d} clicks from the home page (keep important pages within ${MAX_CLICK_DEPTH}).`, detail: { depth: d } });
    if (p.title && (p.title.length < TITLE_CHARS.min || p.title.length > TITLE_CHARS.max)) issues.push({ url: u, check: "title_length", severity: "info", message: `Title is ${p.title.length} characters (aim for ${TITLE_CHARS.min}–${TITLE_CHARS.max}; longer ones are cut off in results).` });
    if (p.description && (p.description.length < DESCRIPTION_CHARS.min || p.description.length > DESCRIPTION_CHARS.max)) issues.push({ url: u, check: "description_length", severity: "info", message: `Meta description is ${p.description.length} characters (aim for ${DESCRIPTION_CHARS.min}–${DESCRIPTION_CHARS.max}).` });
    const canon = p.canonical ? norm(p.canonical) : null;
    if (!p.canonical) issues.push({ url: u, check: "canonical", severity: "warning", message: "No canonical link." });
    else if (canon !== norm(p.finalUrl)) {
      issues.push({ url: u, check: "canonical", severity: sitemapUrls.has(norm(u)) ? "warning" : "info", message: `Canonical points to ${p.canonical}.`, detail: { inSitemap: sitemapUrls.has(norm(u)) } });
      const target = pages.get(canon!);
      if (target && target.status !== 200) issues.push({ url: u, check: "canonical", severity: "error", message: `Canonical target answers HTTP ${target.status}.` });
    }
    if (!p.title) issues.push({ url: u, check: "title", severity: "error", message: "Missing <title>." });
    else titles.set(p.title, [...(titles.get(p.title) ?? []), u]);
    if (!p.description) issues.push({ url: u, check: "meta_description", severity: "warning", message: "Missing meta description." });
    else descs.set(p.description, [...(descs.get(p.description) ?? []), u]);
    if (p.h1 === 0) issues.push({ url: u, check: "headings", severity: "warning", message: "No H1." });
    if (p.h1 > 1) issues.push({ url: u, check: "headings", severity: "info", message: `${p.h1} H1 elements.` });
    if (p.headingSkip) issues.push({ url: u, check: "headings", severity: "info", message: "Heading levels skip (e.g. H2 → H4)." });
    if (p.imgNoAlt) issues.push({ url: u, check: "alt_text", severity: "warning", message: `${p.imgNoAlt} image(s) without an alt attribute.` });
    if (p.jsonLd.some((j) => !j.valid)) issues.push({ url: u, check: "json_ld", severity: "error", message: "A JSON-LD block is not valid JSON or has no @type." });
    if (!p.ogTitle || !p.ogImage) issues.push({ url: u, check: "open_graph", severity: "info", message: `Missing ${[!p.ogTitle && "og:title", !p.ogImage && "og:image"].filter(Boolean).join(" and ")}.` });
    if (!p.viewport) issues.push({ url: u, check: "viewport", severity: "error", message: "No viewport meta tag." });
    if (noindex(p) && sitemapUrls.has(norm(u))) issues.push({ url: u, check: "indexability", severity: "error", message: "Listed in the sitemap but marked noindex.", detail: { metaRobots: p.metaRobots, xRobotsTag: p.xRobots } });
    if (noindex(p) && canon && canon !== norm(p.finalUrl)) issues.push({ url: u, check: "indexability", severity: "warning", message: "noindex combined with a canonical to another URL sends conflicting signals." });
    for (const l of p.links) {
      const t = pages.get(norm(l));
      if (t && t.status >= 400) issues.push({ url: u, check: "broken_link", severity: "error", message: `Links to ${new URL(l).pathname} (HTTP ${t.status}).` });
    }
  }
  for (const [t, urls] of titles) if (urls.length > 1) for (const u of urls) issues.push({ url: u, check: "duplicate_title", severity: "warning", message: `Title shared with ${urls.length - 1} other page(s): "${t.slice(0, 80)}".` });
  for (const [, urls] of descs) if (urls.length > 1) for (const u of urls) issues.push({ url: u, check: "duplicate_description", severity: "info", message: `Meta description shared with ${urls.length - 1} other page(s).` });
  for (const s of sitemapUrls) {
    const p = pages.get(s);
    if (p && p.status === 200 && !inbound.get(s) && new URL(s).pathname !== "/") issues.push({ url: s, check: "orphan", severity: "warning", message: "In the sitemap but not linked from any crawled page (orphan)." });
  }
  return issues;
}

/** Shortest number of link hops from the home page to each crawled page (pages it cannot reach are absent). */
export function clickDepths(pages: Map<string, PageInfo>, origin: URL): Map<string, number> {
  const norm = (u: string) => normalizeUrl(u, origin)?.url ?? u;
  const home = norm(new URL("/", origin).href);
  const depth = new Map<string, number>();
  if (!pages.has(home)) return depth;
  depth.set(home, 0);
  const queue = [home];
  while (queue.length) {
    const at = queue.shift()!;
    for (const l of pages.get(at)?.links ?? []) {
      const n = norm(l);
      if (!depth.has(n) && pages.has(n)) {
        depth.set(n, depth.get(at)! + 1);
        queue.push(n);
      }
    }
  }
  return depth;
}

const BLOCKED_STATUS = new Set([0, 401, 403, 406, 429, 503]);
const challenge = (r: FetchResult) => /cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required!/i.test(r.body.slice(0, 20_000));

/**
 * AI crawlers: robots.txt must say what the site's policy says, and an allowed crawler must actually get the page. A CDN
 * or firewall rule (Cloudflare's AI bot blocking, Bot Fight Mode, a WAF rule) can turn them away whatever robots.txt
 * says. The live request comes from this server with the crawler's User-Agent, not from the vendor's addresses, so a
 * block here is a strong hint, not proof: the CDN may treat the real crawler differently.
 */
export async function checkAiCrawlers(robots: Robots, origin: URL, policy: AiCrawlerPolicy, opts: { homeStatus: number | null; fetchAs?: (url: string, userAgent: string) => Promise<FetchResult>; sleep: (ms: number) => Promise<void>; gap: number }): Promise<Issue[]> {
  const issues: Issue[] = [];
  const robotsUrl = new URL("/robots.txt", origin).href;
  const home = new URL("/", origin).href;
  const allowedByRobots: string[] = [];
  for (const c of AI_CRAWLERS) {
    const want = aiCrawlerAllowed(c, policy);
    const robotsSays = robotsAllows(robots, "/", c.token.toLowerCase());
    if (robotsSays) allowedByRobots.push(c.token);
    if (want !== robotsSays) issues.push({ url: robotsUrl, check: "ai_crawlers", severity: c.purpose === "search" && !robotsSays ? "error" : "warning", message: `robots.txt ${robotsSays ? "allows" : "blocks"} ${c.token} (${c.vendor}, ${c.purpose === "search" ? "AI answers and citations" : "model training"}) but the site policy is to ${want ? "allow" : "block"} it.`, detail: { token: c.token, purpose: c.purpose } });
    if (!want || !robotsSays || !c.userAgent || !opts.fetchAs || opts.homeStatus !== 200) continue;
    await opts.sleep(opts.gap);
    const r = await opts.fetchAs(home, c.userAgent);
    if (BLOCKED_STATUS.has(r.status) || challenge(r)) {
      issues.push({ url: home, check: "ai_crawlers", severity: c.purpose === "search" ? "error" : "warning", message: `${c.token} (${c.vendor}) ${challenge(r) ? "got a bot challenge page" : r.status ? `got HTTP ${r.status}` : "was refused"} for the home page, while the audit crawler got 200: a CDN or firewall rule seems to block it even though robots.txt allows it. Check the CDN's AI crawler and bot settings. (Tested with its User-Agent from this server, not from ${c.vendor}'s addresses.)`, detail: { token: c.token, purpose: c.purpose, status: r.status, challenge: challenge(r) } });
    }
  }
  issues.push({ url: robotsUrl, check: "ai_crawlers", severity: "info", message: `AI crawler policy: answer engines ${policy.search}, model training ${policy.training}. robots.txt allows ${allowedByRobots.length} of ${AI_CRAWLERS.length} known AI crawlers${allowedByRobots.length ? ` (${allowedByRobots.join(", ")})` : ""}.` });
  return issues;
}

/** Crawl (BFS from the sitemap and home page), politely and within limits. */
export async function crawl(fetcher: PageFetcher, origin: URL, opts: { maxPages: number; requestsPerSecond: number; sleep?: (ms: number) => Promise<void>; aiPolicy?: AiCrawlerPolicy; fetchAs?: (url: string, userAgent: string) => Promise<FetchResult> }) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = Math.ceil(1000 / opts.requestsPerSecond);
  const issues: Issue[] = [];
  const robotsUrl = new URL("/robots.txt", origin).href;
  const robotsRes = await fetcher(robotsUrl);
  let robots: Robots = { groups: [], sitemaps: [] };
  if (robotsRes.status !== 200) issues.push({ url: robotsUrl, check: "robots_txt", severity: "error", message: `robots.txt not reachable (${robotsRes.error ?? `HTTP ${robotsRes.status}`}).` });
  else {
    robots = parseRobots(robotsRes.body);
    if (!robots.groups.length) issues.push({ url: robotsUrl, check: "robots_txt", severity: "warning", message: "robots.txt has no User-agent groups." });
    if (!robotsAllows(robots, "/", "googlebot")) issues.push({ url: robotsUrl, check: "robots_txt", severity: "error", message: "robots.txt disallows the home page for Googlebot." });
    if (!robots.sitemaps.length) issues.push({ url: robotsUrl, check: "robots_txt", severity: "info", message: "robots.txt advertises no Sitemap." });
  }
  const sitemapUrls = new Set<string>();
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [new URL("/sitemap.xml", origin).href];
  const seenMaps = new Set<string>();
  while (queue.length && seenMaps.size < 20) {
    const sm = queue.shift()!;
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    await sleep(gap);
    const res = await fetcher(sm);
    if (res.status !== 200) {
      issues.push({ url: sm, check: "sitemap", severity: "error", message: `Sitemap not reachable (${res.error ?? `HTTP ${res.status}`}).` });
      continue;
    }
    const parsed = parseSitemap(res.body);
    queue.push(...parsed.sitemaps);
    for (const u of parsed.urls) {
      const n = normalizeUrl(u, origin);
      if (!n || !n.internal || !u.startsWith("https://")) issues.push({ url: u, check: "sitemap_url", severity: "error", message: "Sitemap URL is not an absolute https URL on this site." });
      else if (n.url !== u.replace(/\/$/, "") && n.url !== u) issues.push({ url: u, check: "sitemap_url", severity: "warning", message: `Sitemap URL is not in canonical form (${n.url}).` });
      if (n?.internal) sitemapUrls.add(n.url);
    }
  }
  const pages = new Map<string, PageInfo>();
  const todo = [new URL("/", origin).href, ...sitemapUrls];
  const queued = new Set(todo.map((u) => normalizeUrl(u, origin)!.url));
  while (todo.length && pages.size < opts.maxPages) {
    const url = todo.shift()!;
    const n = normalizeUrl(url, origin)!;
    if (PRIVATE.test(n.path) || !robotsAllows(robots, n.path)) continue;
    await sleep(gap);
    const page = parsePage(await fetcher(n.url), origin);
    pages.set(n.url, page);
    for (const l of page.links) {
      const ln = normalizeUrl(l, origin);
      if (ln && !queued.has(ln.url) && !PRIVATE.test(ln.path) && !/\.(png|jpe?g|webp|avif|gif|svg|pdf|xml|txt|ico|css|js)$/i.test(ln.path)) {
        queued.add(ln.url);
        todo.push(ln.url);
      }
    }
  }
  issues.push(...checkPages(pages, sitemapUrls, origin));
  if (robotsRes.status === 200) {
    const homeStatus = pages.get(normalizeUrl(new URL("/", origin).href, origin)!.url)?.status ?? null;
    issues.push(...(await checkAiCrawlers(robots, origin, opts.aiPolicy ?? aiCrawlerPolicy(), { homeStatus, fetchAs: opts.fetchAs, sleep, gap })));
  }
  return { issues, pages, sitemapUrls, truncated: todo.length > 0 };
}

// --- Optional Google services -------------------------------------------------------------------------------------

async function urlInspection(ctx: RunContext, urls: string[]): Promise<Issue[]> {
  const s = ctx.settings;
  if (!s.google.urlInspection.enabled || !s.google.gscProperty) return [];
  const sa = readServiceAccount(ctx.deps.env);
  if (!sa) return [];
  const [used] = rowsOf<{ n: number }>(await ctx.db.execute(sql`select count(*)::int as n from seo_technical_issues i join seo_technical_scans t on t.id = i.scan_id where i.check_key = 'url_inspection' and t.started_at > now() - interval '1 day'`));
  const budget = Math.max(0, Math.min(s.google.urlInspection.dailyLimit, 2000) - Number(used?.n ?? 0));
  const out: Issue[] = [];
  const api = { sa, scope: SCOPES.searchConsole, provider: "url_inspection" as const, stats: ctx.stats, maxRequests: ctx.stats.apiRequests + budget, fetchImpl: ctx.deps.fetchImpl, sleep: ctx.deps.sleep };
  for (const url of urls.slice(0, budget)) {
    try {
      const r = await googleJson<{ inspectionResult?: { indexStatusResult?: Record<string, string> } }>(api, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: url, siteUrl: s.google.gscProperty });
      const st = r.inspectionResult?.indexStatusResult ?? {};
      const notIndexed = st.verdict && st.verdict !== "PASS";
      const canonMismatch = st.googleCanonical && st.userCanonical && st.googleCanonical !== st.userCanonical;
      out.push({ url, check: "url_inspection", severity: notIndexed || canonMismatch ? "warning" : "info", message: `Google's last-known state: ${st.coverageState ?? st.verdict ?? "unknown"}${canonMismatch ? `; Google chose canonical ${st.googleCanonical}` : ""}. Not a live indexing guarantee.`, detail: { verdict: st.verdict, coverageState: st.coverageState, robotsTxtState: st.robotsTxtState, indexingState: st.indexingState, lastCrawlTime: st.lastCrawlTime, googleCanonical: st.googleCanonical, userCanonical: st.userCanonical } });
    } catch (e) {
      out.push({ url, check: "url_inspection", severity: "info", message: `URL Inspection failed: ${(e as Error).message}`.slice(0, 300) });
      if ((e as { code?: string }).code === "auth" || (e as { code?: string }).code === "quota") break;
    }
  }
  return out;
}

async function pageSpeed(ctx: RunContext, urls: string[]): Promise<Issue[]> {
  const key = (ctx.deps.env ?? process.env).PAGESPEED_API_KEY?.trim();
  if (!ctx.settings.google.pageSpeed.enabled || !key) return [];
  const out: Issue[] = [];
  const fetchImpl = ctx.deps.fetchImpl ?? fetch;
  for (const url of urls.slice(0, 5)) {
    try {
      const res = await fetchImpl(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${new URLSearchParams({ url, strategy: "mobile", category: "performance", key })}`, { signal: AbortSignal.timeout(60_000) });
      ctx.stats.apiRequests++;
      if (!res.ok) {
        out.push({ url, check: "pagespeed", severity: "info", message: `PageSpeed Insights HTTP ${res.status}.` });
        continue;
      }
      const d = (await res.json()) as { loadingExperience?: { overall_category?: string; metrics?: Record<string, { category?: string; percentile?: number }> }; lighthouseResult?: { categories?: { performance?: { score?: number } } } };
      const field = d.loadingExperience?.metrics ?? {};
      const slow = Object.entries(field).filter(([, m]) => m.category === "SLOW").map(([k]) => k);
      out.push({ url, check: "pagespeed", severity: slow.length ? "warning" : "info", message: `CrUX field data: ${d.loadingExperience?.overall_category ?? "not enough real-user data"}${slow.length ? ` (slow: ${slow.join(", ")})` : ""}; Lighthouse lab score ${Math.round((d.lighthouseResult?.categories?.performance?.score ?? 0) * 100)}.`, detail: { field, lab: d.lighthouseResult?.categories?.performance?.score ?? null } });
    } catch {
      out.push({ url, check: "pagespeed", severity: "info", message: "PageSpeed Insights request failed." });
    }
  }
  return out;
}

// --- Job ----------------------------------------------------------------------------------------------------------

/** `fetchAs` requests a URL with another User-Agent (AI-crawler access check); with a test `fetcher` and no `fetchAs`, that live check is skipped. */
export type TechDeps = { fetcher?: PageFetcher; fetchAs?: (url: string, userAgent: string) => Promise<FetchResult> };

export async function runTechnicalScan(ctx: RunContext, deps: TechDeps = {}): Promise<RunOutcome> {
  const db = ctx.db;
  const origin = siteOrigin(ctx.deps.env ?? process.env);
  const c = ctx.settings.crawler;
  const fetchOpts = { timeoutMs: c.timeoutMs, maxBytes: c.maxBytes, maxRedirects: c.maxRedirects };
  const fetcher = deps.fetcher ?? safeFetcher(origin, fetchOpts);
  const fetchAs = deps.fetchAs ?? (deps.fetcher ? undefined : (url: string, userAgent: string) => safeFetcher(origin, fetchOpts, { "User-Agent": userAgent })(url));
  const [scan] = rowsOf<{ id: string }>(await db.execute(sql`insert into seo_technical_scans (status) values ('running') returning id`));
  try {
    const r = await crawl(fetcher, origin, { maxPages: c.maxPages, requestsPerSecond: c.requestsPerSecond, sleep: ctx.deps.sleep, fetchAs });
    const top = rowsOf<{ page: string }>(await db.execute(sql`select page from seo_gsc_page_daily where date > current_date - 28 and search_type = 'web' group by page order by sum(clicks) desc limit 50`)).map((p) => p.page);
    const extra = [...(await urlInspection(ctx, top)), ...(await pageSpeed(ctx, top))];
    const issues = [...r.issues, ...extra];
    await saveIssues(db, scan!.id, issues);
    const summary = { pages: r.pages.size, sitemapUrls: r.sitemapUrls.size, truncated: r.truncated, bySeverity: Object.fromEntries(["error", "warning", "info"].map((s) => [s, issues.filter((i) => i.severity === s).length])) };
    await db.execute(sql`update seo_technical_scans set status = 'succeeded', finished_at = now(), pages_crawled = ${r.pages.size}, summary = ${JSON.stringify(summary)}::jsonb where id = ${scan!.id}`);
    return { status: r.truncated ? "partial" : "succeeded", rows: issues.length, detail: { scanId: scan!.id, ...summary } };
  } catch (e) {
    await db.execute(sql`update seo_technical_scans set status = 'failed', finished_at = now() where id = ${scan!.id}`);
    throw e;
  }
}

async function saveIssues(db: Db, scanId: string, issues: Issue[]) {
  for (let i = 0; i < issues.length; i += 200) {
    const chunk = issues.slice(i, i + 200);
    await db.execute(sql`insert into seo_technical_issues (scan_id, url, check_key, severity, message, detail) values ${sql.join(chunk.map((x) => sql`(${scanId}, ${x.url.slice(0, 2000)}, ${x.check}, ${x.severity}, ${x.message.slice(0, 1000)}, ${JSON.stringify(x.detail ?? {})}::jsonb)`), sql`, `)}`);
  }
}

export async function latestScan(opts: { severity?: string; check?: string; limit?: number; offset?: number } = {}) {
  const db = await getDb();
  const [scan] = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_technical_scans order by started_at desc limit 1`));
  if (!scan) return null;
  const parts = [sql`scan_id = ${scan.id}`];
  if (opts.severity && ["error", "warning", "info"].includes(opts.severity)) parts.push(sql`severity = ${opts.severity}`);
  if (opts.check && /^[a-z_]{1,40}$/.test(opts.check)) parts.push(sql`check_key = ${opts.check}`);
  const issues = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select url, check_key, severity, message, detail, count(*) over ()::int as total from seo_technical_issues where ${sql.join(parts, sql` and `)}
      order by case severity when 'error' then 0 when 'warning' then 1 else 2 end, check_key, url limit ${Math.min(500, opts.limit ?? 200)} offset ${opts.offset ?? 0}`),
  );
  const byCheck = rowsOf<{ check_key: string; severity: string; n: number }>(await db.execute(sql`select check_key, severity, count(*)::int as n from seo_technical_issues where scan_id = ${scan.id} group by 1, 2 order by 3 desc`));
  return {
    scan: { id: String(scan.id), status: String(scan.status), startedAt: new Date(String(scan.started_at)).toISOString(), finishedAt: scan.finished_at ? new Date(String(scan.finished_at)).toISOString() : null, pagesCrawled: Number(scan.pages_crawled), summary: scan.summary },
    total: Number(issues[0]?.total ?? 0),
    byCheck: byCheck.map((b) => ({ check: b.check_key, severity: b.severity, count: Number(b.n) })),
    issues: issues.map((i) => ({ url: String(i.url), check: String(i.check_key), severity: String(i.severity), message: String(i.message), detail: i.detail })),
  };
}
