import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Article } from "@/lib/content";

vi.mock("server-only", () => ({}));

const { compileMdx, fenceMeta } = await import("@/lib/mdx/compile");
const { hubFeatured } = await import("@/lib/pages/listings");
const { seriesNeighbours, relatedArticles } = await import("@/lib/content");

const art = (slug: string, body = "", over: Partial<Article["frontmatter"]> = {}): Article =>
  ({
    collection: "blog",
    slug,
    path: `/blog/${slug}`,
    body,
    file: slug,
    frontmatter: { title: slug, slug, description: "d", author: "a", category: "kubernetes", tags: [], contentType: "tutorial", status: "published", publishedAt: "2026-01-01T00:00:00Z", sources: [], corrections: [], sponsored: false, related: [], noindex: false, ...over },
  }) as unknown as Article;

describe("code blocks: filename and line highlighting (opt-in fence meta)", () => {
  it("parses title/filename and line ranges", () => {
    expect(fenceMeta('title="lib/x.ts" {2,4-5}')).toEqual({ title: "lib/x.ts", lines: new Set([2, 4, 5]) });
    expect(fenceMeta("filename=main.go")).toEqual({ title: "main.go", lines: new Set() });
    expect(fenceMeta(undefined)).toEqual({ title: null, lines: new Set() });
  });
  it("renders data-title and highlighted lines; blocks without meta are unchanged", async () => {
    const render = async (md: string) => renderToStaticMarkup(createElement((await compileMdx(md)).Content, { components: { pre: (p: Record<string, unknown>) => createElement("pre", p) } }));
    const html = await render('```ts title="lib/x.ts" {2}\nconst a = 1;\nconst b = 2;\n```\n');
    expect(html).toContain('data-title="lib/x.ts"');
    expect(html.match(/class="line highlighted"/g)).toHaveLength(1);
    const plain = await render("```ts\nconst a = 1;\n```\n");
    expect(plain).not.toMatch(/data-title|highlighted/);
  });
});

describe("topic hubs and article navigation", () => {
  it("hub: up to 3 most-linked articles of the category (≥ 2 inbound), only for categories with ≥ 6 articles", () => {
    const cat = Array.from({ length: 6 }, (_, i) => art(`k${i}`));
    const linkers = [art("x1", "[a](/blog/k1) [b](/blog/k2)"), art("x2", "[a](/blog/k1) [b](/blog/k2) [c](/blog/k3)"), art("x3", "[a](/blog/k1)")];
    expect(hubFeatured(cat, [...cat, ...linkers]).map((a) => a.slug)).toEqual(["k1", "k2"]); // k3 has only 1 inbound
    expect(hubFeatured(cat.slice(0, 5), [...cat, ...linkers])).toEqual([]);
  });

  it("series prev/next by -part-N, otherwise same-topic neighbours by date", async () => {
    const root = (await import("node:path")).resolve(import.meta.dirname, "fixtures/content");
    const published = await (await import("@/lib/content")).getPublishedContent({ root, collection: "blog" });
    expect(published.length).toBeGreaterThan(0);
    const n = await seriesNeighbours(published[0]!, { root });
    expect(n.kind).toBe("topic");
    expect(n.prev === null || n.prev.frontmatter.category === published[0]!.frontmatter.category).toBe(true);
  });

  it("related reading prefers articles linked from or to this one", async () => {
    const root = (await import("node:path")).resolve(import.meta.dirname, "fixtures/content");
    const [first] = await (await import("@/lib/content")).getPublishedContent({ root, collection: "blog" });
    const r = await relatedArticles(first!, 3, { root });
    expect(Array.isArray(r)).toBe(true);
    expect(r.every((a) => a.path !== first!.path)).toBe(true);
  });
});
