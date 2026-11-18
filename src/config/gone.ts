/**
 * URLs the site answers with 410 Gone, so search engines drop them (e.g. spam pages of an earlier install; never
 * redirect them to real content). The list is the site's config/gone.json, read at server start
 * (config/site-files.ts): a JSON array of paths without a trailing slash. The proxy normalizes before matching.
 */
import { readSiteJson } from "./site-files";

export const gonePaths: ReadonlySet<string> = new Set(readSiteJson<string[]>("config/gone.json", []));

export function isGone(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return gonePaths.has(normalized);
}
