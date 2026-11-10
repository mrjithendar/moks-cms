import { createHash, timingSafeEqual } from "node:crypto";
import { log } from "../log";
import { DraftError } from "../seo-intel/drafts";
import * as cb from "./callbacks";
import * as v4 from "./callbacks-v4";
import * as news from "../news/callbacks";
import { callbackPort, callbackToken } from "./config";

/**
 * Cluster-internal callback API for the seo-agent service (docs/seo/AGENTS.md "Callback API").
 *
 * A separate listener in the web process (SEO_AGENT_CALLBACK_PORT, default 9465, on only when SEO_ORCHESTRATOR=crewai),
 * like the metrics port: the Istio VirtualService routes the public site to port 3000 only, so nothing on the internet
 * can reach this; the NetworkPolicy admits only seo-agent pods; every request needs SEO_AGENT_CALLBACK_TOKEN.
 */
export type CallbackResponse = { status: number; body: unknown };

const ROUTES: [method: string, pattern: RegExp, handler: (m: RegExpExecArray, body: unknown, q: URLSearchParams) => Promise<unknown>][] = [
  // News desk (docs/news/ARCHITECTURE.md): fetch, draft creation, covers, notifications. Never publishing.
  ["POST", /^\/news\/fetch$/, (_m, b) => news.newsFetch(b)],
  ["POST", /^\/news\/drafts$/, (_m, b) => news.newsSaveDraft(b)],
  ["POST", /^\/news\/drafts\/([^/]+)\/image$/, (m, b) => news.newsUpdateDraftImage(m[1]!, b)],
  ["POST", /^\/news\/media$/, (_m, b) => news.newsStoreMedia(b)],
  ["POST", /^\/news\/images\/generate$/, (_m, b) => news.newsGenerateImage(b)],
  ["GET", /^\/news\/site-signals$/, () => news.newsSiteSignals()],
  ["POST", /^\/news\/notify$/, (_m, b) => news.newsNotify(b)],
  ["POST", /^\/news\/performance$/, () => news.newsCollectPerformance()],
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
  ["POST", /^\/drafts\/([^/]+)\/publish$/, (m, b) => cb.publish(m[1]!, b)],
  ["POST", /^\/drafts\/([^/]+)\/verify$/, (m, b) => cb.verify(m[1]!, b)],
  ["POST", /^\/drafts\/([^/]+)\/submit$/, (m) => cb.submit(m[1]!)],
  ["GET", /^\/gsc\/queries$/, (_m, _b, q) => cb.gscQueries(q)],
  ["POST", /^\/fetch-docs$/, (_m, b) => cb.fetchDocs(b)],
  ["POST", /^\/weekly\/candidates$/, (_m, b) => cb.weeklyCandidates(b)],
  ["GET", /^\/calendar\/([^/]+)\/brief$/, (m) => cb.calendarBrief(m[1]!)],
];

const PREFIX = "/internal/seo-agent";

export function tokenOk(header: string | undefined, token: string | null): boolean {
  if (!token || token.length < 32 || !header?.startsWith("Bearer ")) return false;
  // Hash both sides first so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** Route one request (also used directly by tests). */
export async function handleCallback(method: string, rawUrl: string, authorization: string | undefined, body: unknown, env: Record<string, string | undefined> = process.env): Promise<CallbackResponse> {
  if (!tokenOk(authorization, callbackToken(env))) return { status: 401, body: { error: "unauthorized", code: "unauthorized" } };
  const url = new URL(rawUrl, "http://internal");
  if (!url.pathname.startsWith(PREFIX)) return { status: 404, body: { error: "not found", code: "not_found" } };
  const path = url.pathname.slice(PREFIX.length);
  for (const [m, re, fn] of ROUTES) {
    const match = re.exec(path);
    if (!match) continue;
    if (m !== method) return { status: 405, body: { error: "method not allowed", code: "method" } };
    try {
      return { status: 200, body: await fn(match, body, url.searchParams) };
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
export async function startCallbackServer(env: Record<string, string | undefined> = process.env): Promise<number | null> {
  const port = callbackPort(env);
  if (!port) return null;
  if (!callbackToken(env) || callbackToken(env)!.length < 32) {
    log.warn("seo agent callback listener not started: SEO_AGENT_CALLBACK_TOKEN missing or shorter than 32 characters", { event: "seo_agent_callback_off" });
    return null;
  }
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
      handleCallback(req.method ?? "GET", req.url ?? "/", req.headers.authorization, body, env).then(send, () => send({ status: 500, body: { error: "internal error" } }));
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
