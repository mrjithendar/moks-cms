/**
 * The site's permanent redirects (308), answered by the proxy (src/proxy.ts). The map is the site's
 * config/redirects.json, read at server start (config/site-files.ts): a JSON array of {"source", "destination"},
 * both site-relative paths. Every source must resolve in one hop: a destination may never be another source.
 */
import { readSiteJson } from "./site-files";

export type Redirect = { source: string; destination: string };

export const redirects: Redirect[] = readSiteJson<Redirect[]>("config/redirects.json", []);

const bySource = new Map(redirects.map((r) => [r.source.length > 1 ? r.source.replace(/\/+$/, "") : r.source, r.destination]));

/** The destination for a path (trailing slashes ignored), or undefined. */
export function redirectFor(pathname: string): string | undefined {
  return bySource.get(pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);
}
