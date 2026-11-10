import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Fetching for the technical audit, safe against SSRF:
 * - only hosts on the allowlist (this site's canonical host and its www. variant);
 * - the address is checked inside the connection's own DNS lookup, so the IP that is validated is the IP that is
 *   connected to (no DNS-rebinding window); private, loopback, link-local, CGNAT, multicast and reserved ranges are
 *   refused (IPv4 and IPv6, including IPv4-mapped IPv6);
 * - redirects are followed manually (at most `maxRedirects`), each hop re-validated;
 * - connect/read timeout and a response-size cap; only http(s); a descriptive User-Agent;
 * - robots.txt is honoured by the caller (`robotsAllows`), and requests are spaced by the configured rate.
 */
export const USER_AGENT = "JithendarSEOAudit/1.0 (+https://jithendar.com; site owner's technical SEO audit)";

export class BlockedError extends Error {
  readonly code = "blocked";
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True when the address must never be fetched (non-public). */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith("2001:db8") || lower.startsWith("64:ff9b")) return true; // documentation, NAT64
    return false;
  }
  return true;
}

/** dns.lookup replacement used by the socket itself: resolves, then refuses any blocked address. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (!list.length || bad) return callback(Object.assign(new BlockedError(`Refusing to connect to a non-public address for ${hostname}.`), { code: "EBLOCKED" }), "", 4);
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

export type FetchResult = { url: string; finalUrl: string; status: number; headers: Record<string, string>; body: string; redirects: { from: string; to: string; status: number }[]; truncated: boolean; error?: string };
export type PageFetcher = (url: string) => Promise<FetchResult>;

export function allowedHosts(origin: URL): Set<string> {
  const h = origin.hostname.toLowerCase();
  return new Set([h, h.startsWith("www.") ? h.slice(4) : `www.${h}`]);
}

function once(url: URL, timeoutMs: number, maxBytes: number, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method: "GET", lookup: guardedLookup as never, headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8", ...extraHeaders }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          truncated = true;
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      const done = () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v ?? "")])), body: Buffer.concat(chunks).toString("utf8"), truncated });
      res.on("end", done);
      res.on("close", done);
      res.on("error", (e) => (truncated ? done() : reject(e)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** The real fetcher: allowlisted hosts only, guarded DNS, manual redirects. */
export function safeFetcher(origin: URL, opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }): PageFetcher {
  const hosts = allowedHosts(origin);
  return hostFetcher((h) => hosts.has(h), opts);
}

/**
 * v3: the same guarded fetcher for the editorial crew's documentation allowlist (https only; a domain or its
 * subdomains). Every hop, redirects included, is re-checked; DNS is resolved inside the socket and private ranges refused.
 */
export function docsFetcher(domains: string[], opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }): PageFetcher {
  const allow = domains.map((d) => d.toLowerCase().replace(/\.$/, ""));
  return hostFetcher((h) => allow.some((d) => h === d || h.endsWith(`.${d}`)), opts, ["https:"]);
}

/**
 * News desk: the same guarded fetcher for feed and primary-source hosts, with request headers (User-Agent identifying the
 * news desk, Accept for feeds, If-None-Match / If-Modified-Since for conditional GET). Headers are only ever these.
 */
export function headerFetcher(domains: string[], opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }, protocols = ["https:"]) {
  const allow = domains.map((d) => d.toLowerCase().replace(/\.$/, ""));
  return (url: string, headers: Record<string, string>) => hostFetcher((h) => allow.some((d) => h === d || h.endsWith(`.${d}`)), opts, protocols, headers)(url);
}

function hostFetcher(allowed: (host: string) => boolean, opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }, protocols = ["http:", "https:"], headers: Record<string, string> = {}): PageFetcher {
  return async (start: string) => {
    const redirects: FetchResult["redirects"] = [];
    let current = new URL(start);
    for (let hop = 0; ; hop++) {
      if (!protocols.includes(current.protocol) || !allowed(current.hostname.toLowerCase().replace(/\.$/, "")) || current.username || current.password || (current.port && !["80", "443"].includes(current.port))) {
        return { url: start, finalUrl: current.href, status: 0, headers: {}, body: "", redirects, truncated: false, error: `Not fetched: ${current.hostname} is outside the allowlist.` };
      }
      let res;
      try {
        res = await once(current, opts.timeoutMs, opts.maxBytes, headers);
      } catch (e) {
        return { url: start, finalUrl: current.href, status: 0, headers: {}, body: "", redirects, truncated: false, error: (e as { code?: string }).code === "EBLOCKED" ? (e as Error).message : `Request failed: ${(e as Error).message}`.slice(0, 200) };
      }
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= opts.maxRedirects) return { url: start, finalUrl: current.href, ...res, redirects, error: `More than ${opts.maxRedirects} redirects.` };
        const next = new URL(res.headers.location, current);
        redirects.push({ from: current.href, to: next.href, status: res.status });
        current = next;
        continue;
      }
      return { url: start, finalUrl: current.href, ...res, redirects };
    }
  };
}

// --- robots.txt ----------------------------------------------------------------------------------------------------

export type Robots = { groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[]; sitemaps: string[] };

export function parseRobots(text: string): Robots {
  const groups: Robots["groups"] = [];
  const sitemaps: string[] = [];
  let current: Robots["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "sitemap") sitemaps.push(value);
    else if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    } else if ((key === "allow" || key === "disallow") && current) current.rules.push({ allow: key === "allow", path: value });
    lastWasAgent = false;
  }
  return { groups, sitemaps };
}

const ruleMatches = (pattern: string, path: string) => {
  if (!pattern) return false;
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
  return re.test(path);
};

/** Google-style evaluation: the most specific (longest) matching rule wins; Allow wins ties. */
export function robotsAllows(r: Robots, path: string, agent = "jithendarseoaudit"): boolean {
  const group = r.groups.find((g) => g.agents.some((a) => a !== "*" && agent.startsWith(a))) ?? r.groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { allow: rule.allow, len };
  }
  return best ? best.allow : true;
}
