/**
 * Site identity and environment. Server-only values; never prefix these with NEXT_PUBLIC_.
 *
 * The identity comes from sites/<SITE>/site.json, which `npm run site` links to site/ (scripts/use-site.mjs).
 */
import siteJson from "../../site/site.json";

export const PRODUCTION_HOST: string = siteJson.host;

export const site = {
  name: siteJson.name,
  // TODO(owner): confirm the publication name for Google News and JSON-LD.
  publicationName: siteJson.publicationName,
  description: siteJson.description,
  language: siteJson.language,
  locale: siteJson.locale,
  timeZone: siteJson.timeZone,
  primaryAuthor: siteJson.primaryAuthor,
} as const;

/** The whole site descriptor (sites/<SITE>/site.json): defaults for Admin → Settings and the AdSense ID too. */
export const siteFile = siteJson;

export function siteUrl(): string {
  const url = process.env.SITE_URL ?? `https://${PRODUCTION_HOST}`;
  return url.replace(/\/+$/, "");
}

export function absoluteUrl(path: string): string {
  if (path === "/" || path === "") return siteUrl();
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Build-time/runtime environment flag. Anything other than production is never indexable. */
export function isProductionEnv(): boolean {
  return process.env.APP_ENV === "production" || process.env.VERCEL_ENV === "production";
}

/**
 * Local preview of unpublished work: `CONTENT_PREVIEW=true npm run dev`.
 * Ignored whenever APP_ENV is production, so it can never leak drafts to the live site.
 */
export function isContentPreview(): boolean {
  return process.env.CONTENT_PREVIEW === "true" && !isProductionEnv();
}

/** Request-time check: production environment *and* served on the canonical host. */
export function isIndexableHost(host: string | null | undefined): boolean {
  if (!isProductionEnv() || !host) return false;
  return host.toLowerCase().replace(/:\d+$/, "") === PRODUCTION_HOST;
}
