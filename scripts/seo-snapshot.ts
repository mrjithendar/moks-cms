/**
 * SEO preservation snapshot (docs/seo/PROGRESS.md, Phase 7.2).
 *
 * Fetches a running site and records, per URL, exactly what search engines read: status, <title>, meta description,
 * canonical, robots meta + X-Robots-Tag, Open Graph url/title, and every JSON-LD block (parsed, keys sorted). Also
 * records the sitemap URL set (with lastmod) and robots.txt. Used before and after the UI overhaul: `--check` fails
 * on any difference.
 *
 *   npx tsx scripts/seo-snapshot.ts --base http://localhost:3100 --out tests/fixtures/seo-snapshot.json
 *   npx tsx scripts/seo-snapshot.ts --base http://localhost:3100 --check tests/fixtures/seo-snapshot.json
 *
 * URL choice: the 20 URLs with the most Search Console clicks when SEO_SNAPSHOT_URLS (comma-separated paths) is set
 * from production data; otherwise the home page, the indexable category pages and the newest articles in the
 * sitemap, up to 20 (a local build has no traffic data).
 */
import fs from "node:fs";
import { Window } from "happy-dom";

type PageSnap = {
  status: number;
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  xRobotsTag: string | null;
  ogUrl: string | null;
  ogTitle: string | null;
  jsonLd: unknown[];
};
export type Snapshot = { urls: string[]; pages: Record<string, PageSnap>; sitemap: { loc: string; lastmod: string | null }[]; robotsTxt: string };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** Deterministic JSON: object keys sorted. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export function extract(html: string, status: number, xRobotsTag: string | null): PageSnap {
  const win = new Window();
  const doc = win.document;
  doc.write(html);
  const meta = (sel: string) => doc.querySelector(sel)?.getAttribute("content") ?? null;
  const jsonLd = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
    try {
      return sortKeys(JSON.parse(s.textContent ?? ""));
    } catch {
      return { invalid: s.textContent };
    }
  });
  const snap: PageSnap = {
    status,
    title: doc.querySelector("title")?.textContent?.trim() ?? null,
    description: meta('meta[name="description"]'),
    canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
    robots: meta('meta[name="robots"]'),
    xRobotsTag,
    ogUrl: meta('meta[property="og:url"]'),
    ogTitle: meta('meta[property="og:title"]'),
    jsonLd,
  };
  void win.happyDOM.close();
  return snap;
}

async function take(base: string): Promise<Snapshot> {
  const sitemapXml = await (await fetch(`${base}/sitemap.xml`)).text();
  const sitemap = [...sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    loc: /<loc>([^<]+)<\/loc>/.exec(m[1]!)?.[1] ?? "",
    lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(m[1]!)?.[1] ?? null,
  }));
  const robotsTxt = await (await fetch(`${base}/robots.txt`)).text();
  const origin = new URL(sitemap[0]?.loc ?? "https://jithendar.com").origin;
  let paths = process.env.SEO_SNAPSHOT_URLS?.split(",").map((p) => p.trim()).filter(Boolean);
  if (!paths?.length) {
    const toPath = (u: string) => u.slice(origin.length) || "/";
    const articles = sitemap.filter((e) => /\/(blog|news|projects)\/[^/]+$/.test(e.loc)).sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? "") || a.loc.localeCompare(b.loc));
    const cats = sitemap.filter((e) => e.loc.includes("/category/"));
    paths = ["/", ...cats.map((e) => toPath(e.loc)), ...articles.map((e) => toPath(e.loc))].slice(0, 20);
  }
  const pages: Record<string, PageSnap> = {};
  for (const p of paths) {
    const res = await fetch(`${base}${p}`, { redirect: "manual" });
    pages[p] = extract(await res.text(), res.status, res.headers.get("x-robots-tag"));
  }
  return { urls: paths, pages, sitemap: sitemap.sort((a, b) => a.loc.localeCompare(b.loc)), robotsTxt };
}

/** Human-readable differences between two snapshots (empty = identical). */
export function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  for (const url of a.urls) {
    const x = a.pages[url];
    const y = b.pages[url];
    if (!y) {
      out.push(`${url}: missing in new snapshot`);
      continue;
    }
    for (const k of Object.keys(x!) as (keyof PageSnap)[]) {
      if (JSON.stringify(x![k]) !== JSON.stringify(y[k])) out.push(`${url}: ${k} changed\n  before: ${JSON.stringify(x![k])}\n  after:  ${JSON.stringify(y[k])}`);
    }
  }
  if (JSON.stringify(a.sitemap) !== JSON.stringify(b.sitemap)) out.push("sitemap.xml: URL set or lastmod changed");
  if (a.robotsTxt !== b.robotsTxt) out.push("robots.txt changed");
  return out;
}

if (process.argv[1]?.endsWith("seo-snapshot.ts")) {
  const base = (arg("base") ?? "http://localhost:3100").replace(/\/+$/, "");
  const snap = await take(base);
  const check = arg("check");
  if (check) {
    const before = JSON.parse(fs.readFileSync(check, "utf8")) as Snapshot;
    const diffs = diffSnapshots(before, { ...snap, urls: before.urls, pages: Object.fromEntries(await Promise.all(before.urls.map(async (p) => {
      const res = await fetch(`${base}${p}`, { redirect: "manual" });
      return [p, extract(await res.text(), res.status, res.headers.get("x-robots-tag"))] as const;
    }))) });
    if (diffs.length) {
      console.error(`SEO snapshot differs (${diffs.length}):\n${diffs.join("\n")}`);
      process.exit(1);
    }
    console.log(`SEO snapshot identical for ${before.urls.length} URLs, ${before.sitemap.length} sitemap entries and robots.txt.`);
  } else {
    const out = arg("out") ?? "tests/fixtures/seo-snapshot.json";
    fs.writeFileSync(out, `${JSON.stringify(snap, null, 1)}\n`);
    console.log(`Wrote ${out}: ${snap.urls.length} URLs, ${snap.sitemap.length} sitemap entries.`);
  }
}
