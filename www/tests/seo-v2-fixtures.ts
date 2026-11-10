import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";

/**
 * Fixtures for the v2 tests: a published article, recommendations with evidence, and a fake Anthropic API
 * (Messages + Message Batches) behind the SDK's `fetch` option. All data is invented test data.
 */
export const ARTICLE_BODY = [
  "Kubernetes ingress controllers route external traffic to Services inside the cluster.",
  "",
  "## Install the controller",
  "",
  "Install it with Helm. The chart creates a Deployment, a Service of type LoadBalancer and the IngressClass that routes traffic for every Ingress in the cluster. This section walks through the values I changed and the ones I left at their defaults, because most outages I have seen start with a default nobody looked at.",
  "",
  "```bash",
  "helm install ingress-nginx ingress-nginx/ingress-nginx",
  "```",
  "",
  "![](/media/diagram.png)",
  "",
  "## Terminate TLS",
  "",
  "Use cert-manager to issue certificates. A ClusterIssuer talks to Let's Encrypt and stores the certificate in a Secret that the Ingress references. Renewal is automatic, which is the main reason to prefer it over copying certificates by hand into every namespace that needs them.",
  "",
  "### Troubleshooting",
  "",
  "If the certificate stays pending, check the Order and Challenge resources. Most failures are DNS records that do not point at the load balancer yet, or an HTTP-01 challenge blocked by a network policy.",
].join("\n");

export async function seedArticle(db: Db, opts: { slug?: string; collection?: "blog" | "news"; title?: string; seoTitle?: string | null; body?: string; authorId?: string } = {}) {
  const [row] = await db
    .insert(schema.post)
    .values({
      collection: opts.collection ?? "blog",
      slug: opts.slug ?? "ingress-tls",
      title: opts.title ?? "Ingress and TLS on Kubernetes",
      description: "How to terminate TLS at a Kubernetes ingress controller with cert-manager, with a worked example and the failure modes to check first.",
      seoTitle: opts.seoTitle === undefined ? "Ingress and TLS on Kubernetes: a worked example" : opts.seoTitle,
      body: opts.body ?? ARTICLE_BODY,
      category: "kubernetes",
      tags: ["kubernetes"],
      contentType: "tutorial",
      status: "published",
      publishedAt: new Date("2026-05-01T00:00:00Z"),
      authorId: opts.authorId ?? "admin",
    })
    .returning();
  return row!;
}

export async function seedRecommendation(db: Db, articleId: string, category: string, opts: { priority?: number; status?: string; metrics?: string[]; query?: string } = {}) {
  const [r] = rowsOf<{ id: string }>(await db.execute(sql`
    insert into seo_recommendations (fingerprint, article_id, url, query, category, rule_key, problem, proposed_action, analysis_date, priority_score, priority_band, confidence, expected_impact, review_status)
    values (${`${category}-${articleId}-${Math.random()}`}, ${articleId}, 'https://jithendar.com/blog/ingress-tls', ${opts.query ?? null}, ${category}, ${`${category}.rule`}, ${`Problem for ${category}`}, ${`Do something about ${category}`}, '2026-11-01', ${opts.priority ?? 0.7}, 'high', 'medium', 'Qualitative', ${opts.status ?? "pending"})
    returning id`));
  const id = r!.id;
  for (const m of opts.metrics ?? ["ctr"]) {
    await db.execute(sql`insert into seo_recommendation_evidence (recommendation_id, metric, period, value, source) values (${id}, ${m}, '28d', 0.01, 'gsc')`);
  }
  return id;
}

export type FakeCall = { path: string; method: string; body: Record<string, unknown> | null; headers: Headers };

/** Fake Anthropic API. `answers` are returned in order for POST /v1/messages (strings = text content, or a full message object). */
export function fakeAnthropic(opts: { answers?: (string | Record<string, unknown>)[]; batchAnswers?: Record<string, string>; batchStatus?: "in_progress" | "ended" } = {}) {
  const calls: FakeCall[] = [];
  const answers = [...(opts.answers ?? [])];
  let batch: { id: string; requests: { custom_id: string }[] } | null = null;
  let status = opts.batchStatus ?? "ended";
  const message = (text: string, extra: Record<string, unknown> = {}) => ({
    id: `msg_${calls.length}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    ...extra,
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": `req_${calls.length}` } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ path: url.pathname, method, body, headers: new Headers(init?.headers) });
    if (url.pathname === "/v1/messages" && method === "POST") {
      const a = answers.shift();
      if (a === undefined) return json({ type: "error", error: { type: "api_error", message: "no fake answer left" } }, 500);
      return json(typeof a === "string" ? message(a) : message("", a));
    }
    if (url.pathname === "/v1/messages/batches" && method === "POST") {
      batch = { id: "msgbatch_test1", requests: (body?.requests as { custom_id: string }[]) ?? [] };
      return json({ id: batch.id, type: "message_batch", processing_status: "in_progress", request_counts: { processing: batch.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, created_at: new Date().toISOString(), expires_at: new Date().toISOString(), ended_at: null, archived_at: null, cancel_initiated_at: null, results_url: null });
    }
    if (url.pathname === "/v1/messages/batches/msgbatch_test1" && method === "GET") {
      return json({ id: "msgbatch_test1", type: "message_batch", processing_status: status, request_counts: { processing: 0, succeeded: batch?.requests.length ?? 0, errored: 0, canceled: 0, expired: 0 }, created_at: new Date().toISOString(), expires_at: new Date().toISOString(), ended_at: status === "ended" ? new Date().toISOString() : null, archived_at: null, cancel_initiated_at: null, results_url: status === "ended" ? "https://api.anthropic.com/v1/messages/batches/msgbatch_test1/results" : null });
    }
    if (url.pathname === "/v1/messages/batches/msgbatch_test1/results") {
      const lines = (batch?.requests ?? []).map((r) => {
        const text = opts.batchAnswers?.[r.custom_id] ?? opts.batchAnswers?.["*"];
        return JSON.stringify(text === undefined ? { custom_id: r.custom_id, result: { type: "errored", error: { type: "error", error: { type: "api_error", message: "x" } } } } : { custom_id: r.custom_id, result: { type: "succeeded", message: message(text) } });
      });
      return new Response(lines.join("\n") + "\n", { status: 200, headers: { "content-type": "application/binary" } });
    }
    return json({ type: "error", error: { type: "not_found_error", message: url.pathname } }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, setBatchStatus: (s: "in_progress" | "ended") => (status = s) };
}

export const output = (changes: Record<string, unknown>[], summary = "Tightens the search title and fixes alt text.") => JSON.stringify({ summary, changes: changes.map((c) => ({ block_id: "", before: "", after: "", rationale: "Because the evidence says so.", evidence_ref: [], source_urls: [], ...c })) });
