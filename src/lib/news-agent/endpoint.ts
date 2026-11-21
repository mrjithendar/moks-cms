import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { EndpointError, normalizeEndpoint } from "../seo-agent/endpoint";
import { newsAgentToken } from "./config";

/**
 * Where the news agent is (mrjithendar/newsroom, its own image), and whether it is on. Same rules as the seo-agent's
 * (../seo-agent/endpoint.ts), for its own service:
 *
 * 1. NEWS_AGENT_URL, when the deployment sets it;
 * 2. the endpoint an admin saved (Newsroom → Settings → News agent; setting "news_agent");
 * 3. discovery: http://news-agent:8080, then http://news-agent.<namespace>.svc.cluster.local:8080.
 *
 * It is on when that endpoint answers GET /healthz as the news agent does ({"status": "ok", "agent": "news", "version"})
 * and NEWS_AGENT_TOKEN is set. Otherwise the Newsroom says "news agent not found" and starts nothing. There is no
 * fallback to the seo-agent: the news desk does not run there any more.
 *
 * Each process keeps the answer for 60 s (on) or 30 s (off) and refreshes it in the background.
 */

export const NEWS_AGENT_SETTING_KEY = "news_agent";
export const NEWS_AGENT_PORT = 8080;
const PROBE_TIMEOUT_MS = 1_500;
const TTL_ON_MS = 60_000;
const TTL_OFF_MS = 30_000;
const SA_NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

type Env = Record<string, string | undefined>;
export type NewsAgentSource = "env" | "admin" | "discovered";
export type NewsAgentStatus = {
  enabled: boolean;
  url: string | null;
  source: NewsAgentSource | null;
  version: string | null;
  reason: string;
  adminUrl: string | null;
  envUrl: string | null;
  tried: string[];
  checkedAt: string;
};
export type NewsEndpointDeps = { env?: Env; fetchImpl?: typeof fetch; readAdminUrl?: () => Promise<string | null> };

export { EndpointError, normalizeEndpoint };

const envUrlOf = (env: Env) => {
  const v = env.NEWS_AGENT_URL?.trim();
  if (!v) return null;
  try {
    return normalizeEndpoint(v);
  } catch {
    return null;
  }
};

async function namespaceOf(env: Env): Promise<string | null> {
  const fromEnv = env.POD_NAMESPACE?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { readFile } = await import("node:fs/promises");
    const ns = (await readFile(SA_NAMESPACE_FILE, "utf8")).trim();
    return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns) ? ns : null;
  } catch {
    return null;
  }
}

export async function newsDiscoveryCandidates(env: Env = process.env): Promise<string[]> {
  const out = [`http://news-agent:${NEWS_AGENT_PORT}`];
  const ns = await namespaceOf(env);
  if (ns) out.push(`http://news-agent.${ns}.svc.cluster.local:${NEWS_AGENT_PORT}`);
  return out;
}

/** GET <url>/healthz: does the news agent answer there (and not some other service)? */
export async function probeNewsAgent(url: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store", redirect: "error" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { status?: unknown; version?: unknown; agent?: unknown } | null;
    if (body?.status !== "ok" || typeof body.version !== "string" || body.agent !== "news") return { ok: false, error: "it answered, but not as the news agent" };
    return { ok: true, version: body.version.slice(0, 40) };
  } catch (e) {
    const name = (e as Error).name;
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "no answer" : "unreachable" };
  }
}

export async function readNewsAgentEndpoint(): Promise<string | null> {
  try {
    const db = await getDb();
    const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, NEWS_AGENT_SETTING_KEY));
    const url = (row?.value as { url?: unknown } | undefined)?.url;
    return typeof url === "string" && url ? normalizeEndpoint(url) : null;
  } catch {
    return null;
  }
}

/** Save (or with null, remove) the admin's endpoint for the news agent. Returns before/after for the audit log. */
export async function saveNewsAgentEndpoint(raw: string | null, actorId: string): Promise<{ before: string | null; after: string | null }> {
  const after = raw === null || raw.trim() === "" ? null : normalizeEndpoint(raw);
  const before = await readNewsAgentEndpoint();
  const db = await getDb();
  if (after === null) await db.delete(schema.setting).where(eq(schema.setting.key, NEWS_AGENT_SETTING_KEY));
  else
    await db
      .insert(schema.setting)
      .values({ key: NEWS_AGENT_SETTING_KEY, value: { url: after }, updatedBy: actorId })
      .onConflictDoUpdate({ target: schema.setting.key, set: { value: { url: after }, updatedBy: actorId, updatedAt: new Date() } });
  clearNewsAgentCache();
  return { before, after };
}

async function resolve(env: Env, deps: NewsEndpointDeps): Promise<NewsAgentStatus> {
  const envUrl = envUrlOf(env);
  const tokenOk = Boolean(newsAgentToken(env));
  const base = { envUrl, version: null, tried: [] as string[], checkedAt: new Date().toISOString() };
  const adminUrl = envUrl ? null : await (deps.readAdminUrl ?? readNewsAgentEndpoint)();
  const given: { url: string; source: NewsAgentSource } | null = envUrl ? { url: envUrl, source: "env" } : adminUrl ? { url: adminUrl, source: "admin" } : null;
  if (env.NEXT_PHASE === "phase-production-build") return { ...base, enabled: false, url: given?.url ?? null, source: given?.source ?? null, adminUrl, reason: "Not checked while building." };
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (given) {
    const p = await probeNewsAgent(given.url, fetchImpl);
    const where = given.source === "env" ? "NEWS_AGENT_URL" : "the saved endpoint";
    if (!p.ok) return { ...base, enabled: false, url: given.url, source: given.source, adminUrl, reason: `News agent not found: ${where} (${given.url}) did not answer as the news agent (${p.error}).` };
    if (!tokenOk) return { ...base, enabled: false, url: given.url, source: given.source, adminUrl, version: p.version, reason: `The news agent answers at ${given.url}, but NEWS_AGENT_TOKEN is not set.` };
    return { ...base, enabled: true, url: given.url, source: given.source, adminUrl, version: p.version, reason: `On: ${where} (${given.url}), version ${p.version}.` };
  }
  const tried = await newsDiscoveryCandidates(env);
  const probes = await Promise.all(tried.map(async (url) => ({ url, p: await probeNewsAgent(url, fetchImpl) })));
  const found = probes.find((x) => x.p.ok);
  if (!found || !found.p.ok) return { ...base, tried, enabled: false, url: null, source: null, adminUrl, reason: `News agent not found (tried ${tried.join(", ")}). Deploy it (image news-agent) or add its endpoint here.` };
  if (!tokenOk) return { ...base, tried, enabled: false, url: found.url, source: "discovered", adminUrl, version: found.p.version, reason: `Found the news agent at ${found.url}, but NEWS_AGENT_TOKEN is not set.` };
  return { ...base, tried, enabled: true, url: found.url, source: "discovered", adminUrl, version: found.p.version, reason: `On: discovered at ${found.url}, version ${found.p.version}.` };
}

type CacheEntry = { sig: string; status: NewsAgentStatus; expires: number; refreshing: Promise<NewsAgentStatus> | null };
const g = globalThis as unknown as { __newsAgentStatus?: CacheEntry };
const sigOf = (env: Env) => [env.NEWS_AGENT_URL ?? "", env.POD_NAMESPACE ?? "", newsAgentToken(env) ? "t" : ""].join("|");

export function clearNewsAgentCache() {
  g.__newsAgentStatus = undefined;
}

/** The news agent's status: cached per process (see the top of this file); `fresh` checks again now. */
export async function newsAgentStatus(deps: NewsEndpointDeps = {}, opts: { fresh?: boolean } = {}): Promise<NewsAgentStatus> {
  const env = deps.env ?? process.env;
  const doubles = (deps.env !== undefined && deps.env !== process.env) || deps.fetchImpl || deps.readAdminUrl;
  if (doubles) return resolve(env, deps);
  const sig = sigOf(env);
  const c = g.__newsAgentStatus;
  if (!opts.fresh && c && c.sig === sig) {
    if (Date.now() >= c.expires && !c.refreshing) {
      c.refreshing = resolve(env, deps)
        .then((s) => {
          g.__newsAgentStatus = { sig, status: s, expires: Date.now() + (s.enabled ? TTL_ON_MS : TTL_OFF_MS), refreshing: null };
          return s;
        })
        .catch(() => {
          c.refreshing = null;
          return c.status;
        });
    }
    return c.status;
  }
  const s = await resolve(env, deps);
  g.__newsAgentStatus = { sig, status: s, expires: Date.now() + (s.enabled ? TTL_ON_MS : TTL_OFF_MS), refreshing: null };
  return s;
}

/** The base URL calls go to: NEWS_AGENT_URL as given (no probe), else the status's endpoint. Null when not found. */
export async function newsAgentBaseUrl(deps: NewsEndpointDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const envUrl = envUrlOf(env);
  if (envUrl) return envUrl;
  const s = await newsAgentStatus(deps);
  return s.enabled ? s.url : null;
}
