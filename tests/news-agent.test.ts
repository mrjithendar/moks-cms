import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * The news desk's engine is its own service since 2026-11-21: the news agent (mrjithendar/newsroom). The web app finds
 * it (lib/news-agent/endpoint.ts), sends it the Newsroom's kick-offs (lib/news/agent.ts), routes the CrewAI console's
 * actions to the agent that owns each flow or crew (lib/crewai/agents.ts), and lets its callback token reach only the
 * news agent's routes (lib/seo-agent/internal-server.ts).
 */

const SEO_CB = "s".repeat(40);
const NEWS_CB = "n".repeat(40);
const ENV = { SEO_AGENT_CALLBACK_TOKEN: SEO_CB, NEWS_AGENT_CALLBACK_TOKEN: NEWS_CB };

describe("callback tokens", () => {
  it("the news agent's token reaches its own routes and nothing that drafts, publishes or reports", async () => {
    const { allowed, callerOf } = await import("@/lib/seo-agent/internal-server");
    expect(callerOf(`Bearer ${NEWS_CB}`, ENV)).toBe("news-agent");
    expect(callerOf(`Bearer ${SEO_CB}`, ENV)).toBe("seo-agent");
    expect(callerOf("Bearer nope", ENV)).toBeNull();
    for (const [m, p] of [["POST", "/news/fetch"], ["POST", "/news/drafts"], ["POST", "/news/drafts/abc/image"], ["POST", "/news/media"], ["POST", "/news/images/generate"], ["GET", "/news/site-signals"], ["POST", "/news/notify"], ["POST", "/news/performance"], ["GET", "/gsc/queries"], ["GET", "/skills"], ["GET", "/crew-configs"], ["GET", "/run-history/settings"]] as const)
      expect(allowed("news-agent", m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [["POST", "/drafts/abc/publish"], ["POST", "/drafts/abc/save"], ["POST", "/drafts/abc/status"], ["POST", "/reports/generate"], ["GET", "/articles/published"], ["POST", "/fetch-docs"], ["GET", "/news/fetch"]] as const)
      expect(allowed("news-agent", m, p), `${m} ${p}`).toBe(false);
  });

  it("the seo-agent's token no longer reaches the news desk's routes", async () => {
    const { allowed } = await import("@/lib/seo-agent/internal-server");
    expect(allowed("seo-agent", "POST", "/news/drafts")).toBe(false);
    expect(allowed("seo-agent", "POST", "/drafts/abc/publish")).toBe(true);
    expect(allowed("seo-agent", "GET", "/skills")).toBe(true);
  });

  it("a refused route answers 403 before any handler runs", async () => {
    const { handleCallback } = await import("@/lib/seo-agent/internal-server");
    const r = await handleCallback("POST", "/internal/seo-agent/drafts/11111111-1111-4111-8111-111111111111/publish", `Bearer ${NEWS_CB}`, {}, ENV);
    expect(r.status).toBe(403);
    expect((await handleCallback("POST", "/internal/seo-agent/news/notify", `Bearer ${SEO_CB}`, {}, ENV)).status).toBe(403);
    expect((await handleCallback("POST", "/internal/seo-agent/news/notify", "Bearer wrong", {}, ENV)).status).toBe(401);
  });

  it("the listener starts for the news agent alone, even with SEO_ORCHESTRATOR=legacy", async () => {
    const { listenPort } = await import("@/lib/seo-agent/internal-server");
    expect(listenPort({ NEWS_AGENT_CALLBACK_TOKEN: NEWS_CB, SEO_ORCHESTRATOR: "legacy" })).toBe(9465);
    expect(listenPort({ SEO_ORCHESTRATOR: "legacy" })).toBe(0);
    expect(listenPort({ SEO_AGENT_CALLBACK_PORT: "9500", NEWS_AGENT_CALLBACK_TOKEN: NEWS_CB })).toBe(9500);
  });
});

const health = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("finding the news agent", () => {
  it("NEWS_AGENT_URL, then the saved endpoint, then discovery; on only when it answers as the news agent", async () => {
    const { newsAgentStatus } = await import("@/lib/news-agent/endpoint");
    const ok = health({ status: "ok", version: "abc123", agent: "news" });
    const s = await newsAgentStatus({ env: { NEWS_AGENT_URL: "http://news.test:8080/", NEWS_AGENT_TOKEN: "t".repeat(40) }, fetchImpl: ok as unknown as typeof fetch, readAdminUrl: async () => "http://saved:8080" });
    expect(s).toMatchObject({ enabled: true, url: "http://news.test:8080", source: "env", version: "abc123" });
    const saved = await newsAgentStatus({ env: { NEWS_AGENT_TOKEN: "t".repeat(40) }, fetchImpl: ok as unknown as typeof fetch, readAdminUrl: async () => "http://saved:8080" });
    expect(saved).toMatchObject({ enabled: true, url: "http://saved:8080", source: "admin" });
    const found = await newsAgentStatus({ env: { NEWS_AGENT_TOKEN: "t".repeat(40), POD_NAMESPACE: "jithendar" }, fetchImpl: ok as unknown as typeof fetch, readAdminUrl: async () => null });
    expect(found).toMatchObject({ enabled: true, url: "http://news-agent:8080", source: "discovered" });
  });

  it("the seo-agent answering at the address is not the news agent; no token is not on", async () => {
    const { newsAgentStatus } = await import("@/lib/news-agent/endpoint");
    const seo = health({ status: "ok", version: "abc123" });
    const s = await newsAgentStatus({ env: { NEWS_AGENT_URL: "http://seo-agent:8080", NEWS_AGENT_TOKEN: "t".repeat(40) }, fetchImpl: seo as unknown as typeof fetch, readAdminUrl: async () => null });
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain("not as the news agent");
    const noToken = await newsAgentStatus({ env: { NEWS_AGENT_URL: "http://news:8080" }, fetchImpl: health({ status: "ok", version: "1", agent: "news" }) as unknown as typeof fetch, readAdminUrl: async () => null });
    expect(noToken).toMatchObject({ enabled: false });
    expect(noToken.reason).toContain("NEWS_AGENT_TOKEN");
    // POD_NAMESPACE set: discovery also tries the namespaced name (CI runs in a pod, so the namespace is always known there).
    const none = await newsAgentStatus({ env: { NEWS_AGENT_TOKEN: "t".repeat(40), POD_NAMESPACE: "jithendar" }, fetchImpl: health({}, 503) as unknown as typeof fetch, readAdminUrl: async () => null });
    expect(none).toMatchObject({ enabled: false, tried: ["http://news-agent:8080", "http://news-agent.jithendar.svc.cluster.local:8080"] });
  });
});

describe("kick-offs go to the news agent", () => {
  it("the Newsroom's Run now calls the news agent with its own token, never the seo-agent", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/healthz")) return new Response(JSON.stringify({ status: "ok", version: "1", agent: "news" }));
      calls.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ run_id: "r1", status: "queued", existing: false }), { status: 202 });
    });
    const { kickoff } = await import("@/lib/news-agent/client");
    const env = { NEWS_AGENT_URL: "http://news.test:8080", NEWS_AGENT_TOKEN: "k".repeat(40), SEO_AGENT_TOKEN: "seo".repeat(14), SEO_AGENT_URL: "http://seo.test:8080" };
    const r = await kickoff("news_job_flow", { job_id: "j" }, { actor: "admin" }, { env, fetchImpl: fetchImpl as unknown as typeof fetch, readAdminUrl: async () => null });
    expect(r.run_id).toBe("r1");
    expect(calls).toEqual([{ url: "http://news.test:8080/flows/news_job_flow/kickoff", auth: `Bearer ${"k".repeat(40)}` }]);
  });

  it("no news agent: a 503 that says where to set it up", async () => {
    const { kickoff, NEWS_AGENT_MISSING } = await import("@/lib/news-agent/client");
    await expect(kickoff("news_job_flow", {}, {}, { env: { NEWS_AGENT_TOKEN: "k".repeat(40) }, fetchImpl: health({}, 503) as unknown as typeof fetch, readAdminUrl: async () => null })).rejects.toMatchObject({ status: 503, message: NEWS_AGENT_MISSING });
    await expect(kickoff("news_job_flow", {}, {}, { env: {} })).rejects.toMatchObject({ status: 503 });
  });
});

describe("the CrewAI console routes each action to its agent", () => {
  it("news_* flows and the news crew's test runs go to the news agent; the rest to the seo-agent", async () => {
    const { agentOfCrew, agentOfFlow } = await import("@/lib/crewai/agents");
    expect(agentOfFlow("news_job_flow")).toBe("news");
    expect(agentOfFlow("news_dispatch_flow")).toBe("news");
    expect(agentOfFlow("gsc_sync_flow")).toBe("seo");
    expect(agentOfFlow("crew_test_flow", { crew: "news" })).toBe("news");
    expect(agentOfFlow("crew_test_flow", { crew: "editorial" })).toBe("seo");
    expect(agentOfFlow("crew_test_flow", null)).toBe("seo");
    expect(agentOfCrew("news")).toBe("news");
    expect(agentOfCrew("report")).toBe("seo");
  });
});
