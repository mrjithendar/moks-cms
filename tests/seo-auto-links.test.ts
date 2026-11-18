import { sql } from "drizzle-orm";
import { rowsOf } from "@/db/rows";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SEO_SETTINGS } from "@/lib/seo-intel/settings";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { linkRel, isExternalHref } = await import("@/lib/mdx/link-rel");
const X = await import("@/lib/seo-intel/external-links");

const filler = (n: number, topic = "the platform team keeps the cluster healthy") => Array.from({ length: Math.ceil(n / 7) }, () => topic).join(" ");
const limits = { maxExternalPerArticle: 2, minWordsBetween: 100 };

describe("external links are nofollow", () => {
  it("adds nofollow noopener to other sites, keeps existing tokens, leaves this site alone", () => {
    const o = "https://jithendar.com";
    expect(linkRel("https://kubernetes.io/docs/", undefined, o)).toBe("nofollow noopener");
    expect(linkRel("http://example.com/x", "sponsored", o)).toBe("sponsored nofollow noopener");
    expect(linkRel("//cdn.example.com/a", undefined, o)).toBe("nofollow noopener");
    for (const internal of ["/blog/x", "#setup", "https://jithendar.com/blog/x", "https://www.jithendar.com/", "mailto:a@b.c", "./rel"]) {
      expect(isExternalHref(internal, o)).toBe(false);
      expect(linkRel(internal, undefined, o)).toBeUndefined();
    }
  });
});

describe("official-docs external links: conservative planner", () => {
  const body = [
    "Kubernetes is mentioned in the first sentence, so that mention is never linked. More intro text follows here.",
    "",
    "## Installing Helm",
    "",
    `${filler(120)} Here Kubernetes appears again but only the first mention counts. ${filler(30)}`,
    "",
    "```bash",
    "terraform init # Terraform inside code",
    "```",
    "",
    `${filler(150)} We provision the network with Terraform modules and keep state remote. ${filler(40)}`,
    "",
    `${filler(150)} Metrics flow into Prometheus and dashboards show them. ${filler(40)}`,
    "",
    `${filler(150)} Later Argo CD syncs the manifests, and someone stood at the helm of the release. ${filler(40)}`,
  ].join("\n");

  it("links first mentions in prose only, at most 2, and never headings, code or the first sentence", () => {
    const p = X.planExternalLinks(body, limits);
    const keys = p.planned.map((x) => x.entry.key);
    expect(keys.length).toBeLessThanOrEqual(2);
    expect(keys).not.toContain("kubernetes"); // first mention is in the first sentence
    expect(keys).not.toContain("helm"); // first mention is a heading; "at the helm" never matches
    expect(keys).not.toContain("terraform"); // first mention is in a code block
    expect(keys).toEqual(["prometheus", "argocd"]);
  });

  it("adds nothing when the article already has enough external links, and skips docs already linked", () => {
    const linked = `${body}\n\n${filler(150)} See [the docs](https://prometheus.io/docs/alerting/) and [k8s](https://kubernetes.io/). ${filler(20)}`;
    expect(X.planExternalLinks(linked, limits).planned).toEqual([]);
    const one = `${body}\n\n${filler(150)} See [alerting](https://prometheus.io/docs/alerting/). ${filler(20)}`;
    expect(X.planExternalLinks(one, limits).planned.map((x) => x.entry.key)).toEqual(["argocd"]);
  });

  it("only allowlisted official docs validate", async () => {
    const { validateChangeSet, blocksOf } = await import("@/lib/seo-intel/changeset");
    const { diffWords } = await import("diff");
    const base = { title: "t", description: "d", seoTitle: null, seoDescription: null, body, collection: "blog", slug: "s", version: 1 };
    const s = { ...DEFAULT_SEO_SETTINGS };
    const changes = X.externalLinkChangesFor(s, base, 1);
    expect(changes.length).toBe(2);
    const ctx = { otherTitles: new Set<string>(), knownPaths: new Set<string>(), maxRewriteRatio: 0.3, categories: [], linkLimits: { wordsPerLink: 250 }, externalAllow: X.ALLOWED_EXTERNAL_URLS };
    expect(validateChangeSet(base, changes, ctx, diffWords).errors).toEqual([]);
    const forged = { ...changes[0]!, target: "https://evil.example/", after: `[${changes[0]!.before}](https://evil.example/)`, sourceUrls: ["https://evil.example/"] };
    expect(validateChangeSet(base, [forged], ctx, diffWords).errors.join(" ")).toMatch(/allowlist/);
    expect(blocksOf(body).length).toBeGreaterThan(3);
  });
});

describe("weekly automatic link publishing (DB)", () => {
  async function setup() {
    const { freshDb } = await import("./db-helpers");
    const { schema } = await import("@/db");
    const { settingsInput } = await import("./seo-fixtures");
    const { seedArticle } = await import("./seo-v2-fixtures");
    const { saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");
    const db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
    await saveSeoSettings(settingsInput(), "admin");
    const src = await seedArticle(db, {
      slug: "gitops-rollout",
      title: "GitOps rollouts on a small cluster",
      seoTitle: null,
      body: [
        "This article walks through a GitOps rollout end to end. It starts with the basics.",
        "",
        `${filler(160)} Every change is reconciled by Argo CD from the main branch. ${filler(40)}`,
        "",
        `${filler(160)} Alerts come from Prometheus when a sync fails. ${filler(40)}`,
        "",
        `${filler(200)}`,
      ].join("\n"),
    });
    await db.execute(sql`update post set saved_at = now() - interval '3 days'`);
    return { db, schema, src, s: await getSeoSettings() };
  }

  it("publishes link-only drafts automatically, records them, and leaves the article alone during the cool-down", async () => {
    const { db, schema, src, s } = await setup();
    const { runAutoLinks } = await import("@/lib/seo-intel/auto-links");
    const r = await runAutoLinks(db, s);
    expect(r).toMatchObject({ published: 1, failed: [] });
    const body = (await db.select().from(schema.post)).find((p) => p.id === src.id)!.body;
    expect(body).toContain("[Argo CD](https://argo-cd.readthedocs.io/en/stable/)");
    expect(body).toContain("[Prometheus](https://prometheus.io/docs/introduction/overview/)");
    const [d] = rowsOf<{ status: string; trigger: string; decided_by: string }>(await db.execute(sql`select status, trigger, decided_by from seo_drafts where article_id = ${src.id}`));
    expect(d).toMatchObject({ status: "published", trigger: "auto_links", decided_by: "auto-links (admin@example.com)" });
    await db.execute(sql`update post set saved_at = now() - interval '3 days'`);
    expect(await runAutoLinks(db, s)).toMatchObject({ published: 0, skipped: { cooldown: 1 } });
  });

  it("skips an article someone is editing, and is off when disabled", async () => {
    const { db, schema, src, s } = await setup();
    const { runAutoLinks } = await import("@/lib/seo-intel/auto-links");
    await db.insert(schema.autosave).values({ entity: "post", entityId: src.id, userId: "admin", baseVersion: 1, payload: {} });
    expect(await runAutoLinks(db, s)).toMatchObject({ published: 0, skipped: { unsaved_editor_changes: 1 } });
    expect(await runAutoLinks(db, { ...s, links: { ...s.links, auto: { ...s.links.auto, enabled: false } } })).toMatchObject({ articles: 0, published: 0 });
  });

  it("refuses to auto-publish anything but rule-made link changes", async () => {
    const { db, src } = await setup();
    const drafts = await import("@/lib/seo-intel/drafts");
    const pub = await import("@/lib/seo-intel/publish");
    const base = await drafts.loadBase(db, src.id);
    const d = await drafts.reserveDraft(db, src.id, base, "auto_links");
    const edit = { id: "c1", type: "paragraph_edit", location: { blockId: null, headingPath: null, field: null }, before: "x", after: "y", rationale: "", evidenceRef: [], sourceUrls: [], origin: "claude", decision: "accepted", edited: null, flags: [] };
    await db.execute(sql`update seo_drafts set status = 'ready_for_review', changes = ${JSON.stringify([edit])}::jsonb where id = ${d.id}`);
    await expect(pub.autoPublishLinkDraft(d.id, { id: "admin", role: "admin", label: "auto" })).rejects.toThrow(/limited to rule-made link changes/);
  });
});
