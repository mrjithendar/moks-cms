import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { AgentError, lanceBrowse, lanceDelete, lanceRow, lanceUpdate } = await import("@/lib/seo-agent/client");

const env = { SEO_AGENT_URL: "http://agent:8080/", SEO_AGENT_TOKEN: "t".repeat(40) };

function fake(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, deps: { fetchImpl, env } };
}

describe("LanceDB client (/admin/lancedb → seo-agent)", () => {
  it("pages a table with the bearer token", async () => {
    const f = fake(200, { rows: [] });
    await lanceBrowse("crew memory", 25, 25, f.deps);
    expect(f.calls[0]!.url).toBe("http://agent:8080/lancedb/tables/crew%20memory?offset=25&limit=25");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(40)}`);
  });

  it("sends one-row edits and deletes in the agent's shape", async () => {
    const f = fake(200, { updated: 1, version: 4 });
    await lanceUpdate("articles", { keyColumn: "id", key: "a", actor: "admin@example.com" }, { title: "New", views: 3, note: null }, f.deps);
    await lanceDelete("articles", { keyColumn: "id", key: 7 }, f.deps);
    await lanceRow("articles", { keyColumn: "id", key: "a", actor: "ignored" }, f.deps);
    expect(f.calls.map((c) => [c.init.method, c.url.replace("http://agent:8080", ""), JSON.parse(String(c.init.body))])).toEqual([
      ["POST", "/lancedb/tables/articles/update", { key_column: "id", key: "a", actor: "admin@example.com", values: { title: "New", views: 3, note: null } }],
      ["POST", "/lancedb/tables/articles/delete", { key_column: "id", key: 7, actor: null }],
      ["POST", "/lancedb/tables/articles/row", { key_column: "id", key: "a" }],
    ]);
  });

  it("surfaces the agent's refusal with its status", async () => {
    const f = fake(409, { error: "the key matches 2 rows; pick a unique key column" });
    const err = await lanceDelete("articles", { keyColumn: "views", key: 3 }, f.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ status: 409, message: "the key matches 2 rows; pick a unique key column" });
  });
});
