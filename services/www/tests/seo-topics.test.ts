import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { seedArticle } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { buildCandidates, dismissTopic, listTopics, runTopicDiscovery, topicKey, topicToCalendar } = await import("@/lib/seo-intel/topics/discover");
const { dataForSeoDifficulty, proxyDifficulty } = await import("@/lib/seo-intel/topics/difficulty");
const { DEFAULT_TOPICS_SETTINGS, getTopicsSettings, mergeTopicsSettings, saveTopicsSettings } = await import("@/lib/seo-intel/topics/settings");
const { collectTrends, xPosts } = await import("@/lib/seo-intel/topics/sources");
const { JOB_TYPES } = await import("@/lib/seo-intel/jobs");

/**
 * Topic discovery (docs/seo/TOPICS.md): the deterministic grouping and score, the difficulty proxy and the DataForSEO
 * connector, the trend collectors (fake HTTP), and candidates in the database up to the editorial calendar. All data is
 * invented test data; no network, no model.
 */
const NOW = new Date("2026-11-10T00:00:00Z");
const YESTERDAY = "2026-11-09T00:00:00.000Z";
const SETTINGS = { ...DEFAULT_TOPICS_SETTINGS, minScore: 0 };
const SITE = ["Kubernetes ingress TLS with cert-manager", "Terraform state locking on AWS"];
const KEYWORDS = [
  { query: "kong gateway kubernetes minikube setup", impressions: 400, clicks: 2, position: 22 },
  { query: "kong gateway minikube kubernetes install", impressions: 100, clicks: 0, position: 30 },
  { query: "kubernetes ingress tls cert-manager", impressions: 900, clicks: 4, position: 12 }, // the site has this article
  { query: "best pizza near me", impressions: 5000, clicks: 0, position: 40 }, // not a subject of the site
  { query: "terraform", impressions: 800, clicks: 1, position: 15 }, // one word: too broad to be a topic
  { query: "aws eks karpenter", impressions: 10, clicks: 0, position: 20 }, // below the impressions floor
  { query: "terraform aws state", impressions: 600, clicks: 90, position: 3 }, // already ranks in the top 8
];
const sig = (source: "hackernews" | "devto" | "github" | "reddit" | "x", externalId: string, title: string, score: number, comments: number) => ({ source, externalId, title, url: `https://example.org/${externalId}`, score, comments, postedAt: YESTERDAY });
const SIGNALS = [
  sig("hackernews", "hn1", "Kong Gateway on Kubernetes: lessons from Minikube", 300, 80),
  sig("devto", "dev1", "MCP servers for AI agents in production", 150, 20),
  sig("github", "gh1", "acme/mcp-gateway: An MCP server gateway for AI agents", 500, 30),
  sig("hackernews", "hn2", "Show HN: my sourdough tracker", 900, 400),
];
const build = (over: Partial<Parameters<typeof buildCandidates>[0]> = {}) => buildCandidates({ keywords: KEYWORDS, signals: SIGNALS, siteTitles: SITE, taken: SITE, settings: SETTINGS, now: NOW, ...over });

describe("candidates: grouping, filtering and score (pure)", () => {
  it("groups query variants, attaches a matching trend, and drops what is off-subject, too broad, ranking or already written", () => {
    const out = build();
    expect(out.map((c) => c.kind)).toEqual(["both", "trend"]);
    const [kong, mcp] = out;
    expect(kong).toMatchObject({ title: "kong gateway kubernetes minikube setup", impressions: 500, position: 22, difficultySource: "proxy" });
    expect(kong!.queries).toEqual(["kong gateway kubernetes minikube setup", "kong gateway minikube kubernetes install"]);
    expect(kong!.signals.map((x) => x.externalId)).toEqual(["hn1"]);
    expect(mcp!.signals.map((x) => x.source).sort()).toEqual(["devto", "github"]);
    expect(mcp).toMatchObject({ impressions: 0, position: null });
    expect(out.every((c) => c.key === topicKey(c.title) && c.score >= 0 && c.score <= 100)).toBe(true);
  });

  it("scores search demand plus a trend above a trend alone, explains each number, and applies the minimum score", () => {
    const [kong, mcp] = build();
    expect(kong!.score).toBeGreaterThan(mcp!.score);
    expect(kong!.parts.demand).toBeGreaterThan(60);
    expect(mcp!.parts).toMatchObject({ demand: 0, fit: 0 });
    expect(mcp!.parts.trend).toBeGreaterThan(kong!.parts.trend); // two sources
    expect(kong!.parts.ease).toBe(100 - kong!.difficulty);
    expect(kong!.reasons.join(" ")).toMatch(/500 search impressions.*position 22\.0/);
    expect(kong!.reasons.join(" ")).toMatch(/1 trending item on Hacker News/);
    expect(kong!.reasons.join(" ")).toMatch(/Keyword difficulty \d+\/100 \(proxy: long-tail phrase/);
    const strict = build({ settings: { ...SETTINGS, minScore: 50 } });
    expect(strict.map((c) => c.title)).toEqual([kong!.title]);
  });

  it("respects switched-off sources, weights and the calendar", () => {
    expect(build({ settings: { ...SETTINGS, sources: { ...SETTINGS.sources, searchConsole: false } } }).every((c) => c.kind === "trend")).toBe(true);
    const easeOnly = build({ settings: { ...SETTINGS, weights: { demand: 0, trend: 0, fit: 0, ease: 100 } } });
    expect(easeOnly.every((c) => c.score === c.parts.ease)).toBe(true);
    expect(build({ taken: [...SITE, "Kong Gateway setup on Minikube Kubernetes"] }).map((c) => c.kind)).toEqual(["trend"]);
  });

  it("uses a measured difficulty when one is given", () => {
    const [kong] = build({ difficulty: new Map([["kong gateway kubernetes minikube setup", 12]]) });
    expect(kong).toMatchObject({ difficulty: 12, difficultySource: "dataforseo" });
    expect(kong!.parts.ease).toBe(88);
    expect(kong!.reasons.join(" ")).toContain("Keyword difficulty 12/100 (DataForSEO).");
  });
});

describe("difficulty: the proxy and DataForSEO", () => {
  it("proxy: long-tail phrases the site is close to are easier than head terms it has never covered", () => {
    const easy = proxyDifficulty({ words: 5, position: 14, fit: 0.8, trendOnly: false });
    const hard = proxyDifficulty({ words: 2, position: 70, fit: 0.1, trendOnly: false });
    expect(easy.value).toBeLessThan(hard.value);
    expect(easy.value).toBeGreaterThanOrEqual(5);
    expect(hard.value).toBeLessThanOrEqual(95);
    expect(easy.reasons).toContain("long-tail phrase");
    expect(proxyDifficulty({ words: 3, position: null, fit: 0.5, trendOnly: true }).reasons).toEqual(["no search data yet"]);
  });

  it("DataForSEO: off or without a login nothing is sent; on, one authenticated request returns difficulty per keyword", async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ tasks: [{ result: [{ items: [{ keyword: "kong gateway", keyword_difficulty: 31 }, { keyword: "broken", keyword_difficulty: null }] }] }] }), { status: 200 });
    }) as typeof fetch;
    const env = { DATAFORSEO_LOGIN: "me@example.com", DATAFORSEO_PASSWORD: "api-password" };
    expect(await dataForSeoDifficulty(["Kong Gateway"], SETTINGS, { fetchImpl, env })).toBeNull(); // switched off
    const on = { ...SETTINGS, dataForSeo: { ...SETTINGS.dataForSeo, enabled: true } };
    expect(await dataForSeoDifficulty(["Kong Gateway"], on, { fetchImpl, env: {} })).toBeNull(); // no login
    expect(calls).toEqual([]);
    const got = await dataForSeoDifficulty(["Kong Gateway", "kong gateway"], on, { fetchImpl, env });
    expect([...got!.entries()]).toEqual([["kong gateway", 31]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live", auth: `Basic ${Buffer.from("me@example.com:api-password").toString("base64")}`, body: [{ keywords: ["kong gateway"], location_code: 2840, language_code: "en" }] });
    const failing = (async () => new Response("no", { status: 402 })) as unknown as typeof fetch;
    expect(await dataForSeoDifficulty(["kong gateway"], on, { fetchImpl: failing, env })).toBeNull(); // the proxy is used
  });
});

/** Fake HTTP for the public APIs. Records every request; X answers only with the right bearer token. */
function fakeWeb(opts: { hnFails?: boolean } = {}) {
  const calls: { host: string; url: string; auth: string | null }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ host: url.host, url: url.toString(), auth });
    if (url.host === "hn.algolia.com") return opts.hnFails ? json({}, 503) : json({ hits: [{ objectID: "101", title: "Kong Gateway on Kubernetes: lessons from Minikube", url: "https://example.org/kong", points: 300, num_comments: 80, created_at: YESTERDAY }] });
    if (url.host === "dev.to") return json([{ id: 7, title: "Kubernetes operators in Go", url: "https://dev.to/a/kubernetes-operators", positive_reactions_count: 90, comments_count: 12, published_at: YESTERDAY }]);
    if (url.host === "api.github.com") return json({ items: [{ id: 55, full_name: "acme/kube-thing", description: "A Kubernetes thing", html_url: "https://github.com/acme/kube-thing", stargazers_count: 700, forks_count: 20, created_at: YESTERDAY }] });
    if (url.host === "api.x.com") return auth === "Bearer x-token" ? json({ data: [{ id: "1234567890", text: "Kubernetes 1.99 ships a new gateway feature https://t.co/abc", created_at: YESTERDAY, public_metrics: { like_count: 10, retweet_count: 5, reply_count: 2 } }, { id: "nope", text: "short" }] }) : json({}, 401);
    return json({}, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("trend collectors (fake HTTP)", () => {
  const one = { ...SETTINGS, terms: ["kubernetes"] };

  it("reads each enabled source, keeps only titles, links and counts, and reports a failing source without stopping", async () => {
    const web = fakeWeb();
    const res = await collectTrends({ ...one, sources: { ...one.sources, x: false } }, { fetchImpl: web.fetchImpl, now: NOW, env: {} });
    expect(Object.fromEntries(res.map((r) => [r.source, r.status]))).toEqual({ hackernews: "ok", devto: "ok", github: "ok", x: "off" });
    expect(res.flatMap((r) => r.signals)).toEqual([
      { source: "hackernews", externalId: "101", title: "Kong Gateway on Kubernetes: lessons from Minikube", url: "https://example.org/kong", score: 300, comments: 80, postedAt: YESTERDAY },
      { source: "devto", externalId: "7", title: "Kubernetes operators in Go", url: "https://dev.to/a/kubernetes-operators", score: 90, comments: 12, postedAt: YESTERDAY },
      { source: "github", externalId: "55", title: "acme/kube-thing: A Kubernetes thing", url: "https://github.com/acme/kube-thing", score: 700, comments: 20, postedAt: YESTERDAY },
    ]);
    expect(web.calls.every((c) => c.auth === null)).toBe(true); // no credential leaves for the key-less sources
    const broken = await collectTrends({ ...one, sources: { ...one.sources, x: false } }, { fetchImpl: fakeWeb({ hnFails: true }).fetchImpl, now: NOW, env: {} });
    expect(broken.find((r) => r.source === "hackernews")).toMatchObject({ status: "error", signals: [], error: "HTTP 503" });
    expect(broken.find((r) => r.source === "devto")!.status).toBe("ok");
  });

  it("X: skipped without a token, read with it (no author kept), and an auth failure is an error, not a crash", async () => {
    expect(await xPosts(one, { fetchImpl: fakeWeb().fetchImpl, env: {} })).toEqual({ source: "x", status: "not_configured", signals: [] });
    const web = fakeWeb();
    const ok = await xPosts(one, { fetchImpl: web.fetchImpl, env: { X_BEARER_TOKEN: "x-token" } });
    expect(ok).toEqual({ source: "x", status: "ok", signals: [{ source: "x", externalId: "1234567890", title: "Kubernetes 1.99 ships a new gateway feature", url: "https://x.com/i/status/1234567890", score: 20, comments: 2, postedAt: YESTERDAY }] });
    expect(new URL(web.calls[0]!.url).searchParams.get("query")).toBe("(kubernetes) lang:en -is:retweet -is:reply has:links");
    expect(await xPosts(one, { fetchImpl: fakeWeb().fetchImpl, env: { X_BEARER_TOKEN: "wrong" } })).toMatchObject({ status: "error", error: "HTTP 401" });
  });
});

describe("settings", () => {
  it("merge over the defaults, validate, and fall back when storage is invalid", async () => {
    await freshDb();
    expect(await getTopicsSettings()).toEqual(DEFAULT_TOPICS_SETTINGS);
    expect(DEFAULT_TOPICS_SETTINGS.sources.x).toBe(false);
    expect(DEFAULT_TOPICS_SETTINGS.dataForSeo.enabled).toBe(false);
    expect(mergeTopicsSettings({ minScore: 999 })).toEqual(DEFAULT_TOPICS_SETTINGS);
    expect(mergeTopicsSettings({ sources: { x: true } }).sources).toMatchObject({ x: true, hackernews: true });
    await expect(saveTopicsSettings({ ...DEFAULT_TOPICS_SETTINGS, terms: [] }, "u1")).rejects.toMatchObject({ issues: [expect.stringMatching(/^terms/)] });
    await expect(saveTopicsSettings({ ...DEFAULT_TOPICS_SETTINGS, weights: { demand: 0, trend: 0, fit: 0, ease: 0 } }, "u1")).rejects.toMatchObject({ issues: [expect.stringMatching(/weight/i)] });
  });
});

describe("discovery run and the editorial calendar (database)", () => {
  let db: Db;
  const now = new Date();
  const day = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const gsc = (query: string, impressions: number, position: number) =>
    db.execute(sql`insert into seo_gsc_query_daily (date, page, query, search_type, device, country, clicks, impressions, ctr, position) values (${day}::date, 'https://jithendar.com/', ${query}, 'web', 'DESKTOP', 'usa', 0, ${impressions}, 0, ${position})`);
  const only = { ...DEFAULT_TOPICS_SETTINGS, terms: ["kubernetes", "kong"], minScore: 0, sources: { searchConsole: true, hackernews: true, devto: false, github: false, reddit: true, x: false } };

  beforeEach(async () => {
    db = await freshDb();
    await seedArticle(db, { slug: "ingress-tls", title: "Kubernetes ingress TLS with cert-manager" });
    await gsc("kong gateway kubernetes minikube setup", 400, 22);
    await gsc("kong gateway minikube kubernetes install", 100, 30);
    await gsc("kubernetes ingress tls cert-manager", 900, 12);
  });

  it("is a registered job type and does nothing while switched off", async () => {
    expect(JOB_TYPES).toContain("topic_discovery");
    await db.execute(sql`insert into setting (key, value) values ('topics', ${JSON.stringify({ ...only, enabled: false })}::jsonb)`);
    const web = fakeWeb();
    expect(await runTopicDiscovery(db, { fetchImpl: web.fetchImpl, now, env: {} })).toMatchObject({ status: "skipped", candidates: 0 });
    expect(web.calls).toEqual([]);
  });

  it("stores signals and scored candidates, sends one to the calendar with its reasons, and never lists it again", async () => {
    await db.execute(sql`insert into setting (key, value) values ('topics', ${JSON.stringify(only)}::jsonb)`);
    await db.execute(sql`insert into seo_promo_signals (source, external_id, community, title, url, score, comments) values ('reddit', 't3_x', 'kubernetes', 'Kong gateway on Minikube with Kubernetes: setup notes', 'https://www.reddit.com/r/kubernetes/comments/x/', 120, 30)`);
    const web = fakeWeb();
    const run = await runTopicDiscovery(db, { fetchImpl: web.fetchImpl, now, env: {} });
    expect(run).toMatchObject({ status: "succeeded", candidates: 1, difficulty: "proxy", sources: { hackernews: "ok", devto: "off", github: "off", x: "off", reddit: "ok", searchConsole: "ok" } });
    expect(new Set(web.calls.map((c) => c.host))).toEqual(new Set(["hn.algolia.com"]));
    expect(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_topic_signals`))[0]!.n).toBe(1);

    const [topic] = await listTopics(db);
    expect(topic).toMatchObject({ title: "kong gateway kubernetes minikube setup", kind: "both", status: "new", impressions: 500, calendarId: null });
    expect(topic!.signals.map((x) => x.source).sort()).toEqual(["hackernews", "reddit"]);

    const placed = await topicToCalendar(db, topic!.id);
    const [cal] = rowsOf<{ title: string; status: string; kind: string; target_date: string | null; brief: { notes: string; source: string; supportingQueries: string[]; topicId: string }; evidence: { url: string }[] }>(
      await db.execute(sql`select title, status, kind, target_date, brief, evidence from seo_editorial_calendar where id = ${placed!.calendarId}`),
    );
    expect(cal).toMatchObject({ title: "Kong gateway kubernetes minikube setup", status: "approved", kind: "measured", target_date: null });
    expect(cal!.brief).toMatchObject({ source: "topic_discovery", topicId: topic!.id, supportingQueries: ["kong gateway kubernetes minikube setup", "kong gateway minikube kubernetes install"] });
    expect(cal!.brief.notes).toMatch(/^From topic discovery \(score \d+(\.\d)?\/100\)\. 500 search impressions/);
    expect(cal!.evidence.map((e) => e.url)).toContain("https://example.org/kong");
    expect(await topicToCalendar(db, topic!.id)).toBeNull(); // only once
    expect(await listTopics(db)).toEqual([]);
    expect((await listTopics(db, "scheduled"))[0]).toMatchObject({ id: topic!.id, calendarId: placed!.calendarId });

    // The next run sees the calendar item and does not bring the topic back.
    expect(await runTopicDiscovery(db, { fetchImpl: web.fetchImpl, now, env: {} })).toMatchObject({ candidates: 0 });
    expect(await listTopics(db)).toEqual([]);
  });

  it("a dismissed topic stays dismissed, and a failing source makes the run partial", async () => {
    await db.execute(sql`insert into setting (key, value) values ('topics', ${JSON.stringify(only)}::jsonb)`);
    const run = await runTopicDiscovery(db, { fetchImpl: fakeWeb({ hnFails: true }).fetchImpl, now, env: {} });
    expect(run).toMatchObject({ status: "partial", candidates: 1, sources: { hackernews: "error" } });
    const [topic] = await listTopics(db);
    expect(topic!.kind).toBe("keyword");
    expect(await dismissTopic(db, topic!.id)).toBe(true);
    expect(await dismissTopic(db, topic!.id)).toBe(false);
    await runTopicDiscovery(db, { fetchImpl: fakeWeb().fetchImpl, now, env: {} });
    expect(await listTopics(db)).toEqual([]);
    expect((await listTopics(db, "dismissed")).map((t) => t.id)).toEqual([topic!.id]);
  });
});
