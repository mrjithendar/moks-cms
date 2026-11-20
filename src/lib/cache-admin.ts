import "server-only";
import { purgeablePath, type CacheAction } from "./admin-bar";
import { audit } from "./audit";
import { broadcastInvalidate, cacheBusStatus, KINDS } from "./cache-bus";
import { lastAutoPurge, purgePolicy } from "./cdn-purge";
import { checkCloudflare, cloudflareConfig, parseCustomPurge, purgeCloudflare, siteUrls, type PurgeKind, type PurgeOutcome } from "./cloudflare";
import { pageCacheStats, purgePages } from "./page-cache";
import { PostError, type Actor } from "./posts";
import { effectiveEnv } from "./runtime-settings";

/**
 * The admin's cache controls (admin bar → Cache, Admin → Cache): what each one clears, on every replica through the
 * cache bus (lib/cache-bus.ts), and at Cloudflare when a zone ID and API token are saved (lib/cloudflare.ts). Nothing
 * here is needed for correctness: every change made in the admin already clears what it affects (and purges
 * Cloudflare, lib/cdn-purge.ts). These are for "something changed elsewhere" and "show me a fresh copy now".
 *
 * Every action is admin-only (the read-only demo is refused before it gets here) and written to the audit log.
 * `ok: false` means the site's caches were cleared but Cloudflare refused or could not be reached.
 */
export type CacheResult = { ok: boolean; message: string };

export const PURGE_KINDS: { value: PurgeKind; label: string; hint: string }[] = [
  { value: "files", label: "URLs", hint: "One address per line: /blog/my-post or https://example.com/blog/my-post. Exactly as cached: a query string is part of the address." },
  { value: "prefixes", label: "Prefixes", hint: "Everything under a path, one per line: /blog/ or example.com/blog/. No query strings." },
  { value: "hosts", label: "Hostnames", hint: "Everything on a host name, one per line: example.com or www.example.com." },
  { value: "tags", label: "Cache tags", hint: "Responses sent with a matching Cache-Tag header, one tag per line." },
];

function cloudflareText(outcome: PurgeOutcome, what: string): string {
  return outcome.ok ? `Cloudflare: purged ${what}.` : `Cloudflare: ${outcome.error}`;
}

async function cloudflare(actor: Actor, label: string, run: (cfg: NonNullable<Awaited<ReturnType<typeof cloudflareConfig>>>) => Promise<PurgeOutcome>): Promise<PurgeOutcome | null> {
  const cfg = await cloudflareConfig();
  if (!cfg) return null;
  const outcome = await run(cfg);
  await audit(actor, "cache.cloudflare.purge", label, outcome.ok ? { requests: outcome.requests } : { error: outcome.error, status: outcome.status });
  return outcome;
}

export async function runCacheAction(actor: Actor, action: CacheAction, input: { path?: unknown; kind?: unknown; items?: unknown } = {}): Promise<CacheResult> {
  if (actor.role !== "admin") throw new PostError("Only admins can clear caches.", 403);
  switch (action) {
    case "purge-page": {
      const path = purgeablePath(input.path);
      if (!path || /^\/(admin|api)(\/|$)/.test(path)) throw new PostError("Choose a public page of this site (an address starting with /).", 400);
      purgePages(path);
      await audit(actor, "cache.purge.page", path);
      const local = `${path} was removed from the page cache on every server. The next visit renders it again.`;
      const [url] = siteUrls([path]);
      const cf = await cloudflare(actor, url!, (cfg) => purgeCloudflare(cfg, { kind: "files", items: [url!] }));
      return cf ? { ok: cf.ok, message: `${local} ${cloudflareText(cf, url!)}` } : { ok: true, message: local };
    }
    case "clear-pages":
      purgePages(null);
      await audit(actor, "cache.clear.pages");
      return { ok: true, message: "The page cache was cleared on every server. Pages are rendered again within seconds." };
    case "clear-data":
      for (const kind of KINDS) broadcastInvalidate(kind);
      await audit(actor, "cache.clear.data");
      return { ok: true, message: "Content, settings, menus and integrations were reloaded on every server, and the page cache was cleared." };
    case "purge-all": {
      for (const kind of KINDS) broadcastInvalidate(kind);
      purgePages(null);
      await audit(actor, "cache.purge.all");
      const local = "Every cache on every server was cleared. Pages are rendered again within seconds.";
      const cf = await cloudflare(actor, "everything", (cfg) => purgeCloudflare(cfg, { everything: true }));
      return cf ? { ok: cf.ok, message: `${local} ${cloudflareText(cf, "everything")}` } : { ok: true, message: local };
    }
    case "cf-everything": {
      const cf = await cloudflare(actor, "everything", (cfg) => purgeCloudflare(cfg, { everything: true }));
      if (!cf) throw new PostError("Cloudflare is not set up: save a zone ID and API token in Admin → Cache → Cloudflare settings.", 400);
      return { ok: cf.ok, message: cf.ok ? "Cloudflare: purged everything. Pages are fetched from the site again on their next visit." : cloudflareText(cf, "") };
    }
    case "cf-custom": {
      const kind = String(input.kind ?? "") as PurgeKind;
      if (!PURGE_KINDS.some((k) => k.value === kind)) throw new PostError("Choose what to purge by: URLs, prefixes, hostnames or cache tags.", 400);
      const text = typeof input.items === "string" ? input.items.slice(0, 200_000) : "";
      const { items, invalid } = parseCustomPurge(kind, text);
      if (invalid.length) throw new PostError(`Not understood (one per line): ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? ` and ${invalid.length - 5} more` : ""}.`, 400);
      if (!items.length) throw new PostError("Enter at least one line to purge.", 400);
      const label = `${items.length} ${PURGE_KINDS.find((k) => k.value === kind)!.label.toLowerCase()}`;
      const cf = await cloudflare(actor, label, (cfg) => purgeCloudflare(cfg, { kind, items }));
      if (!cf) throw new PostError("Cloudflare is not set up: save a zone ID and API token in Admin → Cache → Cloudflare settings.", 400);
      return { ok: cf.ok, message: cloudflareText(cf, label) };
    }
    case "cf-test": {
      const cfg = await cloudflareConfig();
      if (!cfg) throw new PostError("Cloudflare is not set up: save a zone ID and API token in Admin → Cache → Cloudflare settings.", 400);
      const check = await checkCloudflare(cfg);
      await audit(actor, "cache.cloudflare.test", check.zone?.name, { ok: check.ok });
      return { ok: check.ok, message: `${check.message}${check.zone?.plan ? ` Plan: ${check.zone.plan}.` : ""}` };
    }
  }
}

/** What Admin → Cache shows about the server that answered (each server has its own page cache) and Cloudflare. */
export async function cacheStatus() {
  const stats = pageCacheStats();
  const lookups = stats.hits + stats.misses;
  const env = await effectiveEnv();
  const cfg = await cloudflareConfig(env);
  return {
    pod: (process.env.HOSTNAME ?? "local").slice(0, 63),
    pages: stats.entries,
    bytes: stats.bytes,
    maxBytes: Math.max(1, Number(process.env.PAGE_CACHE_MAX_MB || 64)) * 1024 * 1024,
    hitRate: lookups ? stats.hits / lookups : null,
    lookups,
    clears: stats.generation,
    bus: cacheBusStatus(),
    cloudflare: { configured: Boolean(cfg), zoneId: cfg?.zoneId ?? null, policy: purgePolicy(env), last: lastAutoPurge() },
  };
}
