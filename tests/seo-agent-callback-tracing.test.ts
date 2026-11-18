import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { handleCallback, routeName } = await import("@/lib/seo-agent/internal-server");

/** Callback spans (docs/seo/OPERATIONS.md "Observability"): named by route, never by id, and traceparent is harmless. */
describe("seo-agent callback tracing", () => {
  it("names spans by route pattern, not by the ids in the URL", () => {
    expect(routeName(/^\/drafts\/([^/]+)\/save$/)).toBe("/drafts/:id/save");
    expect(routeName(/^\/calendar\/([^/]+)\/brief$/)).toBe("/calendar/:id/brief");
    expect(routeName(/^\/articles\/published$/)).toBe("/articles/published");
  });

  it("still answers when the agent sends a traceparent (and refuses a bad token before any span)", async () => {
    const CB = "c".repeat(40);
    const env = { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB };
    const tp = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    expect((await handleCallback("GET", "/internal/seo-agent/nope", `Bearer ${CB}`, undefined, env, tp)).status).toBe(404);
    expect((await handleCallback("POST", "/internal/seo-agent/articles/published", `Bearer ${CB}`, undefined, env, tp)).status).toBe(405);
    expect((await handleCallback("GET", "/internal/seo-agent/articles/published", "Bearer wrong", undefined, env, tp)).status).toBe(401);
  });
});
