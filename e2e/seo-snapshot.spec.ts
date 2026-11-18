import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { diffSnapshots, extract, type Snapshot } from "../scripts/seo-snapshot";

/**
 * SEO preservation: identical URLs, canonicals, titles, meta, robots, JSON-LD, sitemap and robots.txt for the URLs in
 * tests/fixtures/seo-snapshot.json, captured BEFORE the UI overhaul. Runs against the same content configuration as the
 * capture (docs/seo/OPERATIONS.md "Performance and SEO snapshot").
 */
test.skip(!process.env.SEO_SNAPSHOT_CHECK, "set SEO_SNAPSHOT_CHECK=1 against a site started with the snapshot's content");

test("SEO output is identical to the pre-change snapshot", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const before = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../tests/fixtures/seo-snapshot.json"), "utf8")) as Snapshot;
  const pages: Snapshot["pages"] = {};
  for (const p of before.urls) {
    const res = await request.get(p, { maxRedirects: 0 });
    pages[p] = extract(await res.text(), res.status(), res.headers()["x-robots-tag"] ?? null);
  }
  const sitemapXml = await (await request.get("/sitemap.xml")).text();
  const sitemap = [...sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({ loc: /<loc>([^<]+)<\/loc>/.exec(m[1]!)?.[1] ?? "", lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(m[1]!)?.[1] ?? null })).sort((a, b) => a.loc.localeCompare(b.loc));
  const robotsTxt = await (await request.get("/robots.txt")).text();
  expect(diffSnapshots(before, { urls: before.urls, pages, sitemap, robotsTxt })).toEqual([]);
});
