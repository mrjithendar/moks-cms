import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { setDbForTests } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";

const { hasTerm, themeOf, themesOfArticle, fitTitle, titleFor, skipMeasured, generateEditorialSuggestions, MAX_OPEN_IDEAS, THEMES } = await import("@/lib/seo-intel/editorial");
const { DEFAULT_SEO_SETTINGS } = await import("@/lib/seo-intel/settings");
import type { AnalysisData, Article } from "@/lib/seo-intel/data";
import type { Candidate } from "@/lib/seo-intel/rules";

// --- Fixtures (invented; titles modelled on the live site's) --------------------------------------------------------
let n = 0;
function article(title: string, tags: string[], category = "kubernetes"): Article {
  const slug = `a-${++n}`;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    collection: "blog",
    slug,
    title,
    description: "A description.",
    body: "",
    category,
    tags,
    contentType: "tutorial",
    seoTitle: null,
    seoDescription: null,
    featuredImage: null,
    publishedAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: null,
    noindex: false,
    canonicalUrl: null,
    status: "published",
    path: `/blog/${slug}`,
    url: `https://jithendar.com/blog/${slug}`,
  } as Article;
}
const data = (articles: Article[]): AnalysisData => ({ asOf: null, periods: null, pageQuery: [], pages: new Map(), yoyAvailable: false, articles, articleByUrl: new Map(), knownPaths: new Set() }) as AnalysisData;
const gap = (query: string): Candidate => ({ fingerprint: `gap-${query}`, category: "content_gap", ruleKey: "content_gap", articleId: null, url: null, query, problem: `No page answers "${query}".`, proposedAction: "Write it.", evidence: [{ metric: "impressions", period: "28d", value: 500, source: "gsc" }], inputs: {}, confidence: "medium", expectedImpact: "" }) as Candidate;

const SITE = [
  article("Learning Terraform Through a Real Project: How I Manage Infrastructure", ["terraform", "infrastructure as code", "aws", "vpc"], "infrastructure-as-code"),
  article("Deploy RoboShop AI on Amazon EKS: Terraform, Istio and Karpenter", ["amazon eks", "terraform", "istio", "karpenter"]),
  article("Inside RoboShop AI: microservices on Kubernetes", ["kubernetes", "microservices", "terraform"]),
  article("One Redis for Every App: Valkey on Minikube with Terraform", ["redis", "kubernetes", "terraform", "helm"]),
];

describe("matching", () => {
  it("matches whole words and plurals, not substrings", () => {
    expect(hasTerm("Kubernetes pods explained", "pod")).toBe(true);
    expect(hasTerm("My DevOps podcast", "pod")).toBe(false);
    expect(hasTerm("A SQL statement", "state")).toBe(false);
    expect(hasTerm("Terraform state locking", "state")).toBe(true);
    expect(hasTerm("Next.js caching", "next.js")).toBe(true);
    expect(hasTerm("ci/cd with GitHub Actions", "ci/cd")).toBe(true);
  });

  it("counts an article for every theme its title or tags name", () => {
    const clusters = themesOfArticle(SITE[1]!).map((t) => t.cluster);
    expect(clusters).toEqual(expect.arrayContaining(["Terraform & IaC", "Kubernetes & EKS", "Security & networking"]));
    expect(themeOf("terraform remote state")?.cluster).toBe("Terraform & IaC");
  });
});

describe("titles", () => {
  it("keeps titles to 60 characters, dropping the subtitle first", () => {
    expect(fitTitle("Terraform & IaC: a practical guide for engineers managing infrastructure as code")).toBe("Terraform & IaC");
    const long = fitTitle("A very long heading without any colon that keeps going well past sixty characters");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith(" ")).toBe(false);
    expect(titleFor("how to rotate cert-manager certificates on k3s with cloudflare dns01").length).toBeLessThanOrEqual(60);
  });
});

describe("measured suggestions", () => {
  it("skips a 'vs' between different themes and queries an article already covers", () => {
    const site = [...SITE, article("Inside RoboShop AI: the architecture", ["roboshop"])];
    expect(skipMeasured("shell scripting vs fastapi", site)).toBe("compares two different themes");
    expect(skipMeasured("roboshop", site)).toBe("already the subject of a published article");
    expect(skipMeasured("terraform vs pulumi", site)).toBeNull();
    expect(skipMeasured("helm chart testing", site)).toBeNull();
  });
});

describe("generateEditorialSuggestions", () => {
  afterEach(() => setDbForTests(undefined));

  it("suggests specific uncovered topics, counts coverage correctly and fits titles", async () => {
    const db = await freshDb();
    const created = await generateEditorialSuggestions(db, DEFAULT_SEO_SETTINGS, data(SITE), [gap("shell scripting vs fastapi"), gap("roboshop"), gap("helm chart testing")]);
    const rows = rowsOf<{ kind: string; title: string; cluster: string; brief: { gap: string; notes?: string } }>(await db.execute(sql`select kind, title, cluster, brief from seo_editorial_calendar order by title`));
    expect(created).toBe(rows.length);

    const measured = rows.filter((r) => r.kind === "measured").map((r) => r.title);
    expect(measured).toEqual(["Helm Chart Testing: a practical guide"]);

    const ideas = rows.filter((r) => r.kind === "editorial_idea");
    expect(ideas).toHaveLength(MAX_OPEN_IDEAS);
    for (const r of rows) expect(r.title.length).toBeLessThanOrEqual(60);
    for (const r of ideas) {
      expect(r.title).not.toMatch(/for (engineers|developers|teams)/); // a topic, not "<theme>: a practical guide for <audience>"
      expect(r.brief.notes).toMatch(/^Scope: /);
    }
    // Four Terraform posts: the theme is not "0 published articles", so it is not among the least-covered themes.
    expect(ideas.map((r) => r.cluster)).not.toContain("Terraform & IaC");
    expect(ideas.map((r) => r.cluster)).not.toContain("Kubernetes & EKS");
  });

  it("never re-suggests a topic already on the calendar and keeps at most MAX_OPEN_IDEAS waiting", async () => {
    const db = await freshDb();
    await generateEditorialSuggestions(db, DEFAULT_SEO_SETTINGS, data(SITE), []);
    expect(await generateEditorialSuggestions(db, DEFAULT_SEO_SETTINGS, data(SITE), [])).toBe(0); // full

    const [first] = rowsOf<{ id: string; title: string; cluster: string }>(await db.execute(sql`select id, title, cluster from seo_editorial_calendar where kind = 'editorial_idea' order by created_at limit 1`));
    await db.execute(sql`update seo_editorial_calendar set status = 'dropped' where id = ${first!.id}`);
    expect(await generateEditorialSuggestions(db, DEFAULT_SEO_SETTINGS, data(SITE), [])).toBe(1); // one slot freed
    const titles = rowsOf<{ title: string }>(await db.execute(sql`select title from seo_editorial_calendar where kind = 'editorial_idea'`)).map((r) => r.title);
    expect(titles.filter((t) => t === first!.title)).toHaveLength(1); // the dropped topic is not back
    expect(THEMES.find((t) => t.cluster === first!.cluster)).toBeDefined();
  });
});
