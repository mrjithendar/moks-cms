import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { invalidateContent } from "@/lib/content";
import { runDueJobs } from "@/lib/jobs";
import { createPost, deletePostPermanently, trashPost, updatePost, type Actor } from "@/lib/posts";
import { deleteDocument, ingestDocument, queryCollection, RagError, type RagConfig } from "@/lib/rag/client";
import { cleanMarkdown, queueRagReindex, RAG_JOB_KIND, ragConfig, ragSyncHandler, resetRagPause, searchPublished } from "@/lib/rag/sync";
import { renameTag } from "@/lib/taxonomy-admin";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));

const TOKEN = "test-rag-token-0123456789abcdef";
const cfg: RagConfig = { url: "http://rag-api.test:8000", token: TOKEN, collection: "cms_content", serviceName: "moks-cms" };
const noSleep = async () => {};

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

/** A stand-in for rag-api: records every request and answers from `reply` (a status, or a thrown error). */
function fakeRag(reply: (call: Call, n: number) => number | Error = () => 200) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const r = reply(call, calls.length);
    if (r instanceof Error) throw r;
    const body = call.url.includes("/query")
      ? { query: "q", collection: "cms_content", sources: [] }
      : call.method === "DELETE"
        ? { doc_id: "x", collections: ["cms_content"], deleted: true, service: "moks-cms" }
        : { doc_id: call.body?.doc_id, collection: "cms_content", chunks_ingested: 1, parsed_via_docling: false, service: "moks-cms" };
    return new Response(JSON.stringify(r >= 400 ? { detail: `refused ${r}` } : body), { status: r, headers: { "Content-Type": "application/json" } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("rag-api client", () => {
  it("sends the bearer token and service name, and the document for /ingest", async () => {
    const rag = fakeRag();
    await ingestDocument(cfg, { docId: "blog:a-post", title: "A post", text: "# A post", source: "https://jithendar.com/blog/a-post", metadata: { status: "published" } }, { fetchImpl: rag.fetchImpl });
    const [call] = rag.calls;
    expect(call!.url).toBe("http://rag-api.test:8000/ingest");
    expect(call!.method).toBe("POST");
    expect(call!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call!.headers["X-Service-Name"]).toBe("moks-cms");
    expect(call!.body).toMatchObject({ collection: "cms_content", doc_id: "blog:a-post", title: "A post", text: "# A post", metadata: { status: "published" } });
  });

  it("deletes by doc_id in the configured collection", async () => {
    const rag = fakeRag();
    await deleteDocument(cfg, "blog:a-post", { fetchImpl: rag.fetchImpl });
    expect(rag.calls[0]).toMatchObject({ method: "DELETE", url: "http://rag-api.test:8000/documents/blog%3Aa-post?collection=cms_content" });
    expect(rag.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("asks /query for ranked chunks only, never an LLM answer", async () => {
    const rag = fakeRag();
    await queryCollection(cfg, { query: "istio mtls", topK: 5, filters: { status: "published" } }, { fetchImpl: rag.fetchImpl });
    expect(rag.calls[0]!.body).toEqual({ collection: "cms_content", query: "istio mtls", top_k: 5, filters: { status: "published" }, include_answer: false });
  });

  it("retries a 5xx with backoff, then succeeds", async () => {
    const rag = fakeRag((_c, n) => (n < 3 ? 503 : 200));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await ingestDocument(cfg, { docId: "d", title: "t", text: "x", metadata: {} }, { fetchImpl: rag.fetchImpl, sleep });
    expect(rag.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it("gives up after the retries with a retryable error", async () => {
    const rag = fakeRag(() => 502);
    const err = await ingestDocument(cfg, { docId: "d", title: "t", text: "x", metadata: {} }, { fetchImpl: rag.fetchImpl, sleep: noSleep }).catch((e: unknown) => e);
    expect(rag.calls).toHaveLength(3);
    expect(err).toBeInstanceOf(RagError);
    expect(err).toMatchObject({ status: 502, retryable: true });
  });

  it("does not retry a refusal (401, 422) and never puts the token in the error", async () => {
    const rag = fakeRag(() => 401);
    const err = (await deleteDocument(cfg, "d", { fetchImpl: rag.fetchImpl, sleep: noSleep }).catch((e: unknown) => e)) as RagError;
    expect(rag.calls).toHaveLength(1);
    expect(err).toMatchObject({ status: 401, retryable: false });
    expect(err.message).toContain("HTTP 401");
    expect(err.message).not.toContain(TOKEN);
  });

  it("times out each attempt after the timeout and retries network errors", async () => {
    const hang = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
    const err = (await ingestDocument(cfg, { docId: "d", title: "t", text: "x", metadata: {} }, { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20, sleep: noSleep }).catch((e: unknown) => e)) as RagError;
    expect(hang).toHaveBeenCalledTimes(3);
    expect(err).toMatchObject({ status: null, retryable: true });
    expect(err.message).toMatch(/no answer within/);
  });
});

describe("configuration", () => {
  it("is off without a token, and fills in the defaults", () => {
    expect(ragConfig({})).toBeNull();
    expect(ragConfig({ RAG_BEARER_TOKEN: "  " })).toBeNull();
    expect(ragConfig({ RAG_BEARER_TOKEN: TOKEN })).toEqual({ url: "http://rag-api.rag.svc.cluster.local:8000", token: TOKEN, collection: "cms_content", serviceName: "moks-cms" });
    expect(ragConfig({ RAG_BEARER_TOKEN: TOKEN, RAG_API_URL: "http://127.0.0.1:8000/", RAG_COLLECTION: "other", RAG_SERVICE_NAME: "site-b" })).toMatchObject({ url: "http://127.0.0.1:8000", collection: "other", serviceName: "site-b" });
  });

  it("cleans the markdown it sends", () => {
    expect(cleanMarkdown("Intro\n\n<!-- note to self -->\n\n\n\n![A diagram](/media/x.png)\n\nEnd")).toBe("Intro\n\nA diagram\n\nEnd");
  });
});

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const draft = {
  collection: "blog",
  slug: "a-fresh-post",
  title: "A fresh post written in the admin",
  description: "A description that is comfortably longer than fifty characters for the schema.",
  body: "## Hello\n\nBody text.",
  category: "kubernetes",
  tags: ["GitOps"],
  contentType: "tutorial",
  status: "draft",
};
const PUBLISHED_AT = "2026-10-27T18:00:00+05:30";

let db: Db;
beforeEach(async () => {
  vi.stubEnv("CONTENT_DIR", "");
  delete process.env.CONTENT_DIR;
  vi.stubEnv("RAG_BEARER_TOKEN", TOKEN);
  vi.stubEnv("RAG_API_URL", "http://rag-api.test:8000");
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "jithendar-dharmapuri", displayName: "Admin" });
  invalidateContent();
  resetRagPause();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setDbForTests(undefined);
});

const ragJobs = async () => rowsOf<{ status: string; payload: { collection: string; slug: string }; attempts: number; last_error: string | null }>(await db.execute(sql`select status, payload, attempts, last_error from job where kind = ${RAG_JOB_KIND} order by created_at`));
/** Run the due jobs with the fake rag-api; `later` moves the clock past the retry backoff. */
const runJobs = (rag: ReturnType<typeof fakeRag>, laterMs = 0) => runDueJobs({ [RAG_JOB_KIND]: ragSyncHandler({ fetchImpl: rag.fetchImpl, sleep: noSleep, timeoutMs: 50 }) }, new Date(Date.now() + laterMs));
const publish = async (overrides: Record<string, unknown> = {}) => createPost(admin, { ...draft, ...overrides, status: "published", publishedAt: PUBLISHED_AT });

describe("content sync", () => {
  it("queues nothing for drafts, and nothing at all while it is off", async () => {
    await createPost(admin, draft);
    expect(await ragJobs()).toEqual([]);
    vi.stubEnv("RAG_BEARER_TOKEN", "");
    await publish({ slug: "while-off" });
    expect(await ragJobs()).toEqual([]);
  });

  it("indexes a post when it is published, with its metadata, in the background", async () => {
    const rag = fakeRag();
    await publish();
    // Publishing only queued a job: rag-api was not called during the save.
    expect(rag.calls).toHaveLength(0);
    expect(await ragJobs()).toMatchObject([{ status: "queued", payload: { collection: "blog", slug: "a-fresh-post" } }]);

    expect(await runJobs(rag)).toMatchObject({ done: 1 });
    const [call] = rag.calls;
    expect(call).toMatchObject({ method: "POST", url: "http://rag-api.test:8000/ingest" });
    expect(call!.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "X-Service-Name": "moks-cms" });
    expect(call!.body).toMatchObject({
      collection: "cms_content",
      doc_id: "blog:a-fresh-post",
      title: draft.title,
      source: "https://jithendar.com/blog/a-fresh-post",
      metadata: { slug: "a-fresh-post", url: "https://jithendar.com/blog/a-fresh-post", title: draft.title, tags: ["gitops"], status: "published", updated_at: PUBLISHED_AT, collection: "blog", category: "kubernetes" },
    });
    expect(String(call!.body!.text)).toBe(`# ${draft.title}\n\n${draft.description}\n\n## Hello\n\nBody text.`);
  });

  it("re-indexes an update of a published post", async () => {
    const rag = fakeRag();
    const p = await publish();
    await runJobs(rag);
    await updatePost(admin, p.id, { title: "A fresh post, now with a better title" });
    await runJobs(rag);
    expect(rag.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(rag.calls[1]!.body).toMatchObject({ doc_id: "blog:a-fresh-post", title: "A fresh post, now with a better title", metadata: { title: "A fresh post, now with a better title" } });
  });

  it("removes a post that is unpublished, trashed or deleted", async () => {
    const rag = fakeRag();
    const p = await publish();
    await runJobs(rag);
    await updatePost(admin, p.id, { status: "draft" });
    await runJobs(rag);
    expect(rag.calls.at(-1)).toMatchObject({ method: "DELETE", url: "http://rag-api.test:8000/documents/blog%3Aa-fresh-post?collection=cms_content" });

    await updatePost(admin, p.id, { status: "published", publishedAt: PUBLISHED_AT });
    await runJobs(rag);
    expect(rag.calls.at(-1)!.method).toBe("POST");
    await trashPost(admin, p.id);
    await runJobs(rag);
    expect(rag.calls.at(-1)!.method).toBe("DELETE");
    await deletePostPermanently(admin, p.id);
    await runJobs(rag);
    expect(rag.calls.at(-1)!.method).toBe("DELETE");
  });

  it("moves the document when the slug changes, and drops a post set to noindex", async () => {
    const rag = fakeRag();
    const p = await publish();
    await runJobs(rag);
    await updatePost(admin, p.id, { slug: "a-renamed-post" });
    await runJobs(rag);
    const after = rag.calls.slice(1).map((c) => `${c.method} ${c.method === "DELETE" ? decodeURIComponent(c.url.split("/documents/")[1]!) : c.body!.doc_id}`);
    expect(after.sort()).toEqual(["DELETE blog:a-fresh-post?collection=cms_content", "POST blog:a-renamed-post"]);

    await updatePost(admin, p.id, { noindex: true });
    await runJobs(rag);
    expect(rag.calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining("/documents/blog%3Aa-renamed-post") });
  });

  it("sends only the free preview of a members-only post", async () => {
    const rag = fakeRag();
    const body = ["## Free part", "Everyone can read this opening paragraph.", "## Members part", "SECRET members-only paragraph one.", "SECRET members-only paragraph two.", "SECRET members-only paragraph three."].join("\n\n");
    await publish({ body, membersOnly: true, previewPercent: 20 });
    await runJobs(rag);
    const text = String(rag.calls[0]!.body!.text);
    expect(text).toContain("Free part");
    expect(text).not.toContain("SECRET");
    expect(rag.calls[0]!.body!.metadata).toMatchObject({ members_only: true });
  });

  it("keeps publishing working while rag-api is down, and catches up when it is back", async () => {
    const down = fakeRag(() => new TypeError("fetch failed"));
    const p = await publish();
    await publish({ slug: "a-second-post" });
    expect((await updatePost(admin, p.id, { title: "Saved while rag-api is down" })).title).toBe("Saved while rag-api is down");

    const first = await runJobs(down);
    expect(first).toMatchObject({ done: 0, failed: 0, retried: 2 });
    // The first job tried three times; the second did not wait for rag-api again (paused for a minute).
    expect(down.calls).toHaveLength(3);
    const waiting = await ragJobs();
    expect(waiting.every((j) => j.status === "queued" && j.attempts === 1 && j.last_error)).toBe(true);

    resetRagPause();
    const up = fakeRag();
    expect(await runJobs(up, 5 * 60_000)).toMatchObject({ done: 2 });
    expect(up.calls.map((c) => c.body!.title).sort()).toEqual([draft.title, "Saved while rag-api is down"]);
  });

  it("retries a timeout, and fails a refused token at once instead of retrying it", async () => {
    await publish();
    const slow = fakeRag(() => 504);
    expect(await runJobs(slow)).toMatchObject({ retried: 1 });
    resetRagPause();
    const refused = fakeRag(() => 401);
    expect(await runJobs(refused, 5 * 60_000)).toMatchObject({ failed: 1 });
    expect(refused.calls).toHaveLength(1);
    expect((await ragJobs())[0]).toMatchObject({ status: "failed", last_error: expect.stringContaining("HTTP 401") });
  });

  it("queues one job per post while one is waiting, and one more while it runs", async () => {
    const p = await publish();
    await updatePost(admin, p.id, { title: "A second save before the sync ran" });
    expect(await ragJobs()).toHaveLength(1);
    await db.execute(sql`update job set status = 'running' where kind = ${RAG_JOB_KIND}`);
    await updatePost(admin, p.id, { title: "A third save while the sync runs" });
    expect((await ragJobs()).map((j) => j.status)).toEqual(["running", "queued"]);
  });

  it("re-syncs posts a tag rename changed", async () => {
    const rag = fakeRag();
    await publish();
    await runJobs(rag);
    await renameTag(admin, "gitops", "argo-cd");
    await runJobs(rag);
    expect(rag.calls.at(-1)!.body!.metadata).toMatchObject({ tags: ["argo-cd"] });
  });

  it("reindexes every post: published ones in, all others out", async () => {
    await publish();
    await createPost(admin, { ...draft, slug: "still-a-draft" });
    await db.execute(sql`delete from job`);
    expect(await queueRagReindex()).toEqual({ queued: 2, total: 2 });
    const rag = fakeRag();
    await runJobs(rag);
    expect(rag.calls.map((c) => (c.method === "DELETE" ? `DELETE ${decodeURIComponent(c.url)}` : `POST ${c.body!.doc_id}`)).sort()).toEqual([
      "DELETE http://rag-api.test:8000/documents/blog:still-a-draft?collection=cms_content",
      "POST blog:a-fresh-post",
    ]);
    vi.stubEnv("RAG_BEARER_TOKEN", "");
    expect(await queueRagReindex()).toBeNull();
  });
});

describe("hybrid search", () => {
  it("searches published posts only and returns the best chunk of each post", async () => {
    const sources = [
      { id: "1", doc_id: "blog:a", score: 0.9, text: "best chunk of a", metadata: { title: "A", url: "https://jithendar.com/blog/a" } },
      { id: "2", doc_id: "blog:a", score: 0.8, text: "second chunk of a", metadata: { title: "A", url: "https://jithendar.com/blog/a" } },
      { id: "3", doc_id: "news:b", score: 0.7, text: "chunk of b", metadata: { title: "B", url: "https://jithendar.com/news/b" } },
    ];
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ query: "q", collection: "cms_content", model: "x", answer: null, sources, service: "moks-cms" });
    }) as unknown as typeof fetch;
    const hits = await searchPublished("istio", { limit: 5, filters: { collection: "blog", status: "draft" }, fetchImpl });
    expect(calls[0]).toMatchObject({ collection: "cms_content", query: "istio", top_k: 15, include_answer: false, filters: { collection: "blog", status: "published" } });
    expect(hits.map((h) => [h.docId, h.title, h.url, h.snippet])).toEqual([
      ["blog:a", "A", "https://jithendar.com/blog/a", "best chunk of a"],
      ["news:b", "B", "https://jithendar.com/news/b", "chunk of b"],
    ]);
  });

  it("refuses when it is off", async () => {
    vi.stubEnv("RAG_BEARER_TOKEN", "");
    await expect(searchPublished("istio")).rejects.toBeInstanceOf(RagError);
  });
});
