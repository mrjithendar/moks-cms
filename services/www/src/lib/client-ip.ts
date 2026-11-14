/**
 * Who is on the other end of a request. Every rate limit, audit entry and the paid-call currency depend on this, so
 * it is decided in one place, from the headers of the proxies we actually run behind:
 *
 *   visitor → Cloudflare (proxy) → Istio ingress gateway (Envoy) → pod
 *
 * - The gateway reports the address that connected to it in `x-envoy-external-address`, and appends the same address
 *   to `X-Forwarded-For`. Everything to the left of that last entry was sent by the client and can be forged, so the
 *   left-most entry is never used.
 * - Behind Cloudflare that address is a Cloudflare edge server, and the visitor is in `CF-Connecting-IP` (country in
 *   `CF-IPCountry`). Cloudflare overwrites both on every request it proxies, but anyone who reaches the origin
 *   directly can send them too. They are therefore used only when the gateway's address is one of Cloudflare's, or
 *   when the gateway cannot see the sender at all (a private address: the cluster's network translates it). In that
 *   second case the origin must only accept Cloudflare's ranges (docs/DEPLOYMENT.md "Client addresses").
 *
 * TRUSTED_EDGE=cloudflare (default) or `gateway` (no Cloudflare proxy in front: Cloudflare's headers are ignored).
 * CLOUDFLARE_IP_RANGES replaces the built-in list (comma-separated CIDRs) if Cloudflare ever changes it.
 *
 * Pure and dependency-free: the proxy (src/proxy.ts) and the server both import it.
 */
type Env = Record<string, string | undefined>;
export type HeaderBag = { get(name: string): string | null };
export type ClientInfo = {
  /** The visitor's address, or null when no proxy told us (local development). */
  ip: string | null;
  /** Two-letter country from the edge, only when the edge's headers were used. */
  country: string | null;
  edge: "cloudflare" | "gateway" | "none";
  /** True when the request demonstrably came from the edge (the gateway saw one of its addresses). */
  verified: boolean;
};

/** Request header the auth route sets for Better Auth, which can only read an address from a header. */
export const CLIENT_IP_HEADER = "x-client-ip";

/** https://www.cloudflare.com/ips/ (last changed 2023-09-28). */
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

/** Addresses that are never a visitor's: loopback, private, link-local and carrier-grade NAT. */
const NOT_PUBLIC = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "::/127", "fc00::/7", "fe80::/10"];

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The 16 bytes of an address (IPv4 as ::ffff:a.b.c.d), or null when `ip` is not an IP address. */
export function ipBytes(ip: string): number[] | null {
  if (V4.test(ip)) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...ip.split(".").map(Number)];
  let s = ip.toLowerCase();
  if (!s.includes(":") || s.length > 45 || !/^[0-9a-f:.]+$/.test(s)) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (tail) {
    if (!V4.test(tail)) return null;
    const b = tail.split(".").map(Number);
    s = `${s.slice(0, -tail.length)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  if (right && left.length + right.length > 7) return null;
  const groups = right ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
}

type Range = { bytes: number[]; bits: number };

function parseRange(cidr: string): Range | null {
  const [addr = "", len] = cidr.trim().split("/");
  const bytes = ipBytes(addr);
  if (!bytes) return null;
  const v4 = V4.test(addr);
  const max = v4 ? 32 : 128;
  const n = len === undefined ? max : Number(len);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return { bytes, bits: v4 ? n + 96 : n };
}

const parsed = new Map<string, Range[]>();
function rangesOf(list: readonly string[]): Range[] {
  const key = list.join(",");
  let out = parsed.get(key);
  if (!out) {
    out = list.map(parseRange).filter((r): r is Range => r !== null);
    if (parsed.size > 8) parsed.clear();
    parsed.set(key, out);
  }
  return out;
}

function within(ip: number[], ranges: Range[]): boolean {
  return ranges.some((r) => {
    const whole = r.bits >> 3;
    for (let i = 0; i < whole; i++) if (ip[i] !== r.bytes[i]) return false;
    const rest = r.bits & 7;
    if (rest === 0) return true;
    const mask = (0xff << (8 - rest)) & 0xff;
    return (ip[whole]! & mask) === (r.bytes[whole]! & mask);
  });
}

/** True when `ip` is inside one of the CIDR ranges (IPv4 and IPv6; an IPv4-mapped IPv6 address matches IPv4 ranges). */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  const bytes = ipBytes(ip.trim());
  return bytes !== null && within(bytes, rangesOf(ranges));
}

function cloudflareRanges(env: Env): readonly string[] {
  const own = (env.CLOUDFLARE_IP_RANGES ?? "").split(/[\s,]+/).filter(Boolean);
  return own.length ? own : CLOUDFLARE_RANGES;
}

const address = (value: string | null | undefined): string | null => {
  const v = value?.trim().toLowerCase() ?? "";
  return v && v.length <= 45 && ipBytes(v) ? v : null;
};

/** What the Istio gateway says connected to it: its own header, else the entry it appended to X-Forwarded-For. */
export function gatewayAddress(h: HeaderBag): string | null {
  const hops = (h.get("x-forwarded-for") ?? "").split(",");
  return address(h.get("x-envoy-external-address")) ?? address(hops.at(-1)) ?? address(h.get("x-real-ip"));
}

export function trustedEdge(env: Env = process.env): "cloudflare" | "gateway" {
  return env.TRUSTED_EDGE?.trim().toLowerCase() === "gateway" ? "gateway" : "cloudflare";
}

export function clientInfo(h: HeaderBag, env: Env = process.env): ClientInfo {
  const peer = gatewayAddress(h);
  if (trustedEdge(env) === "cloudflare") {
    const visitor = address(h.get("cf-connecting-ip"));
    if (visitor) {
      const verified = peer !== null && ipInRanges(peer, cloudflareRanges(env));
      // A public address that is not Cloudflare's reached the origin directly: its Cloudflare headers are its own.
      if (verified || peer === null || ipInRanges(peer, NOT_PUBLIC)) {
        const c = h.get("cf-ipcountry")?.trim().toUpperCase() ?? "";
        return { ip: visitor, country: /^[A-Z]{2}$/.test(c) && c !== "XX" ? c : null, edge: "cloudflare", verified };
      }
    }
  }
  return { ip: peer, country: null, edge: peer ? "gateway" : "none", verified: false };
}

export const clientIp = (h: HeaderBag, env: Env = process.env): string | null => clientInfo(h, env).ip;

/**
 * The same request with `x-client-ip` set to the address decided above (and any value the client sent removed).
 * Better Auth reads its rate-limit key and the session's address from that one header (lib/auth.ts).
 */
export function withClientIp(request: Request, env: Env = process.env): Request {
  const headers = new Headers(request.headers);
  const ip = clientIp(headers, env);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  else headers.delete(CLIENT_IP_HEADER);
  return new Request(request, { headers });
}
