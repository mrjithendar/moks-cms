import { isProductionEnv, siteFile } from "./site";
import type { SiteFile } from "./site-files";

/**
 * Third-party integrations, configured at runtime from environment variables (no rebuild needed).
 * Every value here is a *public identifier* that ends up in page HTML anyway (verification tokens,
 * GA4 measurement ID, AdSense publisher/slot IDs, the IndexNow key). Invalid values disable the
 * integration instead of being injected into pages. Nothing here is a secret.
 */
type Env = Record<string, string | undefined>;

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const valid = (re: RegExp, v: string | undefined) => (v && re.test(v.trim()) ? v.trim() : undefined);

/** EEA (EU + IS, LI, NO), United Kingdom and Switzerland: regions where Google requires consent before ad/analytics storage. */
export const CONSENT_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO", "GB", "CH",
] as const;

export type Integrations = {
  verification: { google: string[]; bing: string[] };
  /** GA4 measurement ID (G-…), only in production. */
  ga4: string | null;
  adsense: { client: string; slots: { articleEnd?: string; listing?: string }; test: boolean } | null;
  /** "regional": denied by default in CONSENT_REGIONS, granted elsewhere. "strict": denied everywhere until the visitor consents. */
  consentDefault: "regional" | "strict";
  indexNowKey: string | null;
  /** Google Reader Revenue Manager (swg-basic.js), only in production: Publisher Center's CTAs (rewarded ads, surveys, contributions…). */
  readerRevenue: { productId: string; lang: string } | null;
};

/**
 * The site's AdSense publisher ID (adsenseClientId in the site's site.json; matches the account's ads.txt line). Used when ADSENSE_CLIENT_ID is unset,
 * so Auto ads and AdSense site verification work without extra configuration. ADSENSE_CLIENT_ID=off disables ads.
 */
export const DEFAULT_ADSENSE_CLIENT_ID: string = siteFile.adsenseClientId;

/** A Reader Revenue Manager product ID as Publisher Center prints it: `<publication id>:<product>`, e.g. `CAowy6LIDA:openaccess`. */
export const READER_REVENUE_PRODUCT = /^[A-Za-z0-9_-]{4,64}:[A-Za-z0-9_.-]{1,64}$/;

export function integrations(
  env: Env = process.env,
  production = isProductionEnv(),
  file: Pick<SiteFile, "readerRevenue" | "language"> = siteFile,
): Integrations {
  const token = /^[A-Za-z0-9_-]{10,100}$/;
  const rawClient = env.ADSENSE_CLIENT_ID?.trim() || DEFAULT_ADSENSE_CLIENT_ID;
  const client = rawClient === "off" ? undefined : valid(/^ca-pub-\d{10,20}$/, rawClient);
  const slot = (v: string | undefined) => valid(/^\d{6,20}$/, v);
  return {
    verification: {
      google: list(env.GOOGLE_SITE_VERIFICATION).filter((t) => token.test(t)),
      bing: list(env.BING_SITE_VERIFICATION).filter((t) => token.test(t)),
    },
    ga4: production ? (valid(/^G-[A-Z0-9]{4,16}$/, env.GA4_MEASUREMENT_ID) ?? null) : null,
    // Outside production, ads are only shown as Google test ads (data-adtest="on"), and only when explicitly allowed.
    adsense: client && (production || env.ADSENSE_TEST_MODE === "true")
      ? { client, slots: { articleEnd: slot(env.ADSENSE_SLOT_ARTICLE_END), listing: slot(env.ADSENSE_SLOT_LISTING) }, test: !production }
      : null,
    consentDefault: env.CONSENT_DEFAULT === "strict" ? "strict" : "regional",
    indexNowKey: valid(/^[A-Za-z0-9-]{8,128}$/, env.INDEXNOW_KEY) ?? null,
    readerRevenue: production ? readerRevenue(env, file) : null,
  };
}

/** READER_REVENUE_PRODUCT_ID (Admin → Integrations), else readerRevenue.productId in site.json; "off" or invalid: none. */
function readerRevenue(env: Env, file: Pick<SiteFile, "readerRevenue" | "language">): Integrations["readerRevenue"] {
  const raw = env.READER_REVENUE_PRODUCT_ID?.trim() || file.readerRevenue?.productId?.trim();
  const productId = raw === "off" ? undefined : valid(READER_REVENUE_PRODUCT, raw);
  if (!productId) return null;
  const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
  return { productId, lang: valid(tag, file.readerRevenue?.lang) ?? valid(tag, file.language) ?? "en" };
}

/** The exact ads.txt text supplied by the AdSense account (ADS_TXT; "\n" separates lines). Never generated. */
export function adsTxt(env: Env = process.env): string | null {
  const raw = env.ADS_TXT?.replace(/\\n/g, "\n").trim();
  return raw ? `${raw}\n` : null;
}

/** Paths that never get analytics or ads: private, editorial, auth and preview routes. */
const PRIVATE = /^\/(admin|account|login|setup|preview|api)(\/|$)/;
export function isTrackablePath(pathname: string): boolean {
  return !PRIVATE.test(pathname);
}
