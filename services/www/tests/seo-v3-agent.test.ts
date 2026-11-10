import http from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";
import { ARTICLE_BODY, seedArticle, seedRecommendation } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const drafts = await import("@/lib/seo-intel/drafts");
const pub = await import("@/lib/seo-intel/publish");
const orch = await import("@/lib/seo-agent/orchestrate");
const { handleCallback, tokenOk } = await import("@/lib/seo-agent/internal-server");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
const { docsFetcher } = await import("@/lib/seo-intel/crawler");

/**
 * SEO v3 on the web-app side, with the seo-agent mocked: the orchestrator switch, the callback API (auth, ownership,
 * the one write, validators reuse), the approval gate, and the end-to-end flow
 * approve in the admin API → graph resumes (mock) → publish callback → verify → submit → submission records.
 * The agent's own graphs are tested in services/seo-agent/tests (fake LLM, fake web app).
 */
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const BODY = ARTICLE_BODY.replace("![](/media/diagram.png)\n\n", "");
const TITLE = "Ingress and TLS on Kubernetes: a worked example";
const CB_TOKEN = "c".repeat(40);
const AGENT_TOKEN = "a".repeat(40);
const env = { ...process.env };

let db: Db;
let articleId: string;
let live: http.Server;
let liveOrigin = "";
let liveTitle = "x";
let agentCalls: { path: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

/** The seo-agent, mocked: records start/resume calls. */
function agentFetch(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.host !== "seo-agent.test:8080") return realFetch(url, init); // the local "live site" for verification
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    agentCalls.push({ path: u.pathname, body });
    if (u.pathname === "/runs") return Response.json({ thread_id: body.thread_id, status: "running", existing: false }, { status: 202 });
    if (u.pathname.endsWith("/resume")) return Response.json({ status: "running" }, { status: 202 });
    return Response.json({ error: "nope" }, { status: 404 });
  }) as typeof fetch;
}

const cb = (method: string, path: string, body?: unknown, token = CB_TOKEN) => handleCallback(method, `/internal/seo-agent${path}`, `Bearer ${token}`, body, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN });

beforeAll(async () => {
  // The "live site" the verify step fetches (SEO_VERIFY_FETCH_ORIGIN, local only).
  live = http.createServer((req, res) => {
    const url = `https://jithendar.com${req.url}`;
    res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>${liveTitle}</title><link rel="canonical" href="${url}"><script type="application/ld+json">[{"@type":"TechArticle"}]</script></head></html>`);
  });
  await new Promise<void>((r) => live.listen(0, "127.0.0.1", r));
  liveOrigin = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
});
afterAll(() => live.close());

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }, { id: "author", name: "Author", email: "author@example.com", role: "author" }]);
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  articleId = (await seedArticle(db, { body: BODY })).id;
  agentCalls = [];
  Object.assign(process.env, { SEO_ORCHESTRATOR: "langgraph", SEO_AGENT_TOKEN: AGENT_TOKEN, SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN, SEO_AGENT_URL: "http://seo-agent.test:8080", SITE_URL: "https://jithendar.com", SEO_VERIFY_FETCH_ORIGIN: liveOrigin, SEO_SUBMISSION_ENABLED: "true", INDEXNOW_KEY: "0123456789abcdef0123456789abcdef" });
  vi.stubGlobal("fetch", agentFetch());
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

const MODEL = (paragraphBlock = "b2") => ({
  summary: "Title, meta and one clarification.",
  changes: [
    { type: "title", block_id: "", before: TITLE, after: "Kubernetes ingress TLS with cert-manager", rationale: "Low CTR.", evidence_ref: [], source_urls: [] },
    { type: "paragraph_edit", block_id: paragraphBlock, before: "Install it with Helm.", after: "Install the controller with Helm.", rationale: "Clarity.", evidence_ref: [], source_urls: [] },
  ],
});

/** What the graph does up to human_review, through the callback API: context → validate → save. */
async function agentDraft() {
  await seedRecommendation(db, articleId, "low_ctr");
  await seedRecommendation(db, articleId, "striking_distance");
  const r = await orch.requestDraft(articleId, { trigger: "manual" });
  expect(r).toMatchObject({ orchestrator: "langgraph", queued: true });
  const draftId = (r as { draftId: string }).draftId;
  const ctx = await cb("POST", `/articles/${articleId}/context`, {});
  expect(ctx.status).toBe(200);
  const v = await cb("POST", `/articles/${articleId}/validate`, { draftId, output: MODEL() });
  expect((v.body as { errors: string[] }).errors).toEqual([]);
  const saved = await cb("POST", `/drafts/${draftId}/save`, { changes: (v.body as { changes: unknown[] }).changes, flags: [], summary: "s", threadId: draftId, categories: ["title_meta"] });
  expect(saved.status).toBe(200);
  return draftId;
}

describe("orchestrator switch", () => {
  it("legacy (default): drafts go to the v2 job queue and never to the agent", async () => {
    delete process.env.SEO_ORCHESTRATOR;
    await seedRecommendation(db, articleId, "low_ctr");
    const r = await orch.requestDraft(articleId, {});
    expect(r).toMatchObject({ orchestrator: "legacy", queued: true });
    expect(agentCalls).toEqual([]);
    expect(rowsOf(await db.execute(sql`select 1 from job where kind = 'seo_draft'`)).length).toBe(1);
  });

  it("langgraph: reserves one draft owned by the run (thread id = draft id) and starts optimize_article", async () => {
    const draftId = await agentDraft();
    expect(agentCalls[0]).toMatchObject({ path: "/runs", body: { graph: "optimize_article", thread_id: draftId, input: { article_id: articleId, draft_id: draftId } } });
    const d = await drafts.getDraft(draftId);
    expect(d).toMatchObject({ status: "ready_for_review", thread_id: draftId });
    expect(d!.changes.every((c) => c.decision === "pending")).toBe(true);
  });

  it("drafts made by the legacy path keep legacy approval even in langgraph mode", async () => {
    delete process.env.SEO_ORCHESTRATOR;
    await seedRecommendation(db, articleId, "low_ctr");
    const base = await drafts.loadBase(db, articleId);
    const d = await drafts.reserveDraft(db, articleId, base, "manual");
    process.env.SEO_ORCHESTRATOR = "langgraph";
    expect(await orch.approve(d.id, admin, null)).toBeNull(); // route falls back to v2 approveDraft
  });
});

describe("callback API", () => {
  it("needs the callback token (≥ 32 chars), compared in constant time", async () => {
    expect((await cb("GET", "/articles/published", undefined, "wrong".repeat(10))).status).toBe(401);
    expect((await handleCallback("GET", "/internal/seo-agent/articles/published", undefined, undefined, { SEO_AGENT_CALLBACK_TOKEN: CB_TOKEN })).status).toBe(401);
    expect(tokenOk("Bearer short", "short")).toBe(false);
    expect((await cb("GET", "/articles/published")).status).toBe(200);
    expect((await cb("GET", "/admin/anything")).status).toBe(404);
    expect((await cb("GET", "/drafts/x/publish")).status).toBe(405);
  });

  it("context is v2's own prompt (rules, style guide, data blocks) for the article", async () => {
    await seedRecommendation(db, articleId, "low_ctr");
    const r = (await cb("POST", `/articles/${articleId}/context`, {})).body as { prompt: { user: string; rules: string; styleGuide: string }; modelCategories: string[] };
    expect(r.prompt.rules).toBe(drafts.DRAFT_RULES);
    expect(r.prompt.user).toContain('<data name="article_blocks">');
    expect(r.modelCategories).toContain("title_meta");
  });

  it("validate reuses v2's validators (bad block id → error, feeding the graph's retry)", async () => {
    const r = (await cb("POST", `/articles/${articleId}/validate`, { draftId: "x", output: MODEL("b0") })).body as { errors: string[] };
    expect(r.errors.join(" ")).toMatch(/c2/);
    const bad = (await cb("POST", `/articles/${articleId}/validate`, { draftId: "x", output: { summary: 1 } })).body as { errors: string[] };
    expect(bad.errors[0]).toMatch(/^schema:/);
  });

  it("the agent can only write drafts its run owns, and only generation statuses", async () => {
    delete process.env.SEO_ORCHESTRATOR;
    const base = await drafts.loadBase(db, articleId);
    const legacy = await drafts.reserveDraft(db, articleId, base, "manual");
    process.env.SEO_ORCHESTRATOR = "langgraph";
    expect((await cb("POST", `/drafts/${legacy.id}/save`, { changes: [], threadId: legacy.id })).status).toBe(403);
    await db.execute(sql`update seo_drafts set status = 'superseded' where id = ${legacy.id}`);
    const draftId = await agentDraft();
    expect((await cb("POST", `/drafts/${draftId}/status`, { status: "published" })).status).toBe(400);
    expect((await cb("POST", `/drafts/${draftId}/save`, { changes: [], threadId: "other" })).status).toBe(400);
    // decisions belong to the reviewer: a saved change set is always pending
    await cb("POST", `/drafts/${draftId}/save`, { changes: [{ id: "c1", type: "title", decision: "accepted" }], threadId: draftId });
    expect((await drafts.getDraft(draftId))!.changes[0]!.decision).toBe("pending");
    // nothing the agent can call writes `post`
    const before = (await db.select().from(schema.post))[0]!;
    expect(before.version).toBe(1);
  });

  it("the docs fetcher refuses anything off the allowlist before a request", async () => {
    const f = docsFetcher(["kubernetes.io"], { timeoutMs: 1000, maxBytes: 1000, maxRedirects: 1 });
    for (const u of ["https://evil.example/x", "http://kubernetes.io/docs", "https://kubernetes.io.evil.example/", "https://user:pw@kubernetes.io/", "https://kubernetes.io:8443/"]) {
      expect((await f(u)).error, u).toMatch(/allowlist/);
    }
    const r = await cb("POST", "/fetch-docs", { url: "https://169.254.169.254/latest/meta-data/" });
    expect((r.body as { error: string }).error).toMatch(/allowlist/);
  });
});

describe("the approval gate", () => {
  it("approve in the admin API → graph resumes with the approval → publish → verify → submit (E2E, agent mocked)", async () => {
    const draftId = await agentDraft();
    await drafts.decideChange(draftId, "c1", "accepted", "Kubernetes ingress TLS, step by step");
    await drafts.decideChange(draftId, "c2", "rejected");
    const r = await orch.approve(draftId, admin, null);
    expect(r).toMatchObject({ status: "publishing" });
    const resume = agentCalls.find((c) => c.path === `/runs/${draftId}/resume`)!;
    expect(resume.body).toMatchObject({ decision: "approve", accepted_change_ids: ["c1"], approval_id: r!.approvalId });
    expect((await db.select().from(schema.post))[0]!.version).toBe(1); // recording the approval publishes nothing

    // The graph's publish node:
    const p = await cb("POST", `/drafts/${draftId}/publish`, { approvalId: r!.approvalId, acceptedChangeIds: ["c1"] });
    expect(p).toMatchObject({ status: 200, body: { status: "published" } });
    const post = (await db.select().from(schema.post))[0]!;
    expect(post.seoTitle).toBe("Kubernetes ingress TLS, step by step");
    expect(post.body).toContain("Install it with Helm."); // rejected change left out
    expect(rowsOf(await db.execute(sql`select 1 from job where kind = 'seo_verify'`)).length).toBe(0); // the graph owns verification
    // an approval works once
    expect((await cb("POST", `/drafts/${draftId}/publish`, { approvalId: r!.approvalId, acceptedChangeIds: ["c1"] })).status).toBe(403);

    // verify_live: first attempt fails (title not live yet), then passes
    liveTitle = "stale";
    expect((await cb("POST", `/drafts/${draftId}/verify`, { attempt: 1, final: false })).body).toMatchObject({ state: "retrying" });
    expect((await cb("POST", `/drafts/${draftId}/submit`)).status).toBe(409); // never submit unverified
    liveTitle = "Kubernetes ingress TLS, step by step";
    expect((await cb("POST", `/drafts/${draftId}/verify`, { attempt: 2, final: false })).body).toMatchObject({ state: "passed" });
    const s = await cb("POST", `/drafts/${draftId}/submit`);
    expect(s.status).toBe(200);
    const subs = rowsOf<{ engine: string }>(await db.execute(sql`select engine from seo_search_submissions where draft_id = ${draftId}`));
    expect(subs.map((x) => x.engine)).toContain("indexnow");
    const audit = rowsOf<{ action: string }>(await db.execute(sql`select action from audit_log where action like 'seo.draft.%' order by created_at`)).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["seo.draft.approve", "seo.draft.publish", "seo.draft.verified"]));
  });

  it("refuses without an approval, with a forged or expired one, or when the accepted changes differ", async () => {
    const draftId = await agentDraft();
    await drafts.decideChange(draftId, "c1", "accepted");
    await expect(pub.publishWithApproval(draftId, "not-a-uuid", ["c1"])).rejects.toMatchObject({ status: 403 });
    await expect(pub.publishWithApproval(draftId, "00000000-0000-4000-8000-000000000000", ["c1"])).rejects.toMatchObject({ status: 403 });
    const { approvalId } = await pub.recordApproval(draftId, admin);
    await expect(pub.publishWithApproval(draftId, approvalId, ["c1", "c2"])).rejects.toMatchObject({ status: 409 });
    await expect(pub.publishWithApproval(draftId, approvalId, ["c1"], new Date(Date.now() + 8 * 86_400_000))).rejects.toMatchObject({ status: 403 }); // expired
    // the reviewer changed a decision after approving → approve again
    await drafts.decideChange(draftId, "c2", "accepted");
    await expect(pub.publishWithApproval(draftId, approvalId, ["c1"])).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.post))[0]!.version).toBe(1);
  });

  it("refuses when the approving admin was demoted, and for a scheduled approval before its time", async () => {
    const draftId = await agentDraft();
    await drafts.decideChange(draftId, "c1", "accepted");
    const later = await pub.recordApproval(draftId, admin, { publishAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(later.publishAt).not.toBeNull();
    expect((await drafts.getDraft(draftId))!.status).toBe("scheduled");
    await expect(pub.publishWithApproval(draftId, later.approvalId, ["c1"])).rejects.toMatchObject({ status: 409 });
    await db.execute(sql`update "user" set role = 'author' where id = 'admin'`);
    await expect(pub.publishWithApproval(draftId, later.approvalId, ["c1"], new Date(Date.now() + 2 * 3_600_000))).rejects.toMatchObject({ status: 403 });
  });

  it("an author cannot record an approval", async () => {
    const draftId = await agentDraft();
    await drafts.decideChange(draftId, "c1", "accepted");
    await expect(orch.approve(draftId, { id: "author", role: "author", label: "author@example.com" }, null)).rejects.toMatchObject({ status: 403 });
    expect(agentCalls.some((c) => c.path.endsWith("/resume"))).toBe(false);
  });

  it("reject marks the draft rejected and ends the run", async () => {
    const draftId = await agentDraft();
    await orch.reject(draftId, admin, "not now");
    expect((await drafts.getDraft(draftId))!.status).toBe("rejected");
    expect(agentCalls.at(-1)).toMatchObject({ path: `/runs/${draftId}/resume`, body: { decision: "reject", feedback: "not now" } });
  });
});

describe("new articles (editorial crew)", () => {
  async function crewDraft(doc: Record<string, unknown>) {
    const { createPost } = await import("@/lib/posts");
    const p = await createPost(admin, { collection: "blog", slug: `draft-rotate-certs-${Math.random().toString(36).slice(2, 8)}`, title: "Rotating cert-manager certificates", description: "", body: "TODO", category: "kubernetes", tags: [], contentType: "tutorial", status: "draft" }, { incompleteDrafts: true });
    const base = await drafts.loadBase(db, p.id);
    const d = await drafts.reserveDraft(db, p.id, base, "calendar", { kind: "new_article", threadManaged: true });
    const v = (await cb("POST", `/articles/${p.id}/validate`, { draftId: d.id, kind: "new_article", document: doc })).body as { errors: string[]; flags: { code: string }[] };
    return { postId: p.id, draftId: d.id, v };
  }
  const DOC = { title: "Rotate cert-manager certificates safely", slug_suggestion: "rotate-cert-manager-certificates", meta_description: "How cert-manager renews certificates, how to force a rotation, and how to verify the new certificate is served by your ingress controller.", outline: ["Why"], body_mdx: "## Why rotate\n\nCertificates expire.\n\n```bash\nkubectl get certificate -A\n```", sources: [], fact_check_flags: [{ claim: "renews 30 days before expiry", reason: "no source", severity: "warning" }], internal_links: [] };

  it("validates the crew's document (H1, MDX, unknown internal links) and surfaces fact-check flags", async () => {
    const ok = await crewDraft(DOC);
    expect(ok.v.errors).toEqual([]);
    expect(ok.v.flags.map((f) => f.code)).toContain("needs_fact_check");
    await db.execute(sql`update seo_drafts set status = 'superseded'`);
    const bad = await crewDraft({ ...DOC, body_mdx: "# Title again\n\nSee [this](/blog/does-not-exist) and {broken jsx" });
    expect(bad.v.errors.join(" ")).toMatch(/H1/);
    expect(bad.v.errors.join(" ")).toMatch(/does-not-exist/);
  });

  it("publishes the CMS draft post only with an approval", async () => {
    const { postId, draftId } = await crewDraft(DOC);
    await cb("POST", `/drafts/${draftId}/save`, { kind: "new_article", document: DOC, changes: [], flags: [], threadId: draftId });
    const r = await orch.approve(draftId, admin, null);
    expect(r).toMatchObject({ status: "publishing" });
    expect((await db.select().from(schema.post).where(sql`id = ${postId}`))[0]!.status).toBe("draft");
    const p = await cb("POST", `/drafts/${draftId}/publish`, { approvalId: r!.approvalId, acceptedChangeIds: [] });
    expect(p).toMatchObject({ status: 200, body: { status: "published" } });
    const post = (await db.select().from(schema.post).where(sql`id = ${postId}`))[0]!;
    expect(post).toMatchObject({ status: "published", title: DOC.title, slug: "rotate-cert-manager-certificates" });
  });

  it("an incomplete crew draft cannot be approved", async () => {
    const { draftId } = await crewDraft({ ...DOC, incomplete: true, incomplete_reason: "token cap" });
    await cb("POST", `/drafts/${draftId}/save`, { kind: "new_article", document: { ...DOC, incomplete: true }, changes: [], flags: [], threadId: draftId });
    await expect(orch.approve(draftId, admin, null)).rejects.toMatchObject({ status: 400 });
  });
});

describe("Ask the Blog", () => {
  const ask = async (body: unknown, headers: Record<string, string> = {}) => {
    const { POST } = await import("@/app/api/ask/route");
    return POST(new Request("https://jithendar.com/api/ask", { method: "POST", headers: { "content-type": "application/json", origin: "https://jithendar.com", host: "jithendar.com", "x-forwarded-for": "203.0.113.9, 10.0.0.1", ...headers }, body: JSON.stringify(body) }));
  };

  it("is off by default (404) and refuses cross-site requests", async () => {
    expect((await ask({ question: "How does cert-manager renew?" })).status).toBe(404);
    process.env.ASK_BLOG_ENABLED = "true";
    expect((await ask({ question: "x" }, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("proxies the agent's stream with a hashed IP, and rate-limits per client", async () => {
    process.env.ASK_BLOG_ENABLED = "true";
    process.env.BETTER_AUTH_SECRET = "s".repeat(40);
    const seen: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", (async (_u: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)));
      return new Response('event: final\ndata: {"outcome":"answered","answer":"x [1]","citations":[]}\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);
    const r = await ask({ question: "How does cert-manager renew?" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("event: final");
    expect(seen[0]).toMatchObject({ question: "How does cert-manager renew?", stream: true });
    expect(String(seen[0]!.ip_hash)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(seen[0])).not.toContain("10.0.0.1");
    let last = 200;
    for (let i = 0; i < 6; i++) last = (await ask({ question: "again?" })).status;
    expect(last).toBe(429);
    // the left-most X-Forwarded-For entry is client-controlled: spoofing it does not reset the limit
    expect((await ask({ question: "again?" }, { "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).status).toBe(429);
  });

  it("unanswered questions become 'Asked on site' gaps that can go to the editorial calendar", async () => {
    const gaps = await import("@/lib/seo-agent/gaps");
    for (const [n, q] of [["how to schedule gpu workloads volcano", "How to schedule GPU workloads with Volcano?"], ["schedule gpu workloads with volcano", "Schedule GPU workloads with Volcano"], ["contact me at a@b.co", "contact me at a@b.co"]] as const) {
      await db.execute(sql`insert into seo_ask_gaps (normalized, sample_question, asked) values (${n}, ${q}, 2)`);
    }
    expect(await gaps.clusterAskGaps()).toBe(3);
    const list = await gaps.askGapClusters();
    expect(list.length).toBe(1); // the personal-data question is never shown
    expect(list[0]).toMatchObject({ asked: 4 });
    const { calendarId } = await gaps.sendGapToCalendar(list[0]!.questions[0]!.id);
    const [item] = rowsOf<{ title: string; brief: { notes: string } }>(await db.execute(sql`select title, brief from seo_editorial_calendar where id = ${calendarId}`));
    expect(item!.brief.notes).toMatch(/Asked on site/);
    expect((await gaps.askGapClusters())[0]!.status).toBe("sent");
  });
});

describe("migration 0015", () => {
  it("applies, rolls back and re-applies", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrateDb, migrationsDir } = await import("@/db/migrate");
    const pg = new PGlite();
    const clean = drizzle(pg, { schema }) as unknown as Db;
    await migrateDb(clean);
    const n = async () => rowsOf(await clean.execute(sql`select 1 from information_schema.tables where table_name in ('seo_agent_runs', 'seo_draft_approvals', 'seo_ask_log', 'seo_ask_gaps')`)).length;
    expect(await n()).toBe(4);
    for (const stmt of fs.readFileSync(path.resolve(migrationsDir(), "../rollback/0015_seo_agent.down.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await clean.execute(sql.raw(stmt));
    expect(await n()).toBe(0);
    expect(await migrateDb(clean)).toEqual(["0015_seo_agent.sql"]);
    await pg.close();
  });
});
