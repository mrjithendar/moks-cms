import { siteUrl } from "@/config/site";

/**
 * rel for links in article, page and news bodies (owner decision 2026-11-10): every external link is `nofollow`, so
 * the site never passes ranking credit to another site, and `noopener` so the target can't script this tab. Links to
 * this site (relative, #fragment, or absolute to the apex / www host) are internal and keep normal rel. Any rel the
 * markup already carries (e.g. "sponsored") is kept.
 */
export const EXTERNAL_REL = ["nofollow", "noopener"] as const;

export function isExternalHref(href: string, origin = siteUrl()): boolean {
  const h = href.trim();
  if (!h || h.startsWith("#") || (h.startsWith("/") && !h.startsWith("//"))) return false;
  if (/^(mailto|tel):/i.test(h)) return false;
  let url: URL;
  try {
    url = new URL(h.startsWith("//") ? `https:${h}` : h);
  } catch {
    return false; // relative paths like ./x or ../x stay on this site
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const own = new URL(origin).hostname.replace(/^www\./, "");
  return url.hostname.replace(/^www\./, "") !== own;
}

/** The rel for `href`: undefined for internal links, otherwise the existing tokens plus nofollow and noopener. */
export function linkRel(href: string, existing?: string | null, origin = siteUrl()): string | undefined {
  if (!isExternalHref(href, origin)) return existing ?? undefined;
  const tokens = new Set((existing ?? "").split(/\s+/).filter(Boolean).map((t) => t.toLowerCase()));
  for (const t of EXTERNAL_REL) tokens.add(t);
  return [...tokens].join(" ");
}
