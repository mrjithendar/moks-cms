import { absoluteUrl } from "@/config/site";

/**
 * Production: everything crawlable except API endpoints (not pages). Other workloads' path routes (/argocd, /grafana,
 * /vault, …) are not listed: naming them here only advertised them, and Cloudflare Access now answers crawlers there
 * with a login redirect or 403 (miniKube istio/edge, cloudflare.access);
 * private pages are protected by login and carry noindex. Other hosts/environments: crawlable but
 * every response sends `X-Robots-Tag: noindex` (src/proxy.ts) — a Disallow would hide that noindex
 * from crawlers and could leave bare URLs indexed. No sitemap is advertised there.
 */
export function robotsTxt(indexable: boolean): string {
  if (!indexable) return "User-agent: *\nAllow: /\n";
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    `Sitemap: ${absoluteUrl("/sitemap.xml")}`,
    `Sitemap: ${absoluteUrl("/news-sitemap.xml")}`,
    "",
  ].join("\n");
}
