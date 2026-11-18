import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rowsOf } from "@/db/rows";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { rewriteLink } = await import("@/lib/seo-intel/changeset");
const BL = await import("@/lib/seo-intel/broken-links");

const filler = (n: number, topic = "the platform team keeps the cluster healthy") => Array.from({ length: Math.ceil(n / 7) }, () => topic).join(" ");
const admin = { id: "admin", role: "admin" as const, label: "admin@example.com" };

async function setup(bodies: Record<string, string>) {
  const { freshDb } = await import("./db-helpers");
  const { schema } = await import("@/db");
  const { settingsInput } = await import("./seo-fixtures");
  const { seedArticle } = await import("./seo-v2-fixtures");
  const { saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");
  const db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  const ids: Record<string, string> = {};
  for (const [slug, body] of Object.entries(bodies)) ids[slug] = (await seedArticle(db, { slug, title: `Title of ${slug}`, seoTitle: null, body })).id;
  await db.execute(sql`update post set saved_at = now() - interval '3 days'`);
  return { db, schema, ids, s: await getSeoSettings() };
}

describe("rewriteLink (broken-link fixes)", () => {
  it("re-points or unlinks inline links and autolinks, never images", () => {
    const md = 'See [the guide](https://old.example/x "Guide") and <https://old.example/x>. ![pic](https://old.example/x)';
    expect(rewriteLink(md, "https://old.example/x", "https://new.example/y")).toBe('See [the guide](https://new.example/y "Guide") and <https://new.example/y>. ![pic](https://old.example/x)');
    expect(rewriteLink(md, "https://old.example/x", null)).toBe("See the guide and <https://old.example/x>. ![pic](https://old.example/x)");
  });
  it("normalises links: own host → path, fragments dropped, mail/tel ignored", () => {
    expect(BL.normalizeLink("https://www.jithendar.com/blog/x/#a", "https://jithendar.com")).toEqual({ key: "/blog/x", internal: true });
    expect(BL.normalizeLink("https://example.com/a#b", "https://jithendar.com")).toEqual({ key: "https://example.com/a", internal: false });
    expect(BL.normalizeLink("mailto:a@b.c")).toBeNull();
    expect(BL.normalizeLink("#top")).toBeNull();
  });
});

describe("keyword → URL list", () => {
  it("validates targets, links the first eligible mention, and feeds the auto-linker", async () => {
    const { db, schema, ids, s } = await setup({
      "gitops-guide": `Intro sentence about GitOps here. ${filler(300)}`,
      "rollouts": ["We start with an intro. It mentions nothing.", "", `${filler(160)} Adopting GitOps changes how releases work. ${filler(40)}`, "", `${filler(160)} Our docs live at the Platform Handbook for reference. ${filler(40)}`].join("\n"),
    });
    const K = await import("@/lib/seo-intel/link-keywords");
    await expect(K.createKeyword(db, K.keywordInput.parse({ keyword: "nothing here", url: "/blog/missing" }), "admin")).rejects.toMatchObject({ status: 400 });
    expect(K.keywordInput.safeParse({ keyword: "x", url: "ftp://a" }).success).toBe(false);
    await K.createKeyword(db, K.keywordInput.parse({ keyword: "GitOps", url: "/blog/gitops-guide" }), "admin");
    await K.createKeyword(db, K.keywordInput.parse({ keyword: "platform handbook", url: "https://handbook.example.com/" }), "admin");
    await expect(K.createKeyword(db, K.keywordInput.parse({ keyword: "gitops", url: "/blog/gitops-guide" }), "admin")).rejects.toMatchObject({ status: 409 });

    const { runAutoLinks } = await import("@/lib/seo-intel/auto-links");
    const r = await runAutoLinks(db, s);
    expect(r.failed).toEqual([]);
    const body = (await db.select().from(schema.post)).find((p) => p.id === ids.rollouts)!.body;
    expect(body).toContain("[GitOps](/blog/gitops-guide)");
    expect(body).toContain("[Platform Handbook](https://handbook.example.com/)"); // case-insensitive keyword, original casing kept
    // never links an article to itself
    expect((await db.select().from(schema.post)).find((p) => p.id === ids["gitops-guide"])!.body).not.toContain("](/blog/gitops-guide)");
  });
});

describe("editor link suggestions", () => {
  it("suggests from the unsaved text and inserts only validated links", async () => {
    const { db, ids, s } = await setup({ target: `Target article about Argo CD rollouts. ${filler(300)}`, source: `Opening line here. ${filler(200)}` });
    const L = await import("@/lib/seo-intel/link-suggestions");
    const text = ["Opening line here. Nothing to link.", "", `${filler(160)} Every change is reconciled by Argo CD from git. ${filler(40)}`, "", `${filler(160)} Alerts come from Prometheus. ${filler(40)}`].join("\n");
    const sug = await L.suggestLinks(db, s, { postId: ids.source!, body: text });
    const docs = sug.filter((x) => x.kind === "docs").map((x) => x.target);
    expect(docs).toEqual(expect.arrayContaining(["https://argo-cd.readthedocs.io/en/stable/", "https://prometheus.io/docs/introduction/overview/"]));
    const pick = sug.find((x) => x.target === "https://prometheus.io/docs/introduction/overview/")!;
    expect(pick.excerpt).toContain("Prometheus");
    const next = await L.applySuggestion(db, s, L.applyInput.parse({ postId: ids.source, body: text, change: pick }));
    expect(next).toContain("[Prometheus](https://prometheus.io/docs/introduction/overview/)");
    // a tampered suggestion (other URL) is refused
    await expect(L.applySuggestion(db, s, L.applyInput.parse({ postId: ids.source, body: text, change: { ...pick, target: "https://evil.example/", after: `[${pick.before}](https://evil.example/)` } }))).rejects.toMatchObject({ status: 409 });
  });
});

describe("broken-link checker", () => {
  it("classifies links, counts repeated failures, and fixes a post in one click", async () => {
    const { db, schema, ids, s } = await setup({
      live: `Live article. ${filler(200)}`,
      source: [
        "Intro sentence with no links at all.",
        "",
        `${filler(60)} See [the old guide](https://gone.example/page) and [our post](/blog/missing-post). ${filler(20)}`,
        "",
        `${filler(60)} Also [this works](https://ok.example/), [blocked](https://blocked.example/), [flaky](https://flaky.example/) and [moved post](/blog/old-name), plus [live](/blog/live). ${filler(20)}`,
      ].join("\n"),
    });
    await db.insert(schema.redirect).values({ fromPath: "/blog/old-name", toPath: "/blog/live" });
    const fetcher = async (url: string) => {
      const status = url.startsWith("https://gone.") ? 404 : url.startsWith("https://blocked.") ? 403 : url.startsWith("https://flaky.") ? 503 : 200;
      return { url, finalUrl: url, status, headers: {}, body: "", redirects: [], truncated: false };
    };
    const r1 = await BL.runLinkCheck(db, s, new Date(), fetcher);
    expect(r1).toMatchObject({ internal: 3, external: 4 });
    let p = await BL.linkProblems(db);
    expect(p.broken.map((x) => x.url).sort()).toEqual(["/blog/missing-post", "https://gone.example/page"]); // flaky: 1 failure only
    expect(p.redirected.map((x) => [x.url, x.finalUrl])).toEqual([["/blog/old-name", "/blog/live"]]);
    expect(p.totals.blocked).toBe(1);
    await BL.runLinkCheck(db, s, new Date(Date.now() + 8 * 86_400_000), fetcher);
    p = await BL.linkProblems(db);
    expect(p.broken.map((x) => x.url)).toContain("https://flaky.example/"); // 2nd failure in a row
    expect(p.broken.find((x) => x.url === "/blog/missing-post")!.where).toEqual([expect.objectContaining({ kind: "post", id: ids.source })]);

    // One-click fixes: unlink one, re-point another, update the moved one.
    await BL.fixBrokenLink(db, s, admin, ids.source!, "https://gone.example/page", null);
    await BL.fixBrokenLink(db, s, admin, ids.source!, "/blog/missing-post", "/blog/live");
    await BL.fixBrokenLink(db, s, admin, ids.source!, "/blog/old-name", "/blog/live");
    const body = (await db.select().from(schema.post)).find((x) => x.id === ids.source)!.body;
    expect(body).toContain("See the old guide and [our post](/blog/live).");
    expect(body).toContain("[moved post](/blog/live)");
    expect(body).toContain("[this works](https://ok.example/)"); // untouched
    const drafts = rowsOf<{ trigger: string; status: string; decided_by: string }>(await db.execute(sql`select trigger, status, decided_by from seo_drafts where article_id = ${ids.source}`));
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.trigger === "link_fix" && d.status === "published" && d.decided_by === "admin@example.com")).toBe(true);
    await expect(BL.fixBrokenLink(db, s, admin, ids.source!, "https://gone.example/page", null)).rejects.toMatchObject({ status: 409 }); // gone now
    await expect(BL.fixBrokenLink(db, s, admin, ids.source!, "https://flaky.example/", "ftp://x")).rejects.toMatchObject({ status: 400 });
  });
});
