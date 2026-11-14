import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
const revalidated: string[] = [];
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const as = (role: "admin" | "author" | "user", id: string = role): SessionUser => ({ id, name: role, email: `${id}@example.com`, role, emailVerified: true, image: null, sessionCreatedAt: new Date() });

const settings = await import("@/lib/seo-agent/ask-settings");
const { DEFAULT_ASK_SETTINGS, saveAskSettings, getAskSettings, mergeAskSettings, askState, AskSettingsError, ASK_SETTINGS_KEY } = settings;

/**
 * Ask the Blog admin settings (Admin → Automation & AI): the stored document, the two switches, the audience gate on
 * /api/ask (signed-in readers only vs everyone) and the admin API. The agent's side is tested in
 * services/seo-agent/tests/test_ask_and_chunks.py.
 */
let db: Db;
let agentCalls = 0;
beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([as("admin"), as("author"), as("user")].map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  currentUser = null;
  agentCalls = 0;
  revalidated.length = 0;
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
  vi.stubEnv("SEO_AGENT_TOKEN", "a".repeat(40));
  vi.stubGlobal("fetch", (async () => {
    agentCalls++;
    return new Response('event: final\ndata: {"outcome":"answered","answer":"x [1]","citations":[]}\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch);
});
afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const save = (patch: Partial<typeof DEFAULT_ASK_SETTINGS>) => saveAskSettings({ ...DEFAULT_ASK_SETTINGS, ...patch }, "admin");
/** `ip` is the right-most X-Forwarded-For hop: the one the gateway appended, which the limiter trusts. */
const ask = async (question: string, ip = "203.0.113.9") => {
  const { POST } = await import("@/app/api/ask/route");
  return POST(new Request("https://jithendar.com/api/ask", { method: "POST", headers: { "content-type": "application/json", origin: "https://jithendar.com", host: "jithendar.com", "x-forwarded-for": `10.9.9.9, ${ip}` }, body: JSON.stringify({ question }) }));
};
const status = async () => {
  const { GET } = await import("@/app/api/ask/route");
  return (await (await GET()).json()) as { enabled: boolean; audience?: string; signedIn?: boolean | null };
};

describe("settings document", () => {
  it("defaults to off and signed-in readers only", async () => {
    expect(DEFAULT_ASK_SETTINGS).toMatchObject({ enabled: false, audience: "members", placement: { home: true, articles: true }, answerLength: "standard" });
    expect(await getAskSettings()).toEqual(DEFAULT_ASK_SETTINGS);
  });

  it("merges a partial row over the defaults; a row that does not validate can never switch it on", async () => {
    expect(mergeAskSettings({ enabled: true, copy: { button: "Ask me" } })).toMatchObject({ enabled: true, audience: "members", copy: { button: "Ask me", intro: DEFAULT_ASK_SETTINGS.copy.intro } });
    expect(mergeAskSettings({ enabled: true, audience: "admins" })).toEqual(DEFAULT_ASK_SETTINGS);
    expect(mergeAskSettings("on")).toEqual(DEFAULT_ASK_SETTINGS);
    await db.insert(schema.setting).values({ key: ASK_SETTINGS_KEY, value: { enabled: "yes" } });
    expect((await getAskSettings()).enabled).toBe(false);
  });

  it("validates what an admin saves", async () => {
    const issues = async (patch: Record<string, unknown>) => {
      try {
        await saveAskSettings({ ...DEFAULT_ASK_SETTINGS, ...patch }, "admin");
        return [];
      } catch (e) {
        expect(e).toBeInstanceOf(AskSettingsError);
        return (e as InstanceType<typeof AskSettingsError>).issues;
      }
    };
    expect((await issues({ audience: "admins" })).join()).toContain("audience");
    expect((await issues({ limits: { perMinute: 10, perDay: 5, maxQuestion: 500 } })).join()).toContain("limits.perDay");
    expect((await issues({ limits: { perMinute: 6, perDay: 60, maxQuestion: 5000 } })).join()).toContain("limits.maxQuestion");
    expect((await issues({ dailyBudgetUsd: 500 })).join()).toContain("dailyBudgetUsd");
    expect((await issues({ copy: { ...DEFAULT_ASK_SETTINGS.copy, examples: ["one?", "two?", "three?", "four?", "five?"] } })).join()).toContain("copy.examples");
    expect((await issues({ copy: { ...DEFAULT_ASK_SETTINGS.copy, examples: ["Same question?", "same question?"] } })).join()).toContain("copy.examples");
    expect((await issues({ copy: { ...DEFAULT_ASK_SETTINGS.copy, intro: "two\nlines" } })).join()).toContain("copy.intro");
    expect(await getAskSettings()).toEqual(DEFAULT_ASK_SETTINGS); // nothing invalid was stored
    const { before, after } = await save({ enabled: true, audience: "everyone", answerLength: "short" });
    expect(before.enabled).toBe(false);
    expect(after).toMatchObject({ enabled: true, audience: "everyone", answerLength: "short" });
    expect(await getAskSettings()).toEqual(after);
  });
});

describe("the two switches", () => {
  it("needs the environment switch and the admin's switch; with the environment off the database is not read", async () => {
    await save({ enabled: true, audience: "everyone" });
    expect(await askState({})).toMatchObject({ on: false, envOn: false });
    setDbForTests(undefined); // no database at all: still answers "off" instead of throwing
    expect((await askState({ ASK_BLOG_ENABLED: "false" })).on).toBe(false);
    setDbForTests(db);
    expect(await askState({ ASK_BLOG_ENABLED: "true" })).toMatchObject({ on: true, envOn: true });
    await save({ enabled: false });
    expect(await askState({ ASK_BLOG_ENABLED: "true" })).toMatchObject({ on: false, envOn: true });
  });

  it("/api/ask is 404 and reports disabled until both are on", async () => {
    vi.stubEnv("ASK_BLOG_ENABLED", "true");
    expect((await ask("How does cert-manager renew?")).status).toBe(404);
    expect(await status()).toEqual({ enabled: false });
    await save({ enabled: true, audience: "everyone" });
    expect((await ask("How does cert-manager renew?")).status).toBe(200);
    expect(await status()).toEqual({ enabled: true, audience: "everyone", signedIn: null });
    vi.stubEnv("ASK_BLOG_ENABLED", "false");
    expect((await ask("How does cert-manager renew?")).status).toBe(404);
    expect(agentCalls).toBe(1);
  });
});

describe("who can use it", () => {
  beforeEach(() => vi.stubEnv("ASK_BLOG_ENABLED", "true"));

  it("signed-in readers only: 401 without a session, decided on the server before the agent is called", async () => {
    await save({ enabled: true, audience: "members" });
    expect(await status()).toEqual({ enabled: true, audience: "members", signedIn: false });
    const refused = await ask("How does cert-manager renew?");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "signin" });
    expect(agentCalls).toBe(0);
    currentUser = as("user");
    expect(await status()).toEqual({ enabled: true, audience: "members", signedIn: true });
    const ok = await ask("How does cert-manager renew?");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("event: final");
    expect(agentCalls).toBe(1);
  });

  it("signed-in readers only: the limit counts per account, so a new IP address does not reset it", async () => {
    await save({ enabled: true, audience: "members", limits: { perMinute: 2, perDay: 60, maxQuestion: 500 } });
    currentUser = as("user");
    expect((await ask("one?", "198.51.100.1")).status).toBe(200);
    expect((await ask("two?", "198.51.100.2")).status).toBe(200);
    expect((await ask("three?", "198.51.100.3")).status).toBe(429);
    currentUser = as("user", "another-reader"); // someone else is not affected
    expect((await ask("four?", "198.51.100.4")).status).toBe(200);
  });

  it("everyone: no session needed; the saved limits and question length apply", async () => {
    await save({ enabled: true, audience: "everyone", limits: { perMinute: 1, perDay: 60, maxQuestion: 50 } });
    const long = await ask("x".repeat(51));
    expect(long.status).toBe(400);
    expect((await long.json()).error).toContain("50");
    expect((await ask("How does cert-manager renew?")).status).toBe(200);
    expect((await ask("And again?")).status).toBe(429);
  });
});

describe("admin API", () => {
  const put = async (body: unknown) => {
    const { PUT } = await import("@/app/api/admin/seo/ask-blog/route");
    return PUT(new Request("https://jithendar.com/api/admin/seo/ask-blog", { method: "PUT", headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) }));
  };

  it("admins save the document (validated, audit-logged, pages revalidated); everyone else is refused", async () => {
    expect((await put({ ...DEFAULT_ASK_SETTINGS, enabled: true })).status).toBe(401);
    currentUser = as("author");
    expect((await put({ ...DEFAULT_ASK_SETTINGS, enabled: true })).status).toBe(403);
    currentUser = as("admin");
    const invalid = await put({ ...DEFAULT_ASK_SETTINGS, audience: "nobody" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).issues.join()).toContain("audience");
    expect((await getAskSettings()).enabled).toBe(false);
    const ok = await put({ ...DEFAULT_ASK_SETTINGS, enabled: true, audience: "everyone", copy: { ...DEFAULT_ASK_SETTINGS.copy, examples: ["How do I renew certificates?"] } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).settings).toMatchObject({ enabled: true, audience: "everyone" });
    expect(revalidated).toEqual(["/"]);
    const logs = await db.select().from(schema.auditLog);
    const entry = logs.find((l) => l.action === "seo.ask_blog.update");
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry!.detail)).toContain('"before"');
    const { GET } = await import("@/app/api/admin/seo/ask-blog/route");
    const view = (await (await GET(new Request("https://jithendar.com/api/admin/seo/ask-blog"))).json()) as { settings: { enabled: boolean }; envEnabled: boolean; status: { week: { total: number }; openGaps: number } | null };
    expect(view).toMatchObject({ settings: { enabled: true }, envEnabled: false });
    expect(view.status).toMatchObject({ week: { total: 0 }, openGaps: 0, spentTodayUsd: 0 });
  });
});

describe("sitewide chat (D-90)", () => {
  beforeEach(() => vi.stubEnv("ASK_BLOG_ENABLED", "true"));

  /** The last body the web app sent to the agent. */
  let sent: Record<string, unknown> | null = null;
  beforeEach(() => {
    sent = null;
    vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
      agentCalls++;
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response('event: final\ndata: {"outcome":"answered","answer":"x [1]","citations":[],"feedback_token":"ab"}\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);
  });
  const post = async (body: unknown, path = "/api/ask", origin = "https://jithendar.com") => {
    const mod = path === "/api/ask" ? await import("@/app/api/ask/route") : await import("@/app/api/ask/feedback/route");
    return mod.POST(new Request(`https://jithendar.com${path}`, { method: "POST", headers: { "content-type": "application/json", origin, host: "jithendar.com", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) }));
  };
  const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ q: `Question ${i}?`, a: `Answer ${i} [1].` }));

  it("defaults: on every page, follow-ups, page context, kept threads and feedback all on", () => {
    expect(DEFAULT_ASK_SETTINGS.sitewide).toEqual({ enabled: true, launcher: "pill", hideOn: [] });
    expect(DEFAULT_ASK_SETTINGS.conversation).toEqual({ followUps: true, turns: 3, keepThread: true, pageContext: true, feedback: true });
  });

  it("a row saved before these blocks existed keeps validating and gets their defaults", async () => {
    const old = { enabled: true, audience: "everyone", placement: { home: false, articles: true } };
    expect(mergeAskSettings(old)).toMatchObject({ enabled: true, audience: "everyone", placement: { home: false, articles: true }, sitewide: DEFAULT_ASK_SETTINGS.sitewide, conversation: DEFAULT_ASK_SETTINGS.conversation });
    expect(mergeAskSettings({ enabled: true, conversation: { turns: 2 } }).conversation).toEqual({ ...DEFAULT_ASK_SETTINGS.conversation, turns: 2 });
  });

  it("validates hidden paths and turns; removes '/' and duplicates", async () => {
    const bad = async (patch: Record<string, unknown>) => {
      try {
        await save(patch);
        return "";
      } catch (e) {
        return (e as InstanceType<typeof AskSettingsError>).issues.join();
      }
    };
    expect(await bad({ sitewide: { enabled: true, launcher: "pill", hideOn: ["python-practice"] } })).toContain("sitewide.hideOn");
    expect(await bad({ sitewide: { enabled: true, launcher: "bubble", hideOn: [] } })).toContain("sitewide.launcher");
    expect(await bad({ conversation: { ...DEFAULT_ASK_SETTINGS.conversation, turns: 9 } })).toContain("conversation.turns");
    const { after } = await save({ sitewide: { enabled: true, launcher: "icon", hideOn: ["/python-practice", "/", "/python-practice"] } });
    expect(after.sitewide).toEqual({ enabled: true, launcher: "icon", hideOn: ["/python-practice"] });
  });

  it("hidden paths match whole path segments, and the fixed list always applies", async () => {
    const { askHiddenOn } = await import("@/components/ask/types");
    expect(askHiddenOn("/admin/automation", [])).toBe(true);
    expect(askHiddenOn("/login", [])).toBe(true);
    expect(askHiddenOn("/blog/x", [])).toBe(false);
    expect(askHiddenOn("/python-practice/two-sum", ["/python-practice"])).toBe(true);
    expect(askHiddenOn("/python-practiced", ["/python-practice"])).toBe(false);
    expect(askHiddenOn("/projects", ["/projects/"])).toBe(true);
  });

  it("the open article is read from /blog/<slug> only", async () => {
    const { articleSlug } = await import("@/components/ask/types");
    expect(articleSlug("/blog/lets-encrypt-k3s")).toBe("lets-encrypt-k3s");
    expect(articleSlug("/blog")).toBeNull();
    expect(articleSlug("/blog/page/2")).toBeNull();
    expect(articleSlug("/tag/kubernetes")).toBeNull();
  });

  it("forwards the last turns and the article to the agent, as far as the admin allows", async () => {
    await save({ enabled: true, audience: "everyone", conversation: { ...DEFAULT_ASK_SETTINGS.conversation, turns: 2 } });
    expect((await post({ question: "And then?", history: turns(4), context: { slug: "lets-encrypt-k3s" } })).status).toBe(200);
    expect(sent).toMatchObject({ question: "And then?", history: turns(4).slice(-2), context_slug: "lets-encrypt-k3s" });
    await save({ enabled: true, audience: "everyone", conversation: { ...DEFAULT_ASK_SETTINGS.conversation, followUps: false, pageContext: false } });
    expect((await post({ question: "And then?", history: turns(2), context: { slug: "lets-encrypt-k3s" } })).status).toBe(200);
    expect(sent).not.toHaveProperty("history");
    expect(sent).not.toHaveProperty("context_slug");
  });

  it("refuses malformed or oversized conversations before the agent is called", async () => {
    await save({ enabled: true, audience: "everyone" });
    expect((await post({ question: "And then?", history: turns(6) })).status).toBe(400);
    expect((await post({ question: "And then?", history: [{ q: "x?", a: "y".repeat(601) }] })).status).toBe(400);
    expect((await post({ question: "And then?", context: { slug: "../../etc" } })).status).toBe(400);
    expect((await post({ question: "And then?", junk: "z".repeat(9000) })).status).toBe(413);
    expect(agentCalls).toBe(0);
  });

  it("feedback: matched on the token, same-origin only, and off with its switch", async () => {
    await save({ enabled: true, audience: "everyone" });
    const token = "0123456789abcdef0123456789abcdef";
    await db.execute(sql`insert into seo_ask_log (question, normalized, outcome, feedback_token) values ('q', 'q', 'answered', ${token}), ('old', 'old', 'answered', ${"f".repeat(32)})`);
    await db.execute(sql`update seo_ask_log set at = now() - interval '2 days' where question = 'old'`);
    expect((await post({ token, helpful: true }, "/api/ask/feedback")).status).toBe(204);
    expect((await post({ token: "f".repeat(32), helpful: false }, "/api/ask/feedback")).status).toBe(204); // too old: ignored, same answer
    expect((await post({ token: "nope", helpful: true }, "/api/ask/feedback")).status).toBe(400);
    expect((await post({ token, helpful: false }, "/api/ask/feedback", "https://evil.example")).status).toBe(403);
    const rows = rowsOf<{ question: string; feedback: number | null }>(await db.execute(sql`select question, feedback from seo_ask_log order by question`));
    expect(rows).toEqual([{ question: "old", feedback: null }, { question: "q", feedback: 1 }]);
    const { loadAskStatus } = settings;
    expect((await loadAskStatus())?.week).toMatchObject({ helpful: 1, notHelpful: 0, followUps: 0 });
    await save({ enabled: true, audience: "everyone", conversation: { ...DEFAULT_ASK_SETTINGS.conversation, feedback: false } });
    expect((await post({ token, helpful: false }, "/api/ask/feedback")).status).toBe(404);
  });

  it("the widget sends only answered turns, newest last, with answers cut to 600 characters", async () => {
    const { historyFor } = await import("@/components/ask/thread");
    const t = (q: string, status: "done" | "error", outcome: string, text = "A [1].") => ({ id: q, q, status, outcome, text, citations: [], related: [] });
    const all = [t("one?", "done", "answered", "x".repeat(700)), t("two?", "error", "error"), t("three?", "done", "fallback", "There is no article on this yet."), t("four?", "done", "refused")];
    const conv = DEFAULT_ASK_SETTINGS.conversation;
    expect(historyFor(all, conv, 500)).toEqual([{ q: "one?", a: "x".repeat(600) }, { q: "three?", a: "" }]);
    expect(historyFor(all, { ...conv, turns: 1 }, 500)).toEqual([{ q: "three?", a: "" }]);
    expect(historyFor(all, { ...conv, followUps: false }, 500)).toEqual([]);
  });
});
