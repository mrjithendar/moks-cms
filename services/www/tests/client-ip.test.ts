import { describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER, CLOUDFLARE_RANGES, clientInfo, clientIp, gatewayAddress, ipBytes, ipInRanges, withClientIp } from "@/lib/client-ip";

const h = (o: Record<string, string>) => new Headers(o);
const VISITOR = "203.0.113.9";
const CF_EDGE = "172.70.10.5"; // inside 172.64.0.0/13
const cloudflare = { "cf-connecting-ip": VISITOR, "cf-ipcountry": "IN", "x-forwarded-for": `${VISITOR}, ${CF_EDGE}`, "x-envoy-external-address": CF_EDGE };

describe("addresses and ranges", () => {
  it.each(["1.2.3.4", "::", "::1", "2606:4700::1111", "::ffff:10.0.0.1", "::ffff:a00:1", "fe80::1"])("%s is an address", (ip) => expect(ipBytes(ip)).toHaveLength(16));
  it.each(["", "1.2.3", "256.1.1.1", "1.2.3.4.5", ":::", "1::2::3", "12345::", "fe80::1%eth0", "example.com", "1.2.3.4, 5.6.7.8"])("%j is not an address", (ip) => expect(ipBytes(ip)).toBeNull());

  it("matches IPv4 and IPv6 ranges on the bit, and IPv4-mapped IPv6 against IPv4 ranges", () => {
    expect(ipInRanges("172.63.255.255", CLOUDFLARE_RANGES)).toBe(false);
    expect(ipInRanges("172.64.0.0", CLOUDFLARE_RANGES)).toBe(true);
    expect(ipInRanges("172.71.255.255", CLOUDFLARE_RANGES)).toBe(true);
    expect(ipInRanges("172.72.0.0", CLOUDFLARE_RANGES)).toBe(false);
    expect(ipInRanges("2a06:98c7:ffff::1", CLOUDFLARE_RANGES)).toBe(true);
    expect(ipInRanges("2a06:98c8::1", CLOUDFLARE_RANGES)).toBe(false);
    expect(ipInRanges("::ffff:172.64.1.1", CLOUDFLARE_RANGES)).toBe(true);
    expect(ipInRanges("46.224.38.14", CLOUDFLARE_RANGES)).toBe(false);
    expect(ipInRanges("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipInRanges("10.1.2.3", ["not-a-range", "10.1.2.3"])).toBe(true);
  });

  it("every built-in Cloudflare range parses", () => {
    for (const r of CLOUDFLARE_RANGES) expect(ipInRanges(r.split("/")[0]!, [r]), r).toBe(true);
  });
});

describe("the gateway's address", () => {
  it("is Envoy's header, else the last X-Forwarded-For entry, never the first", () => {
    expect(gatewayAddress(h({ "x-envoy-external-address": "198.51.100.1", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("198.51.100.1");
    expect(gatewayAddress(h({ "x-forwarded-for": "1.1.1.1, 198.51.100.1" }))).toBe("198.51.100.1");
    expect(gatewayAddress(h({ "x-forwarded-for": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(gatewayAddress(h({ "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(gatewayAddress(h({ "x-forwarded-for": "1.1.1.1, not-an-address" }))).toBeNull();
    expect(gatewayAddress(h({}))).toBeNull();
  });
});

describe("clientInfo", () => {
  it("through Cloudflare: the visitor and country from Cloudflare's headers", () => {
    expect(clientInfo(h(cloudflare))).toEqual({ ip: VISITOR, country: "IN", edge: "cloudflare", verified: true });
    expect(clientInfo(h({ ...cloudflare, "x-envoy-external-address": "2606:4700:10::ac43:1" })).verified).toBe(true);
  });

  it("a forged left-most X-Forwarded-For entry changes nothing", () => {
    expect(clientIp(h({ ...cloudflare, "x-forwarded-for": `192.0.2.66, ${VISITOR}, ${CF_EDGE}` }))).toBe(VISITOR);
    expect(clientIp(h({ "x-forwarded-for": "192.0.2.66, 198.51.100.77" }))).toBe("198.51.100.77");
  });

  it("straight to the origin: Cloudflare headers from a non-Cloudflare address are ignored", () => {
    const direct = h({ "cf-connecting-ip": "8.8.8.8", "cf-ipcountry": "IN", "x-forwarded-for": "8.8.8.8, 198.51.100.77", "x-envoy-external-address": "198.51.100.77" });
    expect(clientInfo(direct)).toEqual({ ip: "198.51.100.77", country: null, edge: "gateway", verified: false });
  });

  it("a gateway that only sees a private address cannot check the sender: Cloudflare's headers are used, unverified", () => {
    expect(clientInfo(h({ "cf-connecting-ip": VISITOR, "cf-ipcountry": "us", "x-forwarded-for": `${VISITOR}, 192.168.49.1` }))).toEqual({ ip: VISITOR, country: "US", edge: "cloudflare", verified: false });
    expect(clientInfo(h({ "cf-connecting-ip": VISITOR })).ip).toBe(VISITOR);
  });

  it("TRUSTED_EDGE=gateway ignores Cloudflare's headers altogether", () => {
    expect(clientInfo(h(cloudflare), { TRUSTED_EDGE: "gateway" })).toEqual({ ip: CF_EDGE, country: null, edge: "gateway", verified: false });
  });

  it("CLOUDFLARE_IP_RANGES replaces the built-in list", () => {
    const env = { CLOUDFLARE_IP_RANGES: "198.51.100.0/24, 2001:db8::/32" };
    expect(clientInfo(h({ "cf-connecting-ip": VISITOR, "x-envoy-external-address": "198.51.100.77" }), env).verified).toBe(true);
    expect(clientInfo(h(cloudflare), env)).toMatchObject({ ip: CF_EDGE, edge: "gateway" });
  });

  it("unknown countries and junk give no country or address", () => {
    expect(clientInfo(h({ ...cloudflare, "cf-ipcountry": "XX" })).country).toBeNull();
    expect(clientInfo(h({ ...cloudflare, "cf-ipcountry": "T1" })).country).toBeNull();
    expect(clientInfo(h({ ...cloudflare, "cf-ipcountry": "India" })).country).toBeNull();
    expect(clientInfo(h({ "cf-connecting-ip": "not-an-address", "x-forwarded-for": "a, b" }))).toEqual({ ip: null, country: null, edge: "none", verified: false });
    expect(clientInfo(h({}))).toEqual({ ip: null, country: null, edge: "none", verified: false });
  });
});

describe("withClientIp (what Better Auth reads)", () => {
  it("sets the header from the decision and keeps the request intact", async () => {
    const req = new Request("https://jithendar.com/api/auth/sign-in/email", { method: "POST", headers: { ...cloudflare, "content-type": "application/json", [CLIENT_IP_HEADER]: "6.6.6.6" }, body: JSON.stringify({ email: "a@b.co" }) });
    const out = withClientIp(req);
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe(VISITOR);
    expect(out.method).toBe("POST");
    expect(out.url).toBe("https://jithendar.com/api/auth/sign-in/email");
    expect(await out.clone().json()).toEqual({ email: "a@b.co" });
    expect(await out.json()).toEqual({ email: "a@b.co" });
  });

  it("removes a header the client sent when no proxy reported an address", () => {
    expect(withClientIp(new Request("https://jithendar.com/api/auth/get-session", { headers: { [CLIENT_IP_HEADER]: "6.6.6.6" } })).headers.get(CLIENT_IP_HEADER)).toBeNull();
  });
});
