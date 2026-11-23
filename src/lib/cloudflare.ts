import "server-only";
import { siteUrl } from "@/config/site";
import { log } from "./log";
import { effectiveEnv } from "./runtime-settings";

/**
 * Cloudflare cache purging (Admin → Cache, the admin bar, and purge on publish in cdn-purge.ts).
 *
 * Credentials are Advanced settings (runtime-settings.ts, group "cloudflare"): the zone ID and an API token with
 * Zone → Cache Purge → Purge on that zone; the token is sealed at rest and never sent to the browser. Calls go only to
 * api.cloudflare.com. Cloudflare's own limits apply (https://developers.cloudflare.com/cache/how-to/purge-cache/):
 * at most 100 URLs, prefixes, hostnames or tags per request; on the Free plan purge everything / prefix / hostname / tag
 * requests are limited to a few a minute, URL purges are not. A refused request is reported with Cloudflare's message.
 */
const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
/** Cloudflare's per-request maximum for files, prefixes, hosts and tags. */
export const PURGE_BATCH = 100;

export type CloudflareConfig = { zoneId: string; token: string };
export type PurgeKind = "files" | "prefixes" | "hosts" | "tags";
export type PurgeRequest = { everything: true } | { kind: PurgeKind; items: string[] };
export type PurgeOutcome = { ok: true; requests: number; items: number } | { ok: false; error: string; status?: number; requests: number };

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function cloudflareConfig(env?: Record<string, string | undefined>): Promise<CloudflareConfig | null> {
  const e = env ?? (await effectiveEnv());
  const zoneId = e.CLOUDFLARE_ZONE_ID?.trim() ?? "";
  const token = e.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  return zoneId && token ? { zoneId, token } : null;
}

type ApiBody = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: unknown };

/** Cloudflare's message for a refused call, in words an admin can act on. Never contains the token. */
export function describeFailure(status: number, body: ApiBody | null): string {
  const first = body?.errors?.[0];
  const detail = first?.message ? `${first.message}${first.code ? ` (code ${first.code})` : ""}` : `HTTP ${status}`;
  if (status === 429 || first?.code === 1134) return `Cloudflare's purge limit was reached; try again in a minute. Cloudflare said: ${detail}`;
  if (first?.code === 1000)
    return `Cloudflare does not recognise this API token: it was rolled or deleted, or not all of it was saved (save an API token, not the Global API Key). Cloudflare said: ${detail}`;
  if (status === 401 || status === 403 || first?.code === 10000 || first?.code === 9109)
    return `Cloudflare refused the API token: it needs Zone → Cache Purge → Purge on this zone, and the zone ID must be the site's. Cloudflare said: ${detail}`;
  if (status === 404) return `Cloudflare does not know this zone ID. Check Advanced settings → Cloudflare. Cloudflare said: ${detail}`;
  return `Cloudflare refused the purge: ${detail}`;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function call(cfg: CloudflareConfig, method: "GET" | "POST", path: string, body?: unknown, fetcher: Fetcher = fetch): Promise<{ status: number; body: ApiBody | null }> {
  let res: Response;
  try {
    res = await fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new CloudflareError(`Cloudflare could not be reached (${(err as Error).name === "TimeoutError" ? "timed out" : "network error"}).`);
  }
  const parsed = (await res.json().catch(() => null)) as ApiBody | null;
  return { status: res.status, body: parsed };
}

/** Split into Cloudflare-sized requests, de-duplicated, in order. */
export function batches<T>(items: T[], size = PURGE_BATCH): T[][] {
  const unique = [...new Set(items)];
  const out: T[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

/** Purge from Cloudflare's cache. Stops at the first refused request and says why. Never throws. */
export async function purgeCloudflare(cfg: CloudflareConfig, req: PurgeRequest, fetcher?: Fetcher): Promise<PurgeOutcome> {
  const bodies = "everything" in req ? [{ purge_everything: true }] : batches(req.items).map((b) => ({ [req.kind]: b }));
  if (!bodies.length) return { ok: true, requests: 0, items: 0 };
  let requests = 0;
  try {
    for (const body of bodies) {
      requests++;
      const r = await call(cfg, "POST", `/zones/${encodeURIComponent(cfg.zoneId)}/purge_cache`, body, fetcher);
      if (r.status >= 400 || r.body?.success === false) return { ok: false, error: describeFailure(r.status, r.body), status: r.status, requests };
    }
  } catch (err) {
    log.warn("cloudflare purge failed", { event: "cloudflare_purge_failed", err });
    return { ok: false, error: err instanceof CloudflareError ? err.message : "Cloudflare could not be reached.", requests };
  }
  return { ok: true, requests, items: "everything" in req ? 0 : new Set(req.items).size };
}

export type ConnectionCheck = { ok: boolean; message: string; zone?: { name: string; plan: string | null; status: string | null } };

/** The address Test connection purges: the site never serves it, so nothing cached is dropped. */
export const PURGE_CHECK_PATH = "/__cloudflare-purge-check";

/**
 * Admin → Cache → Test connection: the one permission the site needs, a URL purge on this zone, tried on
 * PURGE_CHECK_PATH, then, when the token may read the zone (optional Zone → Zone → Read), which zone and plan it is.
 * Not GET /user/tokens/verify: Cloudflare answers it with 1000 "Invalid API Token" for account-owned tokens
 * (Manage account → Account API tokens, "cfat_…"), which purge fine.
 */
export async function checkCloudflare(cfg: CloudflareConfig, fetcher?: Fetcher): Promise<ConnectionCheck> {
  try {
    const origin = siteUrl();
    const p = await call(cfg, "POST", `/zones/${encodeURIComponent(cfg.zoneId)}/purge_cache`, { files: [new URL(PURGE_CHECK_PATH, origin).toString()] }, fetcher);
    if (p.status >= 400 || p.body?.success === false) return { ok: false, message: describeFailure(p.status, p.body) };
    const z = await call(cfg, "GET", `/zones/${encodeURIComponent(cfg.zoneId)}`, undefined, fetcher);
    const zone = z.body?.result as { name?: string; status?: string; plan?: { name?: string } } | undefined;
    if (z.status < 400 && zone?.name) {
      const host = new URL(origin).hostname;
      const matches = host === zone.name || host.endsWith(`.${zone.name}`);
      return {
        ok: matches,
        message: matches ? `Connected to zone ${zone.name}.` : `The token works, but zone ${zone.name} is not this site's (${host}).`,
        zone: { name: zone.name, plan: zone.plan?.name ?? null, status: zone.status ?? null },
      };
    }
    return { ok: true, message: "The API token can purge this zone. (Zone details need the optional Zone → Zone → Read permission; purging does not.)" };
  } catch (err) {
    return { ok: false, message: err instanceof CloudflareError ? err.message : "Cloudflare could not be reached." };
  }
}

/** Absolute URLs Cloudflare caches for these site paths ("/" stays "https://host/"). */
export function siteUrls(paths: Iterable<string>, origin = siteUrl()): string[] {
  const base = new URL(origin);
  return [...new Set([...paths].map((p) => new URL(p, base).toString()))];
}

/**
 * Admin → Cache → Custom purge: one entry per line, normalised for Cloudflare. URLs: a path ("/blog/x") or a full
 * URL. Prefixes: "host/path" without scheme (a path is put under the site's host). Hostnames: bare host names.
 * Tags: as sent in Cache-Tag. Returns the items and the lines that were not understood.
 */
export function parseCustomPurge(kind: PurgeKind, text: string, origin = siteUrl()): { items: string[]; invalid: string[] } {
  const host = new URL(origin).host;
  const items: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const add = (v: string | null) => (v ? items.push(v) : invalid.push(line.slice(0, 120)));
    if (kind === "files") {
      try {
        const u = line.startsWith("/") ? new URL(line, origin) : new URL(line);
        add(u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null);
      } catch {
        add(null);
      }
    } else if (kind === "prefixes") {
      const v = line.replace(/^https?:\/\//i, "");
      const withHost = v.startsWith("/") ? `${host}${v}` : v;
      add(/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\/[^\s?#]*$/i.test(withHost) ? withHost : /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(withHost) ? `${withHost}/` : null);
    } else if (kind === "hosts") {
      const v = line.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
      add(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null);
    } else {
      add(/^[\x21-\x7e]{1,1024}$/.test(line) ? line : null);
    }
  }
  return { items: [...new Set(items)], invalid };
}
