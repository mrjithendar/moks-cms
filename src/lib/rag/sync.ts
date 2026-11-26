import { and, eq, sql } from "drizzle-orm";
import { absoluteUrl } from "@/config/site";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import { toIsoOffset } from "../dates-iso";
import { enqueue, PermanentJobError } from "../jobs";
import { log } from "../log";
import { previewPercentFor, sitePreviewPercent, splitForMembers } from "../members";
import { deleteDocument, ingestDocument, queryCollection, RagError, type RagClientOpts, type RagConfig, type RagDocument, type RagFilterValue } from "./client";

/**
 * Published content in the shared Hybrid RAG service (moks-rag, collection cms_content), kept in step with the posts
 * table (D-104):
 * - every committed post change (lib/posts.ts afterChange) queues one `rag_sync` job per address it had before and has
 *   now. The job reads the post when it runs: readers can see it → POST /ingest (replaces its chunks); otherwise
 *   (draft, review, scheduled, archived, trashed, deleted, renamed away, noindex) → DELETE /documents/{doc_id};
 * - the jobs run in the background worker (lib/scheduler.ts), never in the request: saving and publishing never wait
 *   for, or fail because of, rag-api. A failed job retries with the queue's backoff (1, 2, 4 … 60 min, 8 attempts);
 * - Admin → Integrations → Hybrid RAG → "Reindex all posts" queues a job for every post (the backfill), which also
 *   removes drafts and unpublished posts that are still in the collection.
 * Off (nothing queued, nothing sent) until RAG_BEARER_TOKEN is set, in the deployment or in that section.
 *
 * What is sent is what every reader can see, like the SEO agent's article index (seo-agent/callbacks.ts
 * publishedArticles): a members-only post contributes only its free preview, and noindex posts are left out.
 * Content from files (content/, a fresh install before /setup) is not synced; import it first.
 */
export const RAG_JOB_KIND = "rag_sync";
export const RAG_DEFAULTS = { url: "http://rag-api.rag.svc.cluster.local:8000", collection: "cms_content", serviceName: "moks-cms" } as const;
/** 1 + 2 + 4 + 8 + 16 + 32 + 60 minutes of retries: rag-api may be down for about two hours before a sync gives up. */
const MAX_ATTEMPTS = 8;
/** After rag-api failed to answer, other sync jobs on this server wait this long instead of each waiting 30 s. */
const PAUSE_MS = 60_000;

export type DocRef = { collection: string; slug: string };
/** The doc_id in rag-api. No "/": rag-api's DELETE /documents/{doc_id} takes a single path segment. */
export const ragDocId = (ref: DocRef) => `${ref.collection}:${ref.slug}`;

export function ragConfig(env: Record<string, string | undefined>): RagConfig | null {
  const token = env.RAG_BEARER_TOKEN?.trim();
  if (!token) return null;
  return {
    url: (env.RAG_API_URL?.trim() || RAG_DEFAULTS.url).replace(/\/+$/, ""),
    token,
    collection: env.RAG_COLLECTION?.trim() || RAG_DEFAULTS.collection,
    serviceName: env.RAG_SERVICE_NAME?.trim() || RAG_DEFAULTS.serviceName,
  };
}

/** Settings saved in Admin → Integrations over the deployment's environment. Loaded lazily: posts.ts imports this module. */
async function currentEnv(): Promise<Record<string, string | undefined>> {
  const { effectiveEnv } = await import("../runtime-settings");
  return effectiveEnv();
}

type PostRow = typeof schema.post.$inferSelect;

/** True when readers can see the post now and it may be indexed. */
export function syncable(row: PostRow, now = new Date()): boolean {
  return row.status === "published" && row.publishedAt !== null && row.publishedAt.getTime() <= now.getTime() && !row.deletedAt && !row.noindex;
}

/** Markdown for embedding: HTML comments dropped, images reduced to their alt text, no runs of blank lines. */
export function cleanMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The document rag-api stores for a post readers can see. */
export function ragDocument(row: PostRow, env: Record<string, string | undefined>): RagDocument {
  const body = row.membersOnly ? splitForMembers(row.body, previewPercentFor(row.previewPercent, sitePreviewPercent(env))).preview : row.body;
  const path = `/${row.collection}/${row.slug}`;
  const url = absoluteUrl(path);
  return {
    docId: ragDocId(row),
    title: row.title,
    source: url,
    text: [`# ${row.title}`, row.description.trim(), cleanMarkdown(body)].filter(Boolean).join("\n\n"),
    metadata: {
      slug: row.slug,
      url,
      path,
      title: row.title,
      tags: row.tags,
      status: "published",
      updated_at: toIsoOffset(row.updatedAt ?? row.publishedAt!),
      published_at: toIsoOffset(row.publishedAt!),
      collection: row.collection,
      category: row.category,
      content_type: row.contentType,
      members_only: row.membersOnly,
      post_id: row.id,
    },
  };
}

/**
 * After a committed change: queue a sync for each address. Never throws and never calls rag-api; awaits only the
 * job-queue insert in this site's own database.
 */
export async function queueRagSync(refs: DocRef[]): Promise<number> {
  const unique = [...new Map(refs.map((r) => [ragDocId(r), { collection: r.collection, slug: r.slug }])).values()];
  if (!unique.length) return 0;
  try {
    if (!ragConfig(await currentEnv())) return 0;
    const db = await getDb();
    let queued = 0;
    for (const ref of unique) {
      const key = `rag:${ragDocId(ref)}`;
      if (await enqueue(RAG_JOB_KIND, ref, { dedupeKey: key, maxAttempts: MAX_ATTEMPTS })) {
        queued++;
        continue;
      }
      // A job for this post is already waiting (it will read the post as it is now: nothing to add), or running, in
      // which case it may have read the post before this change: one more run after it.
      const running = rowsOf(await db.execute(sql`select 1 from job where dedupe_key = ${key} and status = 'running' limit 1`)).length > 0;
      if (running && (await enqueue(RAG_JOB_KIND, ref, { dedupeKey: `${key}:again`, maxAttempts: MAX_ATTEMPTS }))) queued++;
    }
    return queued;
  } catch (error) {
    log.warn("could not queue RAG sync", { event: "rag_sync_queue_failed", dependency: "rag-api", err: error });
    return 0;
  }
}

const pause = globalThis as unknown as { __ragPausedUntil?: number };

async function documentFor(ref: DocRef, env: Record<string, string | undefined>): Promise<RagDocument | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.post).where(and(eq(schema.post.collection, ref.collection), eq(schema.post.slug, ref.slug)));
  return row && syncable(row) ? ragDocument(row, env) : null;
}

/** Job handler (lib/scheduler.ts): make rag-api hold what readers see at this address now. */
export function ragSyncHandler(opts: RagClientOpts = {}) {
  return async (payload: Record<string, unknown>): Promise<void> => {
    const { collection, slug } = payload;
    if (typeof collection !== "string" || typeof slug !== "string" || !collection || !slug) throw new PermanentJobError("rag_sync job without collection and slug");
    const env = await currentEnv();
    const cfg = ragConfig(env);
    if (!cfg) return; // switched off since the job was queued
    if ((pause.__ragPausedUntil ?? 0) > Date.now()) throw new Error("rag-api did not answer a moment ago; this sync waits for the next retry");
    const ref = { collection, slug };
    try {
      let doc = await documentFor(ref, env);
      // Two passes at most: when the post changed while it was being sent (a save on another server), send it again.
      for (let pass = 0; pass < 2; pass++) {
        if (doc) await ingestDocument(cfg, doc, opts);
        else await deleteDocument(cfg, ragDocId(ref), opts);
        const now = await documentFor(ref, env);
        if (JSON.stringify(now) === JSON.stringify(doc)) break;
        doc = now;
      }
      log.info("RAG document synced", { event: "rag_sync", dependency: "rag-api", operation: doc ? "ingest" : "delete", outcome: "ok", docId: ragDocId(ref) });
    } catch (error) {
      if (error instanceof RagError && !error.retryable) throw new PermanentJobError(error.message);
      if (error instanceof RagError) pause.__ragPausedUntil = Date.now() + PAUSE_MS;
      throw error;
    }
  };
}

/** For tests: forget that rag-api was unavailable. */
export function resetRagPause() {
  pause.__ragPausedUntil = undefined;
}

/**
 * Backfill (Admin → Integrations → Hybrid RAG → Reindex all posts): one sync job per post in the database. Posts
 * readers can see are indexed; every other post is removed from the collection. Null when RAG sync is off.
 */
export async function queueRagReindex(): Promise<{ queued: number; total: number } | null> {
  if (!ragConfig(await currentEnv())) return null;
  const db = await getDb();
  const rows = await db.select({ collection: schema.post.collection, slug: schema.post.slug }).from(schema.post);
  return { queued: await queueRagSync(rows), total: rows.length };
}

export type RagHit = { docId: string; title: string; url: string; score: number; snippet: string; metadata: Record<string, unknown> };

/**
 * Hybrid search over published content (POST /query, status "published", no LLM answer): the best chunk of each
 * document, best first. Throws RagError when RAG is off or rag-api fails; callers show their own fallback.
 */
export async function searchPublished(query: string, opts: { limit?: number; filters?: Record<string, RagFilterValue> } & RagClientOpts = {}): Promise<RagHit[]> {
  const cfg = ragConfig(await currentEnv());
  if (!cfg) throw new RagError("Hybrid RAG is off: no RAG bearer token is set.", null, false);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 20);
  // Several chunks of one article can rank high: ask for more, keep the best chunk per article.
  const result = await queryCollection(cfg, { query: query.trim().slice(0, 500), topK: Math.min(limit * 3, 50), filters: { ...opts.filters, status: "published" } }, opts);
  const best = new Map<string, RagHit>();
  for (const s of result.sources) {
    if (best.has(s.doc_id)) continue;
    const m = s.metadata ?? {};
    best.set(s.doc_id, { docId: s.doc_id, title: String(m.title ?? s.doc_id), url: String(m.url ?? ""), score: s.score, snippet: s.text.slice(0, 300), metadata: m });
  }
  return [...best.values()].slice(0, limit);
}

export type RagStatus = {
  config: Omit<RagConfig, "token"> | null;
  jobs: Record<string, number>;
  lastDoneAt: string | null;
  lastFailure: { at: string; error: string } | null;
};

/** Admin → Integrations → Hybrid RAG: where it sends, and the sync jobs of the last 7 days. Never the token. */
export async function ragStatus(): Promise<RagStatus> {
  const cfg = ragConfig(await currentEnv());
  const db = await getDb();
  const counts = rowsOf<{ status: string; n: number }>(await db.execute(sql`select status, count(*)::int as n from job where kind = ${RAG_JOB_KIND} and created_at > now() - interval '7 days' group by status`));
  const [done] = rowsOf<{ at: Date | string }>(await db.execute(sql`select max(finished_at) as at from job where kind = ${RAG_JOB_KIND} and status = 'done'`));
  const [failed] = rowsOf<{ at: Date | string; error: string | null }>(await db.execute(sql`select finished_at as at, last_error as error from job where kind = ${RAG_JOB_KIND} and status = 'failed' order by finished_at desc limit 1`));
  const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
  return {
    config: cfg ? { url: cfg.url, collection: cfg.collection, serviceName: cfg.serviceName } : null,
    jobs: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    lastDoneAt: iso(done?.at),
    lastFailure: failed?.at ? { at: iso(failed.at)!, error: failed.error ?? "" } : null,
  };
}
