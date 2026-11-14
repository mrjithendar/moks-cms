/**
 * URLs this site answers with 410 Gone, so search engines drop them (for example spam pages of an old install).
 * Paths are listed without a trailing slash; the proxy normalizes before matching.
 */
export const gonePaths: ReadonlySet<string> = new Set([]);

export function isGone(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return gonePaths.has(normalized);
}
