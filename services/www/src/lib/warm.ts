import { getCategories } from "./categories";
import { getPages, getPublishedContent } from "./content";
import { log } from "./log";
import { recordPageWarmup } from "./metrics";
import { compileMdx } from "./mdx/compile";
import { getSettings } from "./settings";

/** Load content/settings/categories and pre-compile every published body (and start Shiki) once. */
export async function warmCaches() {
  const started = Date.now();
  const [articles, pages] = await Promise.all([getPublishedContent(), getPages(), getSettings(), getCategories()]);
  for (const body of [...articles.map((a) => a.body), ...pages.map((p) => p.body)]) await compileMdx(body);
  log.info("caches warmed", { articles: articles.length, pages: pages.length, ms: Date.now() - started });
}

/**
 * Page warm-up: the "static generation" half of SSG + ISR. The build has no database, so instead of prerendering at
 * build time each pod renders every page listed in its sitemap into the ISR page cache (cache-handler.mjs) once it
 * starts, and again shortly after the cache is cleared (a publish or a settings change). Visitors then get cached
 * pages from the first request on. Requests go to this pod only (127.0.0.1), one or two at a time.
 * PAGE_WARMUP=false turns it off.
 */
const WARM_CONCURRENCY = 2;
const WARM_MAX_PAGES = 1000;
const WARM_DEBOUNCE_MS = 10_000;

type Fetcher = (path: string) => Promise<{ status: number; body: string }>;

function localFetcher(): Fetcher {
  const port = Number(process.env.PORT ?? 3000);
  return async (path) => {
    const http = await import("node:http");
    const { siteUrl } = await import("@/config/site");
    const host = new URL(siteUrl()).host;
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host, "user-agent": "jithendar-warmup" }, timeout: 30_000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (body.length < 5_000_000) body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
  };
}

/** Cached responses that are not in the sitemap but are fetched often (feed readers, the search box). */
const EXTRA_PATHS = ["/feed.xml", "/news/feed.xml", "/search-index.json"];

/** The paths to render: the home page, every <loc> in the sitemap (same host only), then the feeds and search index. */
export function sitemapPaths(xml: string, origin: string): string[] {
  const out = new Set<string>(["/"]);
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    try {
      const u = new URL(m[1]!.replace(/&amp;/g, "&"));
      if (u.origin === origin) out.add(u.pathname || "/");
    } catch {
      /* not a URL */
    }
  }
  for (const p of EXTRA_PATHS) out.add(p);
  return [...out].slice(0, WARM_MAX_PAGES);
}

export async function warmPages(fetcher: Fetcher = localFetcher()): Promise<{ pages: number; failed: number; ms: number }> {
  const started = Date.now();
  const { siteUrl } = await import("@/config/site");
  const sitemap = await fetcher("/sitemap.xml");
  if (sitemap.status !== 200) throw new Error(`sitemap answered ${sitemap.status}`);
  const paths = sitemapPaths(sitemap.body, new URL(siteUrl()).origin);
  let next = 0;
  let failed = 0;
  async function worker() {
    while (next < paths.length) {
      const path = paths[next++]!;
      const r = await fetcher(path).catch(() => ({ status: 0, body: "" }));
      if (r.status >= 500 || r.status === 0) failed++;
    }
  }
  await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker));
  return { pages: paths.length, failed, ms: Date.now() - started };
}

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function runWarmup(reason: string) {
  if (running) {
    again = true; // cleared again while warming: one more pass afterwards
    return;
  }
  const started = Date.now();
  running = warmPages()
    .then((r) => {
      log.info("pages warmed", { reason, ...r });
      recordPageWarmup(reason, "ok", r.ms / 1000, r.pages, r.failed);
    })
    .catch((err) => {
      log.warn("page warm-up failed", { reason, err });
      recordPageWarmup(reason, "failed", (Date.now() - started) / 1000);
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        scheduleWarmup("cleared during warm-up");
      }
    });
}

/** Debounced: a burst of edits leads to one warm-up. */
export function scheduleWarmup(reason: string, delayMs = WARM_DEBOUNCE_MS) {
  if (process.env.PAGE_WARMUP === "false") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    runWarmup(reason);
  }, delayMs);
  timer.unref?.();
}

/** Server start: wait until this pod answers, then render the site once. */
export async function startPageWarmup() {
  if (process.env.PAGE_WARMUP === "false") return;
  const { onPageCacheCleared } = await import("./page-cache");
  onPageCacheCleared(() => scheduleWarmup("cache cleared"));
  const fetcher = localFetcher();
  for (let i = 0; i < 60; i++) {
    const ok = await fetcher("/api/health").then((r) => r.status === 200, () => false);
    if (ok) return runWarmup("startup");
    await new Promise((r) => setTimeout(r, 1000));
  }
  log.warn("page warm-up skipped: the server did not answer within 60 s");
}
