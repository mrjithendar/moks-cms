import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SEO_SETTINGS } from "@/lib/seo-intel/settings";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const L = await import("@/lib/seo-intel/internal-links");
const { blocksOf } = await import("@/lib/seo-intel/changeset");
type Doc = import("@/lib/seo-intel/internal-links").LinkDoc;

const limits = { ...DEFAULT_SEO_SETTINGS.links };
const filler = (n: number, topic = "the cluster runs workloads reliably") => Array.from({ length: Math.ceil(n / 5) }, () => topic).join(" ");
const doc = (path: string, title: string, body: string, over: Partial<Doc> = {}): Doc => ({ id: path, path, title, body, category: "kubernetes", tags: ["kubernetes"], publishedAt: "2026-01-01", queries: [], ...over });

/** A ~1,200-word source: phrases that match targets appear in eligible and ineligible places. */
function sourceBody() {
  return [
    "Cert-manager ClusterIssuer setup is the first sentence here, so it must never become a link. Then the intro continues.",
    "",
    "## Configure the cert-manager ClusterIssuer",
    "",
    filler(150),
    "",
    "```yaml",
    "# cert-manager ClusterIssuer inside code",
    "kind: ClusterIssuer",
    "```",
    "",
    "![Diagram of ingress traffic flow](/media/x.png) The ingress traffic flow caption.",
    "",
    `${filler(120)} Before this you need a working cert-manager ClusterIssuer for Let's Encrypt. ${filler(60)}`,
    "",
    `${filler(130)} Traffic then passes the ingress controller routing rules described before. ${filler(60)}`,
    "",
    `${filler(130)} We also covered [Prometheus alerting rules](/blog/existing) earlier. ${filler(40)}`,
    "",
    `${filler(130)} Watch Grafana dashboard panels for latency once the Prometheus alerting rules fire. ${filler(60)}`,
    "",
    `${filler(200)} A final mention of service mesh traffic policies sits far below. ${filler(80)}`,
  ].join("\n");
}

function corpus(): Doc[] {
  return [
    doc("/blog/source", "Production ingress on Kubernetes", sourceBody(), { publishedAt: "2026-06-01" }),
    doc("/blog/certs", "Install a cert-manager ClusterIssuer for Let's Encrypt", `cert-manager ClusterIssuer Let's Encrypt certificates. ${filler(400, "certificates renew automatically with cert-manager")}`, { publishedAt: "2026-02-01" }),
    doc("/blog/ingress-routing", "Ingress controller routing rules explained", `ingress controller routing rules ${filler(400, "ingress routing rules match hosts and paths")}`),
    doc("/blog/existing", "Prometheus alerting rules that page the right person", `Prometheus alerting rules ${filler(400, "alerting rules page on symptoms")}`),
    doc("/blog/grafana", "Grafana dashboard panels for latency", `Grafana dashboard panels ${filler(400, "dashboards show latency percentiles")}`),
    doc("/blog/mesh", "Service mesh traffic policies with Istio", `service mesh traffic policies ${filler(400, "mesh policies shift traffic")}`, { category: "devops-sre", tags: ["istio"] }),
    doc("/blog/unrelated", "Baking sourdough bread at home", filler(400, "flour water salt and patience"), { category: "ai-engineering", tags: ["bread"] }),
  ];
}

function plan(over: Partial<typeof limits> = {}, docs = corpus(), inbound = new Map<string, number>()) {
  const g = L.linkGraph(docs);
  return L.planLinks(docs[0]!, docs, g, L.tfidf(docs), { ...limits, ...over }, inbound);
}

describe("internal linking: hard limits", () => {
  it("proposes at most 3 links, each to a different relevant target, never self/existing/unrelated", () => {
    const r = plan();
    expect(r.planned.length).toBeGreaterThan(0);
    expect(r.planned.length).toBeLessThanOrEqual(3);
    const targets = r.planned.map((p) => p.target);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).not.toContain("/blog/source");
    expect(targets).not.toContain("/blog/existing"); // already linked from the source
    expect(targets).not.toContain("/blog/unrelated"); // below the relevance threshold
  });

  it("respects the density cap: existing + new ≤ 1 per 250 words; at/over the cap → none", () => {
    const r = plan();
    expect(r.existing + r.planned.length).toBeLessThanOrEqual(r.cap);
    const dense = corpus();
    dense[0] = { ...dense[0]!, body: `${dense[0]!.body}\n\n${Array.from({ length: 6 }, (_, i) => `See [x${i}](/blog/n${i}).`).join(" ")}` };
    const capped = plan({}, dense);
    expect(capped.planned).toEqual([]);
    expect(capped.skipped).toMatch(/density cap/);
  });

  it("never links inside headings, code, image captions, the first sentence or existing links", () => {
    const r = plan({ maxNewPerDraft: 10, wordsPerLink: 100, minWordsBetween: 0 });
    const body = corpus()[0]!.body;
    const blocks = new Map(blocksOf(body).map((b) => [b.id, b]));
    for (const p of r.planned) {
      const b = blocks.get(p.blockId)!;
      expect(b.kind).toMatch(/paragraph|list/);
      expect(b.hasImage).toBe(false);
      expect(b.source.startsWith("Cert-manager ClusterIssuer setup is the first")).toBe(false);
    }
    const cert = r.planned.find((p) => p.target === "/blog/certs");
    expect(cert?.anchor.toLowerCase()).toBe("cert-manager clusterissuer for let's encrypt");
  });

  it("keeps ≥ minWordsBetween words between new links", () => {
    const tight = plan({ minWordsBetween: 100 });
    const loose = plan({ minWordsBetween: 0, maxNewPerDraft: 10, wordsPerLink: 100 });
    expect(loose.planned.length).toBeGreaterThanOrEqual(tight.planned.length);
    // the grafana and prometheus phrases sit in the same paragraph region; with spacing only one survives nearby
    expect(tight.planned.length).toBeLessThanOrEqual(3);
  });

  it("caps new inbound links per target per rolling week", () => {
    const inbound = new Map([["/blog/certs", 5]]);
    expect(plan({}, corpus(), inbound).planned.map((p) => p.target)).not.toContain("/blog/certs");
    const fresh = new Map<string, number>();
    plan({}, corpus(), fresh);
    expect([...fresh.values()].every((n) => n === 1)).toBe(true); // updated with this plan's picks
  });
});

describe("internal linking: anchors, relevance and priorities", () => {
  it("uses 2–6-word phrases that already exist in the paragraph (no new sentences)", () => {
    for (const p of plan().planned) {
      const n = p.anchor.split(/\s+/).length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(6);
      expect(corpus()[0]!.body).toContain(p.anchor);
    }
  });

  it("never reuses an exact anchor another article already uses for the same target", () => {
    const docs = corpus();
    docs.push(doc("/blog/elsewhere", "Elsewhere", `Read about cert-manager clusterissuer for let's encrypt [cert-manager ClusterIssuer for Let's Encrypt](/blog/certs). ${filler(300)}`));
    const p = plan({}, docs).planned.find((x) => x.target === "/blog/certs");
    if (p) expect(p.anchor.toLowerCase()).not.toBe("cert-manager clusterissuer for let's encrypt");
  });

  it("prefers orphans and tutorial-path targets, and explains why", () => {
    const r = plan();
    const first = r.planned[0]!;
    expect(first.reasons.join(" ")).toMatch(/orphan|prerequisite|series/);
    const cert = r.planned.find((p) => p.target === "/blog/certs");
    expect(cert?.reasons.join(" ")).toMatch(/prerequisite/); // earlier article, same topic
    const series = [doc("/blog/tools-part-2", "Kubernetes tools part 2", `This part continues the series. ${filler(300)} The kubernetes essential tools overview from before. ${filler(300)}`), doc("/blog/tools-part-1", "Kubernetes essential tools overview", `kubernetes essential tools overview ${filler(300)}`)];
    const s = L.planLinks(series[0]!, series, L.linkGraph(series), L.tfidf(series), limits, new Map());
    expect(s.planned[0]?.reasons.join(" ")).toMatch(/previous part of this series/);
  });

  it("raising the relevance cutoff removes weak candidates", () => {
    expect(plan({ minRelevance: 0.99 }).planned).toEqual([]);
  });

  it("builds the link graph: inbound counts, outbound targets, anchors per target", () => {
    const g = L.linkGraph(corpus());
    expect(g.inbound.get("/blog/existing")).toBe(1);
    expect(g.inbound.get("/blog/certs")).toBe(0);
    expect(g.outbound.get("/blog/source")).toEqual(["/blog/existing"]);
    expect([...g.anchorsByTarget.get("/blog/existing")!]).toEqual(["prometheus alerting rules"]);
  });
});

describe("internal links in the draft pipeline (DB)", () => {
  it("links-only recommendation → draft with rule-based link changes, no Claude call; they validate and publish", async () => {
    const { freshDb } = await import("./db-helpers");
    const { schema } = await import("@/db");
    const { settingsInput } = await import("./seo-fixtures");
    const { seedArticle, seedRecommendation, fakeAnthropic } = await import("./seo-v2-fixtures");
    const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
    const drafts = await import("@/lib/seo-intel/drafts");
    const pub = await import("@/lib/seo-intel/publish");
    const db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
    await saveSeoSettings(settingsInput(), "admin");
    const docs = corpus();
    const ids: Record<string, string> = {};
    for (const d of docs) {
      const slug = d.path.split("/").pop()!;
      ids[d.path] = (await seedArticle(db, { slug, title: d.title, seoTitle: null, body: d.body.replace(/!\[[^\]]*\]\([^)]*\) /, "") })).id;
    }
    await seedRecommendation(db, ids["/blog/source"]!, "internal_links");
    const api = fakeAnthropic({ answers: [] });
    const r = await drafts.generateDraft(ids["/blog/source"]!, { fetchImpl: api.fetchImpl });
    expect(api.calls).toHaveLength(0);
    expect(r.status).toBe("ready_for_review");
    const d = (await drafts.getDraft(r.draftId!))!;
    expect(d.changes.length).toBeGreaterThan(0);
    expect(d.changes.every((c) => c.type === "internal_link" && c.origin === "rules" && c.target)).toBe(true);
    for (const c of d.changes) await drafts.decideChange(d.id, c.id, "accepted");
    const admin = { id: "admin", role: "admin" as const, label: "admin@example.com" };
    await expect(pub.approveDraft(d.id, admin)).resolves.toMatchObject({ status: "published", substantive: false });
    const body = (await db.select().from(schema.post)).find((p) => p.id === ids["/blog/source"])!.body;
    for (const c of d.changes) expect(body).toContain(`[${c.before}](${c.target})`);
    // a second draft for the same source does not re-link the same targets
    const again = L.planLinks({ ...docs[0]!, body }, docs, L.linkGraph(docs), L.tfidf(docs), limits, new Map());
    expect(again.planned.map((p) => p.target).filter((t) => d.changes.some((c) => c.target === t))).toEqual([]);
  });
});
