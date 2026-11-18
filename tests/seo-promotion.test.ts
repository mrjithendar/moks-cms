import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { seedArticle } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { CHANNELS, checkDraft, ideaFingerprint, matchThreads, promoLink, sameSubject, scoreChannels } = await import("@/lib/seo-intel/promotion/channels");
const { CHANNEL_IDS, DEFAULT_PROMOTION_SETTINGS, getPromotionSettings, mergePromotionSettings, savePromotionSettings } = await import("@/lib/seo-intel/promotion/settings");
const reddit = await import("@/lib/seo-intel/promotion/reddit");
const store = await import("@/lib/seo-intel/promotion/store");
const { handleCallback } = await import("@/lib/seo-agent/internal-server");

/**
 * Promotion (docs/seo/PROMOTION.md): the deterministic channel score and draft checks, the read-only Reddit client
 * (fake HTTP), opportunities and drafts in the database, content ideas with verified evidence, and the callback routes
 * the seo-agent's promotion flows use. All data is invented test data; no network, no model.
 */
const ORIGIN = new URL("https://jithendar.com");
const NOW = new Date("2026-11-10T00:00:00Z");
const CB_TOKEN = "c".repeat(40);
const THREAD = "https://www.reddit.com/r/kubernetes/comments/abc123/ingress_tls_pending/";
const env = { ...process.env };

const facts = (over: Partial<Parameters<typeof scoreChannels>[0]> = {}) => ({ title: "Ingress and TLS on Kubernetes", contentType: "tutorial", category: "kubernetes", tags: ["kubernetes"], words: 900, publishedAt: "2026-11-05T00:00:00Z", clicks28d: 0, ...over });
const thread = (title: string, url = THREAD, score = 120) => ({ community: "kubernetes", title, url, score, comments: 30 });

describe("channels: score, links and draft checks (pure)", () => {
  it("matches threads that share at least two subject words with the article", () => {
    const threads = [thread("Kubernetes ingress TLS certificate stays pending"), thread("Terraform state locking with S3", "https://www.reddit.com/r/Terraform/comments/zzz/x/")];
    expect(matchThreads(facts(), threads).map((t) => t.url)).toEqual([THREAD]);
  });

  it("scores every enabled channel, explains itself and rewards real signals", () => {
    const none = scoreChannels(facts(), [], [...CHANNEL_IDS], NOW);
    expect(none.map((s) => s.channel).sort()).toEqual([...CHANNEL_IDS].sort());
    expect(none.every((s) => s.score >= 0 && s.score <= 100)).toBe(true);
    const redditOf = (rows: typeof none) => rows.find((s) => s.channel === "reddit")!;
    const one = scoreChannels(facts(), [thread("a")], [...CHANNEL_IDS], NOW);
    const three = scoreChannels(facts(), [thread("a"), thread("b"), thread("c")], [...CHANNEL_IDS], NOW);
    expect(redditOf(one).score).toBeGreaterThan(redditOf(none).score);
    expect(redditOf(three).score).toBeGreaterThan(redditOf(one).score);
    expect(redditOf(none).reasons.join(" ")).toContain("No matching thread");
    // A first-hand account lifts Hacker News; search clicks lift every channel.
    const hn = (f: ReturnType<typeof facts>) => scoreChannels(f, [], ["hackernews"], NOW)[0]!.score;
    expect(hn(facts({ title: "How we replaced Traefik with Kong, and what broke" }))).toBeGreaterThan(hn(facts()));
    expect(hn(facts({ clicks28d: 120 }))).toBeGreaterThan(hn(facts()));
    // Only enabled channels are scored.
    expect(scoreChannels(facts(), [], ["x"], NOW).map((s) => s.channel)).toEqual(["x"]);
  });

  it("tags the article link per channel", () => {
    const link = promoLink(ORIGIN, "/blog/ingress-tls", "reddit", { utmMedium: "social", utmCampaign: "promotion" });
    expect(link).toBe("https://jithendar.com/blog/ingress-tls?utm_source=reddit&utm_medium=social&utm_campaign=promotion");
  });

  it("flags over-long posts, foreign links and a missing or misplaced article link", () => {
    const link = promoLink(ORIGIN, "/blog/ingress-tls", "x", { utmMedium: "social", utmCampaign: "promotion" });
    expect(checkDraft("x", { body: `TLS at the ingress, the short version. ${link}` }, link, ORIGIN)).toEqual([]);
    expect(checkDraft("x", { body: "x".repeat(300) }, link, ORIGIN).join(" ")).toMatch(/300 characters.*missing/s);
    expect(checkDraft("reddit", { title: "T", body: `See https://evil.example/x and ${link}` }, link, ORIGIN).join(" ")).toContain("not to this site");
    expect(checkDraft("reddit", { title: "T", body: `Following ${THREAD} here is ${link}` }, link, ORIGIN, [THREAD])).toEqual([]);
    expect(checkDraft("linkedin", { body: `Read it: ${link}` }, link, ORIGIN).join(" ")).toContain("first comment");
    expect(checkDraft("hackernews", { title: "t".repeat(81), body: "context" }, link, ORIGIN).join(" ")).toContain("80 characters");
    expect(Object.keys(CHANNELS).sort()).toEqual([...CHANNEL_IDS].sort());
  });

  it("fingerprints ideas by their words, not their order", () => {
    expect(ideaFingerprint("How to replace Traefik with Kong")).toBe(ideaFingerprint("Replace Traefik with Kong: how to"));
    expect(sameSubject("Ingress and TLS on Kubernetes", "Kubernetes ingress and TLS")).toBe(true);
    expect(sameSubject("Ingress and TLS on Kubernetes", "Terraform state on S3")).toBe(false);
  });
});

describe("reddit client (read-only, fake HTTP)", () => {
  const cfg = { clientId: "id", clientSecret: "secret", userAgent: "test-agent" };
  beforeEach(() => reddit._resetRedditToken());

  it("is not configured without the client id and secret", () => {
    expect(reddit.redditConfig({})).toBeNull();
    expect(reddit.redditConfig({ REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b" })).toMatchObject({ clientId: "a", clientSecret: "b" });
  });

  it("gets an application token, then reads a listing; stickied and adult posts are left out", async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url: String(url), auth: h.get("authorization"), method: init?.method ?? "GET" });
      if (String(url).includes("/api/v1/access_token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return Response.json({
        data: {
          children: [
            { data: { id: "abc123", subreddit: "kubernetes", title: "Ingress TLS pending", permalink: "/r/kubernetes/comments/abc123/ingress_tls_pending/", score: 120, num_comments: 30, created_utc: 1_793_000_000 } },
            { data: { id: "sticky1", subreddit: "kubernetes", title: "Weekly thread", permalink: "/r/kubernetes/comments/sticky1/weekly/", score: 5, num_comments: 2, stickied: true } },
            { data: { id: "nsfw1", subreddit: "kubernetes", title: "x", permalink: "/r/kubernetes/comments/nsfw1/x/", score: 5, num_comments: 2, over_18: true } },
            { data: { id: "bad id!", title: "no permalink" } },
          ],
        },
      });
    }) as typeof fetch;
    const threads = await reddit.topThreads("kubernetes", cfg, { fetchImpl });
    expect(threads).toEqual([{ id: "abc123", community: "kubernetes", title: "Ingress TLS pending", url: THREAD, score: 120, comments: 30, postedAt: new Date(1_793_000_000_000).toISOString() }]);
    expect(calls[0]).toMatchObject({ method: "POST", auth: `Basic ${Buffer.from("id:secret").toString("base64")}` });
    expect(calls[1]!.url).toContain("https://oauth.reddit.com/r/kubernetes/top?t=week");
    expect(calls[1]!.auth).toBe("Bearer tok");
    await reddit.topThreads("devops", cfg, { fetchImpl });
    expect(calls.filter((c) => c.url.includes("access_token"))).toHaveLength(1); // the token is reused
  });

  it("reports a refused client as an authentication error", async () => {
    const fetchImpl = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(reddit.topThreads("kubernetes", cfg, { fetchImpl })).rejects.toMatchObject({ kind: "auth_error" });
  });
});

describe("promotion store (database)", () => {
  let db: Db;
  let articleId: string;

  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
    await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
    Object.assign(process.env, { SITE_URL: "https://jithendar.com", SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN });
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    articleId = (await seedArticle(db)).id;
    await db.execute(sql`insert into seo_promo_signals (source, external_id, community, title, url, score, comments) values ('reddit', 'abc123', 'kubernetes', 'Kubernetes ingress TLS certificate stays pending', ${THREAD}, 120, 30)`);
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const statusOf = async (channel: string) => rowsOf<{ status: string; edited_by: string | null; draft_flags: unknown }>(await db.execute(sql`select status, edited_by, draft_flags from seo_promo_opportunities where article_id = ${articleId} and channel = ${channel}`))[0]!;

  it("settings: every channel is on by default; invalid input is refused; bad stored data falls back to defaults", async () => {
    const s = await getPromotionSettings();
    expect(s).toEqual(DEFAULT_PROMOTION_SETTINGS);
    expect(Object.values(s.channels).every(Boolean)).toBe(true);
    await expect(savePromotionSettings({ ...s, subreddits: ["r/kubernetes"] }, "admin")).rejects.toMatchObject({ status: 400 });
    const saved = await savePromotionSettings({ ...s, channels: { ...s.channels, x: false }, subreddits: ["kubernetes", "kubernetes", "devops"] }, "admin");
    expect(saved.after.subreddits).toEqual(["kubernetes", "devops"]);
    expect((await getPromotionSettings()).channels.x).toBe(false);
    expect(mergePromotionSettings({ minScore: "high" })).toEqual(DEFAULT_PROMOTION_SETTINGS);
  });

  it("scores an article's channels, stores them, and returns what to draft", async () => {
    const r = await store.refreshOpportunities({ articleId }, NOW);
    expect(r.enabled).toBe(true);
    const a = r.articles[0]!;
    expect(a).toMatchObject({ articleId, path: "/blog/ingress-tls", url: "https://jithendar.com/blog/ingress-tls" });
    expect(a.excerpt).not.toContain("```");
    const rows = rowsOf<{ channel: string; score: number; link: string }>(await db.execute(sql`select channel, score, link from seo_promo_opportunities where article_id = ${articleId}`));
    expect(rows.map((x) => x.channel).sort()).toEqual([...CHANNEL_IDS].sort());
    expect(rows.find((x) => x.channel === "reddit")!.link).toContain("utm_source=reddit");
    // Only channels at or above the threshold are drafted; each carries its own tagged link and guidance.
    const min = DEFAULT_PROMOTION_SETTINGS.minScore;
    expect(a.channels.length).toBeGreaterThan(0);
    expect(a.channels.every((c) => c.score >= min && c.link.includes(`utm_source=${c.channel}`) && c.guidance.length > 0)).toBe(true);
    expect(rows.filter((x) => Number(x.score) >= min).map((x) => x.channel).sort()).toEqual(a.channels.map((c) => c.channel).sort());
    expect(a.channels.find((c) => c.channel === "reddit")?.threads).toEqual([{ community: "kubernetes", title: "Kubernetes ingress TLS certificate stays pending", url: THREAD }]);
    // Scheduled runs pick only articles without opportunities.
    expect((await store.refreshOpportunities({}, NOW)).articles).toEqual([]);
  });

  it("refuses drafts and unpublished articles, and does nothing when switched off", async () => {
    await db.execute(sql`update post set status = 'draft' where id = ${articleId}`);
    await expect(store.refreshOpportunities({ articleId }, NOW)).rejects.toMatchObject({ status: 409 });
    await savePromotionSettings({ ...DEFAULT_PROMOTION_SETTINGS, enabled: false }, "admin");
    expect(await store.refreshOpportunities({ articleId }, NOW)).toEqual({ enabled: false, articles: [] });
  });

  it("stores drafts for review, keeps a person's edits, and records posting", async () => {
    const ctx = (await store.refreshOpportunities({ articleId }, NOW)).articles[0]!;
    const target = ctx.channels.find((c) => c.channel === "reddit")!;
    const saved = await store.saveDrafts(articleId, { runId: "run-1", posts: [{ channel: "reddit", title: "TLS at a Kubernetes ingress with cert-manager", body: `What worked for me. Full write-up: ${target.link}`, notes: "Check the self-promotion rule." }, { channel: "linkedin", title: "ignored", body: `Read it here ${ctx.channels.find((c) => c.channel === "linkedin")!.link}` }] });
    expect(saved).toEqual({ saved: 2, skipped: 0 });
    expect(await statusOf("reddit")).toMatchObject({ status: "drafted", edited_by: null });
    const listed = await store.listOpportunities({ status: "drafted" });
    const li = listed[0]!.opportunities.find((o) => o.channel === "linkedin")!;
    expect(li.draftTitle).toBeNull(); // LinkedIn has no title field
    expect(li.flags.join(" ")).toContain("first comment"); // the link belongs in a comment there
    const rd = listed[0]!.opportunities.find((o) => o.channel === "reddit")!;
    expect(rd.flags).toEqual([]);
    expect(rd.threads[0]!.url).toBe(THREAD);

    // A person edits the Reddit draft: a later machine run must not overwrite it or offer it for redrafting.
    await store.updateOpportunity(rd.id, { action: "save", title: "My title", body: `My words. ${target.link}` }, "admin@example.com");
    expect((await statusOf("reddit")).edited_by).toBe("admin@example.com");
    expect(await store.saveDrafts(articleId, { posts: [{ channel: "reddit", title: "Machine", body: "Machine text" }] })).toEqual({ saved: 0, skipped: 1 });
    const again = (await store.refreshOpportunities({ articleId }, NOW)).articles[0]!;
    expect(again.channels.map((c) => c.channel)).not.toContain("reddit");
    expect(again.channels.map((c) => c.channel)).toContain("linkedin"); // an unedited machine draft may be redrafted

    // Posting is the person's act; the system only records it. Reopen brings the draft back.
    await expect(store.updateOpportunity(rd.id, { action: "posted", postedUrl: "https://www.reddit.com/r/kubernetes/comments/new/mine/" }, "admin@example.com")).resolves.toMatchObject({ after: { status: "posted" } });
    await expect(store.updateOpportunity(rd.id, { action: "save", body: "edit after posting" }, "admin@example.com")).rejects.toMatchObject({ status: 409 });
    expect((await store.promotionCounts()).posted).toBe(1);
    await expect(store.updateOpportunity(rd.id, { action: "reopen" }, "admin@example.com")).resolves.toMatchObject({ after: { status: "drafted" } });
    await store.updateOpportunity(li.id, { action: "dismiss" }, "admin@example.com");
    expect(await store.saveDrafts(articleId, { posts: [{ channel: "linkedin", body: "again" }] })).toEqual({ saved: 0, skipped: 1 });
  });

  describe("content ideas", () => {
    const QUERY = "kong gateway minikube";
    const idea = (title: string, evidence: { type: "gsc_query" | "gsc_topic" | "reddit"; value: string }[]) => ({ title, angle: "A first-hand migration.", outline: ["Why", "How", "What broke"], target_query: QUERY, channels: ["reddit", "tiktok"], evidence });

    beforeEach(async () => {
      for (const d of ["2026-11-06", "2026-11-07", "2026-11-08"]) {
        await db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr, position) values (${d}, 'https://jithendar.com/blog/other', ${QUERY}, 'web', 'desktop', 'ind', 1, 50, 0.02, 14)`);
      }
    });

    it("offers only the site's own signals to the strategist", async () => {
      const s = await store.ideaSignals();
      expect(s.enabled).toBe(true);
      if (!s.enabled) return;
      expect(s.gsc.queries).toEqual([{ query: QUERY, impressions: 150, position: 14 }]);
      expect(s.reddit).toEqual([{ community: "kubernetes", title: "Kubernetes ingress TLS certificate stays pending", url: THREAD, score: 120, comments: 30 }]);
      expect(s.covered).toContain("Ingress and TLS on Kubernetes");
      expect(s.max).toBe(DEFAULT_PROMOTION_SETTINGS.ideasPerRun);
    });

    it("stores an idea only with verified evidence, never a repeat of published or suggested content", async () => {
      const input = store.ideasSchema.parse({
        runId: "run-2",
        ideas: [
          idea("Replacing Traefik with Kong Gateway on Minikube", [{ type: "gsc_query", value: QUERY }, { type: "reddit", value: THREAD }, { type: "reddit", value: "https://www.reddit.com/r/invented/comments/nope/" }]),
          idea("An article resting on invented evidence", [{ type: "gsc_query", value: "a query nobody typed" }]),
          idea("Kubernetes ingress and TLS", [{ type: "gsc_query", value: QUERY }]),
        ],
      });
      const r = await store.saveIdeas(input);
      expect(r.saved).toBe(1);
      expect(r.skipped.map((x) => x.reason)).toEqual(["no verified evidence", "already published"]);
      const [i] = await store.listIdeas();
      expect(i).toMatchObject({ title: "Replacing Traefik with Kong Gateway on Minikube", source: "mixed", status: "new", targetQuery: QUERY });
      expect(i!.signals.map((x) => x.type)).toEqual(["gsc_query", "reddit"]); // the invented thread was dropped
      expect(i!.channels.map((c) => c.id)).toEqual(["reddit"]); // unknown channel ids are dropped
      expect(i!.score).toBe(store.ideaScore(i!.signals));
      expect((await store.saveIdeas(input)).saved).toBe(0); // the same ideas again: nothing new

      // Dismissed ideas stay dismissed (their fingerprint remains), and can be restored.
      expect(await store.updateIdea(i!.id, "dismiss")).toEqual({ status: "dismissed" });
      expect(await store.listIdeas()).toEqual([]);
      expect((await store.saveIdeas(input)).saved).toBe(0);
      expect(await store.updateIdea(i!.id, "restore")).toEqual({ status: "new" });

      // "Add to editorial calendar": an approved calendar item with the brief; the idea is marked sent, once.
      const sent = await store.updateIdea(i!.id, "calendar");
      expect(sent.status).toBe("sent");
      const [cal] = rowsOf<{ title: string; status: string; kind: string; brief: unknown }>(await db.execute(sql`select title, status, kind, brief from seo_editorial_calendar where id = ${sent.calendarId!}`));
      const brief = (typeof cal!.brief === "string" ? JSON.parse(cal!.brief) : cal!.brief) as { outline: string[]; supportingQueries: string[]; gap: string; notes: string };
      expect(cal).toMatchObject({ title: "Replacing Traefik with Kong Gateway on Minikube", status: "approved", kind: "editorial_idea" });
      expect(brief).toMatchObject({ outline: ["Why", "How", "What broke"], supportingQueries: [QUERY], gap: "A first-hand migration." });
      expect(brief.notes).toContain(THREAD);
      expect(await store.updateIdea(i!.id, "calendar")).toEqual({ status: "sent", calendarId: sent.calendarId });
      await expect(store.updateIdea(i!.id, "dismiss")).rejects.toMatchObject({ status: 409 });
      expect((await store.listIdeas({ status: "sent" }))[0]!.calendarId).toBe(sent.calendarId);
    });
  });

  describe("callback routes for the seo-agent", () => {
    const cb = (path: string, body?: unknown, token = CB_TOKEN) => handleCallback("POST", `/internal/seo-agent${path}`, `Bearer ${token}`, body, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN });

    it("requires the callback token", async () => {
      expect((await cb("/promotion/collect", {}, "x".repeat(40))).status).toBe(401);
    });

    it("collect works without Reddit credentials and says so; drafts and ideas are validated", async () => {
      const c = await cb("/promotion/collect", { articleId });
      expect(c.status).toBe(200);
      const body = c.body as { enabled: boolean; articles: { articleId: string; channels: { channel: string; link: string }[] }[]; reddit: { status: string } };
      expect(body.reddit.status).toBe("not_configured");
      expect(body.articles[0]!.articleId).toBe(articleId);
      const ch = body.articles[0]!.channels[0]!;
      const ok = await cb(`/promotion/articles/${articleId}/drafts`, { runId: "r", posts: [{ channel: ch.channel, title: "A title", body: `Text ${ch.link}` }] });
      expect(ok).toMatchObject({ status: 200, body: { saved: 1, skipped: 0 } });
      expect((await cb(`/promotion/articles/${articleId}/drafts`, { posts: [{ channel: "tiktok", body: "x" }] })).status).toBe(400);
      expect((await cb("/promotion/articles/not-a-uuid/drafts", { posts: [] })).status).toBe(400);
      expect((await cb("/promotion/collect", { articleId: "not-a-uuid" })).status).toBe(400);
      const sig = await cb("/promotion/ideas/signals", {});
      expect(sig).toMatchObject({ status: 200, body: { enabled: true, redditSync: { status: "not_configured" } } });
      expect(await cb("/promotion/ideas", { ideas: [{ title: "An idea with nothing behind it", evidence: [] }] })).toMatchObject({ status: 200, body: { saved: 0 } });
      expect((await cb("/promotion/ideas", { ideas: [{ title: "short" }] })).status).toBe(400);
    });
  });
});
