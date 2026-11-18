import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db } from "@/db";
import { freshDb } from "./db-helpers";

const ep = await import("@/lib/seo-agent/endpoint");
const { agentBaseUrl, agentStatus, clearAgentCache, mcpEnabled, normalizeEndpoint, orchestrator, probeAgent, readAdminEndpoint, saveAdminEndpoint } = ep;

/**
 * Finding the SEO agent (src/lib/seo-agent/endpoint.ts): SEO_AGENT_URL, else the admin's endpoint, else discovery at
 * http://seo-agent:8080; on only when that answers /healthz as the agent and SEO_AGENT_TOKEN is set; SEO_ORCHESTRATOR
 * forces either way.
 */
const TOKEN = { SEO_AGENT_TOKEN: "t".repeat(40) };
const healthy = (version = "1.2.3") => Response.json({ status: "ok", version });

/** A network where only `up` (base URLs) answer as the agent; records every URL asked. */
function network(up: string[], other: Record<string, Response> = {}) {
  const asked: string[] = [];
  const fetchImpl = (async (u: string | URL) => {
    const url = String(u);
    asked.push(url);
    const base = url.replace(/\/healthz$/, "");
    if (other[base]) return other[base]!.clone();
    if (up.includes(base)) return healthy();
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}
const noAdmin = async () => null;

describe("normalizeEndpoint", () => {
  it("keeps scheme, host, port and path prefix; drops a trailing slash", () => {
    expect(normalizeEndpoint(" http://seo-agent.other:8080/ ")).toBe("http://seo-agent.other:8080");
    expect(normalizeEndpoint("https://agent.example.com/seo/")).toBe("https://agent.example.com/seo");
  });
  it.each([
    ["", "Enter"],
    ["seo-agent:8080", "http"],
    ["ftp://agent:8080", "http"],
    ["http://user:pw@agent:8080", "passwords"],
    ["http://agent:8080/?x=1", "query"],
    ["not a url", "valid"],
  ])("refuses %j", (raw, msg) => {
    expect(() => normalizeEndpoint(raw)).toThrow(new RegExp(msg));
  });
});

describe("probeAgent", () => {
  it("accepts only the agent's /healthz shape", async () => {
    expect(await probeAgent("http://a", network(["http://a"]).fetchImpl)).toEqual({ ok: true, version: "1.2.3" });
    expect(await probeAgent("http://a", network([], { "http://a": Response.json({ ok: true }) }).fetchImpl)).toMatchObject({ ok: false });
    expect(await probeAgent("http://a", network([], { "http://a": new Response("nope", { status: 500 }) }).fetchImpl)).toEqual({ ok: false, error: "HTTP 500" });
    expect(await probeAgent("http://a", network([]).fetchImpl)).toEqual({ ok: false, error: "unreachable" });
  });
});

describe("agentStatus", () => {
  it("discovers http://seo-agent:8080 and turns the agent on", async () => {
    const n = network(["http://seo-agent:8080"]);
    const s = await agentStatus({ env: { ...TOKEN }, fetchImpl: n.fetchImpl, readAdminUrl: noAdmin });
    expect(s).toMatchObject({ enabled: true, mode: "auto", url: "http://seo-agent:8080", source: "discovered", version: "1.2.3" });
    expect(await orchestrator({ env: { ...TOKEN }, fetchImpl: n.fetchImpl, readAdminUrl: noAdmin })).toBe("crewai");
  });

  it("also tries the namespaced Service when the namespace is known", async () => {
    const n = network(["http://seo-agent.shop.svc.cluster.local:8080"]);
    const s = await agentStatus({ env: { ...TOKEN, POD_NAMESPACE: "shop" }, fetchImpl: n.fetchImpl, readAdminUrl: noAdmin });
    expect(s).toMatchObject({ enabled: true, url: "http://seo-agent.shop.svc.cluster.local:8080", tried: ["http://seo-agent:8080", "http://seo-agent.shop.svc.cluster.local:8080"] });
  });

  it("nothing found: disabled, the legacy path, and no MCP", async () => {
    const n = network([]);
    const deps = { env: { ...TOKEN, PUBLIC_MCP_ENABLED: "true" }, fetchImpl: n.fetchImpl, readAdminUrl: noAdmin };
    const s = await agentStatus(deps);
    expect(s).toMatchObject({ enabled: false, mode: "auto", url: null, source: null });
    expect(s.reason).toMatch(/no SEO agent found/);
    expect(await orchestrator(deps)).toBe("legacy");
    expect(await mcpEnabled("public", deps)).toBe(false);
    expect(await agentBaseUrl(deps)).toBeNull();
  });

  it("the admin's endpoint replaces discovery; one that does not answer leaves the agent disabled", async () => {
    const up = network(["http://agent.elsewhere:9000"]);
    const s = await agentStatus({ env: { ...TOKEN }, fetchImpl: up.fetchImpl, readAdminUrl: async () => "http://agent.elsewhere:9000" });
    expect(s).toMatchObject({ enabled: true, source: "admin", url: "http://agent.elsewhere:9000", adminUrl: "http://agent.elsewhere:9000", tried: [] });
    expect(up.asked).toEqual(["http://agent.elsewhere:9000/healthz"]);
    const down = await agentStatus({ env: { ...TOKEN }, fetchImpl: network(["http://seo-agent:8080"]).fetchImpl, readAdminUrl: async () => "http://agent.elsewhere:9000" });
    expect(down).toMatchObject({ enabled: false, source: "admin", url: "http://agent.elsewhere:9000" });
  });

  it("SEO_AGENT_URL wins over the admin's endpoint, and calls use it without a probe", async () => {
    const n = network(["http://from-env:8080"]);
    const env = { ...TOKEN, SEO_AGENT_URL: "http://from-env:8080/" };
    expect(await agentStatus({ env, fetchImpl: n.fetchImpl, readAdminUrl: async () => "http://admin:8080" })).toMatchObject({ enabled: true, source: "env", adminUrl: null, envUrl: "http://from-env:8080" });
    const quiet = network([]);
    expect(await agentBaseUrl({ env, fetchImpl: quiet.fetchImpl })).toBe("http://from-env:8080");
    expect(quiet.asked).toEqual([]);
  });

  it("an agent without SEO_AGENT_TOKEN stays disabled", async () => {
    const s = await agentStatus({ env: {}, fetchImpl: network(["http://seo-agent:8080"]).fetchImpl, readAdminUrl: noAdmin });
    expect(s).toMatchObject({ enabled: false, url: "http://seo-agent:8080" });
    expect(s.reason).toMatch(/SEO_AGENT_TOKEN/);
  });

  it("SEO_ORCHESTRATOR forces either way without probing", async () => {
    const n = network(["http://seo-agent:8080"]);
    expect(await agentStatus({ env: { ...TOKEN, SEO_ORCHESTRATOR: "legacy" }, fetchImpl: n.fetchImpl, readAdminUrl: noAdmin })).toMatchObject({ enabled: false, mode: "forced off" });
    expect(await agentStatus({ env: { ...TOKEN, SEO_ORCHESTRATOR: "crewai" }, fetchImpl: n.fetchImpl, readAdminUrl: noAdmin })).toMatchObject({ enabled: true, mode: "forced on", url: "http://seo-agent:8080" });
    expect(n.asked).toEqual([]);
    expect(await agentBaseUrl({ env: { ...TOKEN, SEO_ORCHESTRATOR: "legacy", SEO_AGENT_URL: "http://x:1" } })).toBeNull();
  });

  it("does not probe while Next builds", async () => {
    const n = network(["http://seo-agent:8080"]);
    expect(await agentStatus({ env: { ...TOKEN, NEXT_PHASE: "phase-production-build" }, fetchImpl: n.fetchImpl, readAdminUrl: noAdmin })).toMatchObject({ enabled: false });
    expect(n.asked).toEqual([]);
  });
});

describe("the admin's endpoint", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    void db;
    clearAgentCache();
  });
  afterEach(() => clearAgentCache());

  it("is saved normalized, read back, and removed with null", async () => {
    expect(await readAdminEndpoint()).toBeNull();
    expect(await saveAdminEndpoint("http://seo-agent.other:8080/", "admin")).toEqual({ before: null, after: "http://seo-agent.other:8080" });
    expect(await readAdminEndpoint()).toBe("http://seo-agent.other:8080");
    expect(await saveAdminEndpoint(null, "admin")).toEqual({ before: "http://seo-agent.other:8080", after: null });
    expect(await readAdminEndpoint()).toBeNull();
    await expect(saveAdminEndpoint("ftp://x", "admin")).rejects.toThrow(/http/);
  });

  it("the process caches the answer; saving an endpoint or `fresh` checks again", async () => {
    vi.stubEnv("SEO_ORCHESTRATOR", "");
    vi.stubEnv("SEO_AGENT_URL", "");
    vi.stubEnv("SEO_AGENT_TOKEN", "t".repeat(40));
    const n = network(["http://agent.saved:8080"]);
    vi.stubGlobal("fetch", n.fetchImpl);
    try {
      expect((await agentStatus()).enabled).toBe(false); // discovery: nothing at http://seo-agent:8080
      const probes = n.asked.length;
      expect((await agentStatus()).enabled).toBe(false);
      expect(n.asked.length).toBe(probes); // cached
      await saveAdminEndpoint("http://agent.saved:8080", "admin"); // clears the cache
      expect(await agentStatus()).toMatchObject({ enabled: true, source: "admin", url: "http://agent.saved:8080" });
      expect(await agentBaseUrl()).toBe("http://agent.saved:8080");
      const before = n.asked.length;
      await agentStatus({}, { fresh: true });
      expect(n.asked.length).toBe(before + 1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
