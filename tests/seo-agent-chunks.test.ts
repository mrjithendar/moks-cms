import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { AgentError, chunkArticles, chunkOverview, chunkRow, chunkRows } = await import("@/lib/seo-agent/client");
const { GUIDE } = await import("@/lib/user-guide");

const env = { SEO_AGENT_URL: "http://agent:8080/", SEO_AGENT_TOKEN: "t".repeat(40) };

function fake(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, deps: { fetchImpl, env } };
}

const path = (c: { url: string }) => c.url.replace("http://agent:8080", "");

describe("Article index client (/admin/article-index → seo-agent app/chunk_browser.py, D-103)", () => {
  it("reads with the bearer token and GET only", async () => {
    const f = fake(200, { available: true, tables: [] });
    await chunkOverview(f.deps);
    await chunkArticles({}, f.deps);
    await chunkRows({}, f.deps);
    await chunkRow(7, "live", f.deps);
    expect(f.calls.map((c) => [c.init.method, path(c)])).toEqual([
      ["GET", "/chunks"],
      ["GET", "/chunks/articles"],
      ["GET", "/chunks/rows"],
      ["GET", "/chunks/rows/7?table=live"],
    ]);
    for (const c of f.calls) expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(40)}`);
  });

  it("sends the table, filters and paging in the agent's names, encoded", async () => {
    const f = fake(200, { items: [] });
    await chunkArticles({ table: "rebuild", q: "cert-manager & TLS", offset: 25, limit: 25 }, f.deps);
    await chunkRows({ articleId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", q: "100%", offset: 0, limit: 25 }, f.deps);
    expect(f.calls.map(path)).toEqual([
      "/chunks/articles?table=rebuild&q=cert-manager+%26+TLS&offset=25&limit=25",
      "/chunks/rows?article_id=6f9619ff-8b86-d011-b42d-00c04fc964ff&q=100%25&offset=0&limit=25",
    ]);
  });

  it("surfaces the agent's refusal with its status", async () => {
    const f = fake(404, { error: "no rebuild is running" });
    const err = await chunkRows({ table: "rebuild" }, f.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ status: 404, message: "no rebuild is running" });
  });
});

describe("LanceDB is gone (D-103)", () => {
  it("has no menu entry, guide entry or callback route; the old address redirects to the article index", () => {
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    expect(read("src/app/admin/layout.tsx")).not.toContain("/admin/lancedb");
    expect(read("src/lib/admin-menu.ts")).not.toContain("/admin/lancedb");
    expect(GUIDE.some((e) => e.href === "/admin/lancedb")).toBe(false);
    expect(read("src/lib/seo-agent/internal-server.ts")).not.toContain("lancedb");
    expect(read("src/app/admin/lancedb/page.tsx")).toContain('redirect("/admin/article-index")');
  });
});
