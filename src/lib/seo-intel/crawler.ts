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
 * - a URL whose host is already an IP address never reaches that lookup (Node connects to it directly), so literal
 *   addresses are checked before the request, on every hop;
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

/**
 * The eight 16-bit groups of an IPv6 address, or null when it does not parse. A dotted IPv4 tail (::ffff:10.0.0.1) and
 * its hexadecimal spelling (::ffff:a00:1, which is what `URL` turns it into) give the same groups; zone ids are dropped.
 */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (tail4) {
    if (net.isIP(tail4) !== 4) return null;
    const n = v4ToInt(tail4);
    s = `${s.slice(0, -tail4.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  if (right && left.length + right.length > 7) return null;
  const groups = right ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** True when the address must never be fetched (non-public). */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (kind === 6) {
    const g = v6Groups(ip);
    if (!g) return true;
    const first = g[0]!;
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
    const embedded = (hi: number, lo: number) => isBlockedAddress(`${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`);
    if (zeros(7) && g[7]! <= 1) return true; // :: and ::1
    if (zeros(5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // IPv4-mapped, dotted or hexadecimal
    if (zeros(6)) return embedded(g[6]!, g[7]!); // IPv4-compatible (deprecated)
    if (first === 0x2002) return embedded(g[1]!, g[2]!); // 6to4 carries an IPv4 address
    if (first === 0x64 && g[1] === 0xff9b) return true; // NAT64
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (first === 0x2001 && g[1] === 0xdb8) return true; // documentation
    return false;
  }
  return true;
}

/**
 * True when the URL's host is itself an IP address that must not be fetched. Node skips the socket's `lookup` for
 * literal addresses, so guardedLookup below never sees them. `URL` has already normalised the spellings an address
 * can hide in (2130706433, 0x7f.1, 127.1 → 127.0.0.1); IPv6 hosts come in brackets.
 */
export function isBlockedLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return net.isIP(host) !== 0 && isBlockedAddress(host);
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

export type FetchResult = { url: string; finalUrl: string; status: number; headers: Record<string, string>; body: string; redirects: { from: string; to: string; status: number }[]; truncated: boolean; error?: string; /** Wall time for the whole fetch, redirects included (the real fetcher sets it). */ elapsedMs?: number };
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

/**
 * The real fetcher: allowlisted hosts only, guarded DNS, manual redirects. `headers` may override the User-Agent (the
 * technical audit's AI-crawler access check requests the home page as each AI crawler would).
 */
export function safeFetcher(origin: URL, opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }, headers: Record<string, string> = {}): PageFetcher {
  const hosts = allowedHosts(origin);
  return hostFetcher((h) => hosts.has(h), opts, ["http:", "https:"], headers);
}

/**
 * Broken-link checker (broken-links.ts): any public http(s) host. The private-address guard still runs on every hop
 * (DNS resolved inside the socket), so a link can't make the server reach internal services.
 */
export function publicFetcher(opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }): PageFetcher {
  return hostFetcher(() => true, opts);
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
  const hops = hopFetcher(allowed, opts, protocols, headers);
  return async (start: string) => {
    const t0 = performance.now();
    const r = await hops(start);
    return { ...r, elapsedMs: Math.round(performance.now() - t0) };
  };
}

function hopFetcher(allowed: (host: string) => boolean, opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }, protocols: string[], headers: Record<string, string>): PageFetcher {
  return async (start: string) => {
    const redirects: FetchResult["redirects"] = [];
    let current = new URL(start);
    for (let hop = 0; ; hop++) {
      if (!protocols.includes(current.protocol) || !allowed(current.hostname.toLowerCase().replace(/\.$/, "")) || current.username || current.password || (current.port && !["80", "443"].includes(current.port))) {
        return { url: start, finalUrl: current.href, status: 0, headers: {}, body: "", redirects, truncated: false, error: `Not fetched: ${current.hostname} is outside the allowlist.` };
      }
      if (isBlockedLiteral(current.hostname)) {
        return { url: start, finalUrl: current.href, status: 0, headers: {}, body: "", redirects, truncated: false, error: `Refusing to connect to a non-public address for ${current.hostname}.` };
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
