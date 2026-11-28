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

/** The LiteLLM environment the SEO calls read (lib/llm/client.ts): set it in a test, `delete` it for "no model". */
export const LITELLM_ENV = { LITELLM_BASE_URL: "http://litellm.test:4000/v1", LITELLM_API_KEY: "sk-test-not-real" } as const;
export const useLiteLlm = () => Object.assign(process.env, LITELLM_ENV);
export const noLiteLlm = () => {
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
};

/** What an alias answers as (LiteLLM's x-litellm-model-name). */
const TARGETS: Record<string, string> = { "cms-claude-sonnet-latest": "anthropic/claude-sonnet-5-5", "ops-claude-haiku-latest": "anthropic/claude-haiku-5-5" };

/**
 * A LiteLLM stand-in (Chat Completions, as LiteLLM 1.111 answered a local proxy): each answer is the model's text, or
 * `{ status, error }` for a refusal, or `{ finish_reason }`. Usage: 1200 new input tokens, 2000 read from the cache,
 * 400 out; LiteLLM's charge 0.0068 USD (x-litellm-response-cost).
 */
export function fakeLiteLlm(opts: { answers?: (string | { status?: number; error?: Record<string, unknown>; finish_reason?: string; content?: string })[]; cost?: string } = {}) {
  const calls: FakeCall[] = [];
  const answers = [...(opts.answers ?? [])];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ path: url.pathname, method, body, headers: new Headers(init?.headers) });
    if (url.pathname === "/v1/chat/completions" && method === "POST") {
      const a = answers.shift();
      if (a === undefined) return json({ error: { message: "no fake answer left", type: "internal_server_error" } }, 400);
      if (typeof a === "object" && a.status) return json({ error: a.error ?? { message: "refused" } }, a.status);
      const model = String(body?.model ?? "");
      const content = typeof a === "string" ? a : (a.content ?? "");
      return json(
        { id: `chatcmpl-${calls.length}`, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: typeof a === "object" && a.finish_reason ? a.finish_reason : "stop" }], usage: { prompt_tokens: 3200, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 2000 } } },
        200,
        { "x-litellm-response-cost": opts.cost ?? "0.0068", "x-litellm-model-name": TARGETS[model] ?? model, "x-litellm-call-id": `req_${calls.length}` },
      );
    }
    return json({ error: { message: url.pathname, type: "not_found" } }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const LITELLM_PATH = "/v1/chat/completions";

export const output = (changes: Record<string, unknown>[], summary = "Tightens the search title and fixes alt text.") => JSON.stringify({ summary, changes: changes.map((c) => ({ block_id: "", before: "", after: "", rationale: "Because the evidence says so.", evidence_ref: [], source_urls: [], ...c })) });
