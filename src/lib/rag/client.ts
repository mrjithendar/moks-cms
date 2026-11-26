/**
 * HTTP client for the shared Hybrid RAG service, moks-rag's rag-api (namespace rag, mrjithendar/moks-rag):
 * POST /ingest, DELETE /documents/{doc_id}?collection=…, POST /query. Every request carries
 * `Authorization: Bearer <RAG_BEARER_TOKEN>` and `X-Service-Name` (rag-api logs each call under that name).
 *
 * Queries and deletes: each attempt has its own 10-second timeout. A timeout, a network error, HTTP 408/429 or any
 * 5xx is tried again twice, after 0.5 s and 1 s; any other answer (401 wrong token, 422 bad payload…) fails at once
 * and is marked not retryable.
 *
 * Ingests are different: one takes as long as bge-m3 needs to embed the post (30 s to a few minutes on mk4's CPU), so
 * an ingest waits for rag-api's answer (no timeout of its own; Node's fetch still gives up after 5 minutes without a
 * response) and is not tried again at once: a failure goes back to the job queue, which retries with its backoff.
 * Giving up after 10 s and sending again left rag-api embedding the same post two and three times at once, which
 * queued bge-m3 until every batch timed out (504). rag-api now also makes a resend wait for the first one.
 *
 * Nothing here logs or returns the token. Free of server-only imports, so tests can call it directly.
 */
export type RagConfig = { url: string; token: string; collection: string; serviceName: string };

export class RagError extends Error {
  constructor(
    message: string,
    /** The HTTP status rag-api answered with; null when it did not answer. */
    readonly status: number | null,
    /** True when trying again later may help (rag-api down, slow or overloaded). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** `timeoutMs: null` = no timeout of this client's own (an ingest). */
export type RagClientOpts = { fetchImpl?: typeof fetch; timeoutMs?: number | null; retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> };

export const RAG_TIMEOUT_MS = 10_000;
const RETRIES = 2;
const BACKOFF_MS = 500;

/** Metadata values rag-api can filter on exactly (QueryRequest.filters). */
export type RagFilterValue = string | number | boolean;

export type RagDocument = { docId: string; title: string; text: string; source?: string; metadata: Record<string, unknown> };
export type IngestResult = { doc_id: string; collection: string; chunks_ingested: number };
export type RagChunk = { id: string; doc_id: string; score: number; text: string; metadata: Record<string, unknown> };
export type QueryResult = { query: string; collection: string; sources: RagChunk[] };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const retryableStatus = (status: number) => status >= 500 || status === 408 || status === 429;

/** rag-api's error detail (FastAPI `{"detail": …}`), shortened; never the request. */
async function detailOf(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const detail = (JSON.parse(text) as { detail?: unknown }).detail;
      return (typeof detail === "string" ? detail : JSON.stringify(detail ?? text)).slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return "";
  }
}

async function call<T>(cfg: RagConfig, method: "POST" | "DELETE", path: string, body: unknown, opts: RagClientOpts): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs === undefined ? RAG_TIMEOUT_MS : opts.timeoutMs;
  const retries = opts.retries ?? RETRIES;
  const sleep = opts.sleep ?? wait;
  let last: RagError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep((opts.backoffMs ?? BACKOFF_MS) * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await doFetch(`${cfg.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "X-Service-Name": cfg.serviceName,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const why = (name === "TimeoutError" || name === "AbortError") && timeoutMs !== null ? `no answer within ${timeoutMs / 1000} s` : (error as Error)?.message || "network error";
      last = new RagError(`rag-api did not answer: ${why}`, null, true);
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const detail = await detailOf(res);
    last = new RagError(`rag-api answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status, retryableStatus(res.status));
    if (!last.retryable) throw last;
  }
  throw last!;
}

/**
 * Index (or re-index) one document: rag-api replaces every chunk stored under its doc_id. Waits for rag-api's answer
 * and tries once (see the top of this file); the job queue retries a failure.
 */
export function ingestDocument(cfg: RagConfig, doc: RagDocument, opts: RagClientOpts = {}): Promise<IngestResult> {
  return call<IngestResult>(cfg, "POST", "/ingest", { collection: cfg.collection, doc_id: doc.docId, title: doc.title, source: doc.source, text: doc.text, metadata: doc.metadata }, { timeoutMs: null, retries: 0, ...opts });
}

/** Remove every chunk of one document from the collection. Succeeds when there was nothing to remove. */
export async function deleteDocument(cfg: RagConfig, docId: string, opts: RagClientOpts = {}): Promise<void> {
  await call(cfg, "DELETE", `/documents/${encodeURIComponent(docId)}?collection=${encodeURIComponent(cfg.collection)}`, undefined, opts);
}

/** Hybrid (dense + sparse, RRF) retrieval only: include_answer is false, so no LLM is called and nothing is spent. */
export function queryCollection(cfg: RagConfig, q: { query: string; topK: number; filters?: Record<string, RagFilterValue> }, opts: RagClientOpts = {}): Promise<QueryResult> {
  return call<QueryResult>(cfg, "POST", "/query", { collection: cfg.collection, query: q.query, top_k: q.topK, filters: q.filters, include_answer: false }, opts);
}
