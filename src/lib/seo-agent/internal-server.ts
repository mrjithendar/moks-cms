import { createHash, timingSafeEqual } from "node:crypto";
import { context, propagation } from "@opentelemetry/api";
import { log } from "../log";
import { withSpan } from "../trace";
import { DraftError } from "../seo-intel/drafts";
import * as cb from "./callbacks";
import * as v4 from "./callbacks-v4";
import * as news from "../news/callbacks";
import * as promo from "./callbacks-promotion";
import * as skills from "./skills";
import { crewConfigsCallback } from "../crewai/crews";
import { runHistoryCallbackSettings } from "../crewai/runs";
import { newsCallbackToken } from "../news-agent/config";
import { callbackPort, callbackToken } from "./config";

/**
 * Cluster-internal callback API for the seo-agent and the news agent (docs/seo/AGENTS.md "Callback API").
 *
 * A separate listener in the web process (SEO_AGENT_CALLBACK_PORT, default 9465; on when SEO_AGENT_CALLBACK_TOKEN or
 * NEWS_AGENT_CALLBACK_TOKEN is set), like the metrics port: the Istio VirtualService routes the public site to port
 * 3000 only, so nothing on the internet can reach this; the NetworkPolicy admits only the agents' pods.
 *
 * Every request needs one of two tokens, and the token decides what it may call:
 * - SEO_AGENT_CALLBACK_TOKEN (the seo-agent): every route except the news desk's (`/news/*`, 403).
 * - NEWS_AGENT_CALLBACK_TOKEN (the news agent, mrjithendar/newsroom): NEWS_AGENT_ROUTES only, 403 for the rest. It can
 *   fetch, save news drafts and covers, notify, and read what every crew run reads; it cannot touch other drafts,
 *   publish, or run reports.
 */
export type CallbackResponse = { status: number; body: unknown };
export type CallbackHeaders = Record<string, string | string[] | undefined>;

const header = (h: CallbackHeaders, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const ROUTES: [method: string, pattern: RegExp, handler: (m: RegExpExecArray, body: unknown, q: URLSearchParams, h: CallbackHeaders) => Promise<unknown>][] = [
  // News desk (docs/news/ARCHITECTURE.md): fetch, draft creation, covers, notifications. Never publishing. Only the
  // news agent's token reaches these (NEWS_AGENT_ROUTES); the seo-agent's gets 403.
  ["POST", /^\/news\/fetch$/, (_m, b) => news.newsFetch(b)],
  ["POST", /^\/news\/drafts$/, (_m, b) => news.newsSaveDraft(b)],
  ["POST", /^\/news\/drafts\/([^/]+)\/image$/, (m, b) => news.newsUpdateDraftImage(m[1]!, b)],
  ["POST", /^\/news\/media$/, (_m, b) => news.newsStoreMedia(b)],
  ["POST", /^\/news\/images\/generate$/, (_m, b) => news.newsGenerateImage(b)],
  ["GET", /^\/news\/site-signals$/, () => news.newsSiteSignals()],
  ["POST", /^\/news\/notify$/, (_m, b) => news.newsNotify(b)],
  ["POST", /^\/news\/performance$/, () => news.newsCollectPerformance()],
  // Promotion (docs/seo/PROMOTION.md): channel opportunities, drafted posts and content ideas. Never posting.
  ["POST", /^\/promotion\/collect$/, (_m, b) => promo.promoCollect(b)],
  ["POST", /^\/promotion\/articles\/([^/]+)\/drafts$/, (m, b) => promo.promoSaveDrafts(m[1]!, b)],
  ["POST", /^\/promotion\/ideas\/signals$/, () => promo.promoIdeaSignals()],
  ["POST", /^\/promotion\/ideas$/, (_m, b) => promo.promoSaveIdeas(b)],
  // Agent skills (D-96): the enabled skills the crews match to each run. Read only.
  ["GET", /^\/skills$/, () => skills.agentSkills()],
  // Crew configuration (CrewAI console → Crews, D-98): the active version of each crew. Read only.
  ["GET", /^\/crew-configs$/, () => crewConfigsCallback()],
  // Run history (CrewAI console): whether the agent keeps model-call transcripts (moks-seo-agent/app/run_history.py).
  ["GET", /^\/run-history\/settings$/, () => runHistoryCallbackSettings()],
  // v4 (CrewAI flows + MCP service layer); literal paths before the /drafts/{id} patterns
  ["POST", /^\/jobs\/run$/, (_m, b) => v4.runJob(b)],
  ["GET", /^\/drafts\/open-articles$/, (_m, _b, q) => v4.openDraftArticles(q)],
  ["GET", /^\/review\/queue$/, (_m, _b, q) => v4.reviewQueueCb(q)],
  ["GET", /^\/drafts\/([^/]+)$/, (m) => v4.draftSummary(m[1]!)],
  ["GET", /^\/drafts\/([^/]+)\/diff$/, (m) => v4.draftDiff(m[1]!)],
  ["POST", /^\/drafts\/([^/]+)\/reject$/, (m, b) => v4.rejectDraftCb(m[1]!, b)],
  ["POST", /^\/drafts\/([^/]+)\/notes$/, (m, b) => v4.addNote(m[1]!, b)],
  ["GET", /^\/data\/([a-z-]+)$/, (m, _b, q) => v4.data(m[1]!, q)],
  ["GET", /^\/articles\/topics$/, () => v4.topics()],
  ["POST", /^\/reports\/generate$/, (_m, b) => v4.reportGenerate(b)],
  ["POST", /^\/reports\/([^/]+)\/narrative$/, (m, b) => v4.reportNarrative(m[1]!, b)],
  ["POST", /^\/reports\/([^/]+)\/pdf$/, (m, b) => v4.reportPdf(m[1]!, b)],
  ["POST", /^\/reports\/([^/]+)\/notify$/, (m) => v4.reportNotify(m[1]!)],
  ["POST", /^\/ask-gaps\/cluster$/, () => v4.clusterGaps()],
  // v3
  ["POST", /^\/articles\/([^/]+)\/context$/, (m, b) => cb.articleContext(m[1]!, b)],
  ["POST", /^\/articles\/([^/]+)\/validate$/, (m, b) => cb.validate(m[1]!, b)],
  ["POST", /^\/articles\/([^/]+)\/links$/, (m, b) => cb.planArticleLinks(m[1]!, b)],
  ["GET", /^\/articles\/read$/, (_m, _b, q) => cb.readArticle(q.get("ref") ?? "")],
  ["GET", /^\/articles\/published$/, () => cb.publishedArticles()],
  ["POST", /^\/drafts\/([^/]+)\/save$/, (m, b) => cb.saveDraft(m[1]!, b)],
  ["POST", /^\/drafts\/([^/]+)\/status$/, (m, b) => cb.setDraftStatus(m[1]!, b)],
  // Idempotency-Key = the approval id: a retried publish whose first attempt committed gets that result back (publish.ts).
  ["POST", /^\/drafts\/([^/]+)\/publish$/, (m, b, _q, h) => cb.publish(m[1]!, b, header(h, "idempotency-key"))],
  ["POST", /^\/drafts\/([^/]+)\/verify$/, (m, b) => cb.verify(m[1]!, b)],
  ["POST", /^\/drafts\/([^/]+)\/submit$/, (m) => cb.submit(m[1]!)],
  ["GET", /^\/gsc\/queries$/, (_m, _b, q) => cb.gscQueries(q)],
  ["POST", /^\/fetch-docs$/, (_m, b) => cb.fetchDocs(b)],
  ["POST", /^\/weekly\/candidates$/, (_m, b) => cb.weeklyCandidates(b)],
  ["GET", /^\/calendar\/([^/]+)\/brief$/, (m) => cb.calendarBrief(m[1]!)],
  ["GET", /^\/storage\/lancedb$/, () => cb.lancedbStorage()],
  ["GET", /^\/storage\/lancedb$/, () => cb.lancedbStorage()],
];

/**
 * What the news agent's token may call (mrjithendar/newsroom app/webapp.py CALLBACK_ROUTES; its contract test parses
 * this list): the news desk's own routes, Search Console queries for the crew's tool, and what every crew run reads.
 */
export const NEWS_AGENT_ROUTES: readonly (readonly [method: string, pattern: RegExp])[] = [
  ["POST", /^\/news\/fetch$/],
  ["POST", /^\/news\/drafts$/],
  ["POST", /^\/news\/drafts\/([^/]+)\/image$/],
  ["POST", /^\/news\/media$/],
  ["POST", /^\/news\/images\/generate$/],
  ["GET", /^\/news\/site-signals$/],
  ["POST", /^\/news\/notify$/],
  ["POST", /^\/news\/performance$/],
  ["GET", /^\/gsc\/queries$/],
  ["GET", /^\/skills$/],
  ["GET", /^\/crew-configs$/],
  ["GET", /^\/run-history\/settings$/],
];
const NEWS_DESK_PATH = /^\/news\//;

export type Caller = "seo-agent" | "news-agent";

const PREFIX = "/internal/seo-agent";

/** A route pattern as a low-cardinality span name: /drafts/([^/]+)/save → /drafts/:id/save. */
export function routeName(re: RegExp): string {
  return re.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, ":id");
}

export function tokenOk(header: string | undefined, token: string | null): boolean {
  if (!token || token.length < 32 || !header?.startsWith("Bearer ")) return false;
  // Hash both sides first so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** Route one request (also used directly by tests). */
/** Which agent the token belongs to, or null. The two tokens must differ; if they are equal, it is the seo-agent. */
export function callerOf(authorization: string | undefined, env: Record<string, string | undefined> = process.env): Caller | null {
  if (tokenOk(authorization, callbackToken(env))) return "seo-agent";
  if (tokenOk(authorization, newsCallbackToken(env))) return "news-agent";
  return null;
}

/** Whether `caller` may call `method path` (403 otherwise). */
export function allowed(caller: Caller, method: string, path: string): boolean {
  if (caller === "news-agent") return NEWS_AGENT_ROUTES.some(([m, re]) => m === method && re.test(path));
  return !NEWS_DESK_PATH.test(path);
}

export async function handleCallback(method: string, rawUrl: string, authorization: string | undefined, body: unknown, env: Record<string, string | undefined> = process.env, headers: CallbackHeaders = {}): Promise<CallbackResponse> {
  const caller = callerOf(authorization, env);
  if (!caller) return { status: 401, body: { error: "unauthorized", code: "unauthorized" } };
  const url = new URL(rawUrl, "http://internal");
  if (!url.pathname.startsWith(PREFIX)) return { status: 404, body: { error: "not found", code: "not_found" } };
  const path = url.pathname.slice(PREFIX.length);
  if (!allowed(caller, method, path)) {
    log.warn("agent callback refused for this token", { event: "agent_callback_forbidden", caller, method, route: path.slice(0, 80) });
    const why = caller === "news-agent" ? "This token may call the news desk's routes only." : "The news desk's routes are the news agent's (NEWS_AGENT_CALLBACK_TOKEN).";
    return { status: 403, body: { error: why, code: "forbidden" } };
  }
  for (const [m, re, fn] of ROUTES) {
    const match = re.exec(path);
    if (!match) continue;
    if (m !== method) return { status: 405, body: { error: "method not allowed", code: "method" } };
    // The agent sends traceparent (seo-agent app/webapp.py): this callback becomes a span of the flow run's trace.
    const parent = propagation.extract(context.active(), headers);
    const route = routeName(re);
    try {
      const out = await context.with(parent, () => withSpan(`${caller}.callback ${method} ${route}`, { "http.request.method": method, "http.route": `${PREFIX}${route}` }, () => fn(match, body, url.searchParams, headers)));
      return { status: 200, body: out };
    } catch (e) {
      if (e instanceof cb.CallbackError) return { status: e.status, body: { error: e.message, code: e.code } };
      if (e instanceof DraftError) return { status: e.status, body: { error: e.message, code: e.status === 403 ? "approval_required" : "draft" } };
      log.error("seo agent callback failed", { err: e, operation: "seo_agent_callback", route: re.source.slice(0, 60) });
      return { status: 500, body: { error: "internal error", code: "internal" } };
    }
  }
  return { status: 404, body: { error: "not found", code: "not_found" } };
}

const MAX_BODY = 1_000_000;
/** Report PDFs and news cover uploads (base64) are the large bodies: up to ~10 MB. */
const maxBody = (url: string | undefined) => (/^\/internal\/seo-agent\/(reports\/[^/]+\/pdf|news\/media)$/.test((url ?? "").split("?")[0]!) ? 14_000_000 : MAX_BODY);

/** Start the listener once per process (instrumentation.ts). Returns the port, or null when off. */
/** The listener's port: the seo-agent's setting, or for the news agent alone (SEO_ORCHESTRATOR=legacy) the same default. */
export function listenPort(env: Record<string, string | undefined> = process.env): number {
  const seo = callbackPort(env);
  if (seo) return seo;
  if (!newsCallbackToken(env)) return 0;
  const n = Number(env.SEO_AGENT_CALLBACK_PORT ?? 9465);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

export async function startCallbackServer(env: Record<string, string | undefined> = process.env): Promise<number | null> {
  const port = listenPort(env);
  if (!port) return null;
  // No token: no agent is set up to call back (both are optional), so there is nothing to warn about.
  const tokens: [string, string | null][] = [["SEO_AGENT_CALLBACK_TOKEN", callbackToken(env)], ["NEWS_AGENT_CALLBACK_TOKEN", newsCallbackToken(env)]];
  if (!tokens.some(([, t]) => t)) return null;
  for (const [name, t] of tokens) if (t && t.length < 32) log.warn(`agent callback token ${name} is shorter than 32 characters: refused`, { event: "agent_callback_token_short", token: name });
  if (!tokens.some(([, t]) => t && t.length >= 32)) return null;
  const g = globalThis as unknown as { __seoAgentCallback?: boolean };
  if (g.__seoAgentCallback) return port;
  g.__seoAgentCallback = true;
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    const send = (r: CallbackResponse) => res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(r.body));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBody(req.url)) {
        send({ status: 413, body: { error: "too large" } });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      let body: unknown = undefined;
      if (chunks.length) {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) return send({ status: 415, body: { error: "send JSON" } });
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send({ status: 400, body: { error: "invalid JSON" } });
        }
      }
      handleCallback(req.method ?? "GET", req.url ?? "/", req.headers.authorization, body, env, req.headers).then(send, () => send({ status: 500, body: { error: "internal error" } }));
    });
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  server.unref();
  return port;
}
