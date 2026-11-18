import { absoluteUrl } from "@/config/site";
import { AI_CRAWLERS, aiCrawlerAllowed, aiCrawlerPolicy, type AiCrawlerPolicy } from "./ai-crawlers";

/**
 * Production: everything crawlable except API endpoints (not pages). Other workloads' path routes (/argocd, /grafana,
 * /vault, …) are not listed: naming them here only advertised them, and Cloudflare Access now answers crawlers there
 * with a login redirect or 403 (miniKube istio/edge, cloudflare.access);
 * private pages are protected by login and carry noindex. Other hosts/environments: crawlable but
 * every response sends `X-Robots-Tag: noindex` (src/proxy.ts) — a Disallow would hide that noindex
 * from crawlers and could leave bare URLs indexed. No sitemap is advertised there.
 *
 * AI crawlers get one explicit group each (lib/seo/ai-crawlers.ts, policy from site.json `aiCrawlers`). A crawler
 * obeys only its own group when one names it, so an allowed crawler repeats the `*` rules.
 */
export function robotsTxt(indexable: boolean, policy: AiCrawlerPolicy = aiCrawlerPolicy()): string {
  if (!indexable) return "User-agent: *\nAllow: /\n";
  const ai = AI_CRAWLERS.flatMap((c) => [`User-agent: ${c.token}`, ...(aiCrawlerAllowed(c, policy) ? ["Allow: /", "Disallow: /api/"] : ["Disallow: /"]), ""]);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    `# AI crawlers: answer engines ${policy.search === "allow" ? "allowed" : "blocked"}, model training ${policy.training === "allow" ? "allowed" : "blocked"}.`,
    ...ai,
    `Sitemap: ${absoluteUrl("/sitemap.xml")}`,
    `Sitemap: ${absoluteUrl("/news-sitemap.xml")}`,
    "",
  ].join("\n");
}
