import { z } from "zod";
import { CallbackError } from "../seo-agent/callbacks";
import { RagError } from "./client";
import { queueRagSync, ragReindexPlan, ragSyncNow, type RagReindexPlan, type RagSyncOutcome } from "./sync";

/**
 * The SEO agent's Hybrid RAG reindex flow (seo-agent app/flows/rag_reindex.py, D-107) through the callback API
 * (lib/seo-agent/internal-server.ts). The agent never writes cms_content itself: its moks-rag client refuses every
 * collection but its own (seo-agent app/moks_rag.py), so this server sends each post with its own token, as its sync
 * jobs do.
 *
 * - GET  /rag/posts         the plan: destination (never the token) and every post with what will happen to it and why;
 * - POST /rag/posts/sync    sync one post now and say what happened (an ingest waits for rag-api, like a job's);
 * - POST /rag/posts/queue   hand posts to the background sync jobs (the flow stopped: rag-api is down or slow).
 *
 * rag-api's failures come back with a code the flow acts on: rag_unavailable (503: rag-api down, slow or overloaded;
 * the flow stops and queues the rest), rag_token_refused (422: HTTP 401/403, every post would fail the same; the flow
 * stops), rag_refused (422: this post only, e.g. too large; the flow carries on) and rag_off (409: no bearer token).
 */
const ref = z.object({ collection: z.string().min(1).max(100), slug: z.string().min(1).max(300) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CallbackError(`Invalid request: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 5).join("; ")}`, 400, "invalid");
  return r.data;
}

const OFF = "Hybrid RAG is off: no bearer token is set (Admin → Settings → Integrations → Hybrid RAG).";

export async function ragPostsCallback(): Promise<({ configured: true } & RagReindexPlan) | { configured: false; destination: null; posts: [] }> {
  const plan = await ragReindexPlan();
  return plan ? { configured: true, ...plan } : { configured: false, destination: null, posts: [] };
}

export async function ragSyncPostCallback(body: unknown): Promise<RagSyncOutcome> {
  const r = parse(ref, body);
  let out: RagSyncOutcome | null;
  try {
    out = await ragSyncNow(r);
  } catch (error) {
    if (!(error instanceof RagError)) throw error;
    if (error.retryable) throw new CallbackError(error.message, 503, "rag_unavailable");
    throw new CallbackError(error.message, 422, error.status === 401 || error.status === 403 ? "rag_token_refused" : "rag_refused");
  }
  if (!out) throw new CallbackError(OFF, 409, "rag_off");
  return out;
}

export async function ragQueuePostsCallback(body: unknown): Promise<{ queued: number }> {
  const b = parse(z.object({ posts: z.array(ref).max(20_000) }), body);
  return { queued: await queueRagSync(b.posts) };
}
