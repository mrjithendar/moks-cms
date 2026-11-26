import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { adminMcpEnabled, agentToken, orchestratorSetting, publicMcpEnabled, type Orchestrator } from "./config";

/**
 * Where the seo-agent is, and whether it is on (docs/seo/FLOWS.md "Finding the SEO agent").
 *
 * The agent is optional (seo-agent/ in this repository; since D-105 the same image, run as a second container of the
 * site's pod: SEO_AGENT_URL=http://127.0.0.1:8080). Without it the web worker runs the SEO jobs itself (the legacy path)
 * and the agent-only features are off: Ask the Blog, the MCP servers, Improve, promotion runs.
 *
 * The endpoint, first match wins:
 * 1. SEO_AGENT_URL, when the deployment sets it;
 * 2. the endpoint an admin saved (Admin → Automation & AI → SEO agent; setting "seo_agent");
 * 3. discovery: http://seo-agent:8080 (a Service named seo-agent in the web app's namespace, or a compose service),
 *    then http://seo-agent.<namespace>.svc.cluster.local:8080 when the namespace is known (POD_NAMESPACE, or the
 *    service-account file when it is mounted).
 * The agent is on when that endpoint answers GET /healthz as the agent does ({"status": "ok", "version": …}) and
 * SEO_AGENT_TOKEN is set. Otherwise it is disabled.
 *
 * SEO_ORCHESTRATOR overrides the check: "legacy" switches the agent off whatever answers; "crewai" (or its v3 alias
 * "langgraph") switches it on without probing. Unset (the default) means the check above.
 *
 * Each process keeps the answer for a while (60 s when on, 30 s when off) and refreshes it in the background, so after
 * the first check no request waits for a probe. Saving the endpoint clears this process's copy; the other replicas
 * follow within those 30 to 60 seconds.
 */

export const AGENT_SETTING_KEY = "seo_agent";
export const AGENT_PORT = 8080;
const PROBE_TIMEOUT_MS = 1_500;
const TTL_ON_MS = 60_000;
const TTL_OFF_MS = 30_000;
const SA_NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

type Env = Record<string, string | undefined>;
export type AgentSource = "env" | "admin" | "discovered";
export type AgentStatus = {
  /** The agent is used: flows, Ask the Blog, MCP, Improve. */
  enabled: boolean;
  /** "auto": found by the check above; "forced on" / "forced off": SEO_ORCHESTRATOR. */
  mode: "auto" | "forced on" | "forced off";
  /** The endpoint calls go to (when enabled), or the one that did not answer. */
  url: string | null;
  source: AgentSource | null;
  /** The agent's version from /healthz (null when not probed or not reachable). */
  version: string | null;
  /** One line for admins: why it is on or off. */
  reason: string;
  /** The admin's saved endpoint (null: none). */
  adminUrl: string | null;
  /** SEO_AGENT_URL is set: the admin endpoint is not used. */
  envUrl: string | null;
  /** The addresses discovery tried (empty when an endpoint was given). */
  tried: string[];
  checkedAt: string;
};

export type EndpointDeps = { env?: Env; fetchImpl?: typeof fetch; readAdminUrl?: () => Promise<string | null> };

/** "http(s)://host[:port][/prefix]" without credentials, query or fragment, and without a trailing slash. */
export function normalizeEndpoint(raw: string): string {
  const text = raw.trim();
  if (!text) throw new EndpointError("Enter the agent's address, e.g. http://seo-agent.my-namespace:8080.");
  if (text.length > 300) throw new EndpointError("The address is too long.");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new EndpointError("Not a valid address. Use http://host:port, e.g. http://seo-agent:8080.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new EndpointError("Use an http:// or https:// address.");
  if (u.username || u.password) throw new EndpointError("Leave user names and passwords out of the address: the agent uses SEO_AGENT_TOKEN.");
  if (u.search || u.hash) throw new EndpointError("Leave the query string and fragment out of the address.");
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

export class EndpointError extends Error {
  readonly status = 400;
}

const envUrlOf = (env: Env) => {
  const v = env.SEO_AGENT_URL?.trim();
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

/** The addresses discovery tries, in order. */
export async function discoveryCandidates(env: Env = process.env): Promise<string[]> {
  const out = [`http://seo-agent:${AGENT_PORT}`];
  const ns = await namespaceOf(env);
  if (ns) out.push(`http://seo-agent.${ns}.svc.cluster.local:${AGENT_PORT}`);
  return out;
}

/** GET <url>/healthz: does an seo-agent answer there? */
export async function probeAgent(url: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store", redirect: "error" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { status?: unknown; version?: unknown } | null;
    if (body?.status !== "ok" || typeof body.version !== "string") return { ok: false, error: "it answered, but not as the SEO agent" };
    return { ok: true, version: body.version.slice(0, 40) };
  } catch (e) {
    const name = (e as Error).name;
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "no answer" : "unreachable" };
  }
}

/** The admin's saved endpoint, or null. A database that is not reachable or not migrated reads as none. */
export async function readAdminEndpoint(): Promise<string | null> {
  try {
    const db = await getDb();
    const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, AGENT_SETTING_KEY));
    const url = (row?.value as { url?: unknown } | undefined)?.url;
    return typeof url === "string" && url ? normalizeEndpoint(url) : null;
  } catch {
    return null;
  }
}

/** Save (or with null, remove) the admin's endpoint. Returns before/after for the audit log. */
export async function saveAdminEndpoint(raw: string | null, actorId: string): Promise<{ before: string | null; after: string | null }> {
  const after = raw === null || raw.trim() === "" ? null : normalizeEndpoint(raw);
  const before = await readAdminEndpoint();
  const db = await getDb();
  if (after === null) await db.delete(schema.setting).where(eq(schema.setting.key, AGENT_SETTING_KEY));
  else
    await db
      .insert(schema.setting)
      .values({ key: AGENT_SETTING_KEY, value: { url: after }, updatedBy: actorId })
      .onConflictDoUpdate({ target: schema.setting.key, set: { value: { url: after }, updatedBy: actorId, updatedAt: new Date() } });
  clearAgentCache();
  return { before, after };
}

const isBuild = (env: Env) => env.NEXT_PHASE === "phase-production-build";

async function resolve(env: Env, deps: EndpointDeps): Promise<AgentStatus> {
  const setting = orchestratorSetting(env);
  const envUrl = envUrlOf(env);
  const tokenOk = Boolean(agentToken(env));
  const base = { envUrl, version: null, tried: [] as string[], checkedAt: new Date().toISOString() };
  if (setting === "legacy") {
    return { ...base, enabled: false, mode: "forced off", url: null, source: null, adminUrl: null, reason: "Switched off: SEO_ORCHESTRATOR=legacy." };
  }
  const adminUrl = envUrl ? null : await (deps.readAdminUrl ?? readAdminEndpoint)();
  const given: { url: string; source: AgentSource } | null = envUrl ? { url: envUrl, source: "env" } : adminUrl ? { url: adminUrl, source: "admin" } : null;
  if (setting === "crewai") {
    const url = given?.url ?? `http://seo-agent:${AGENT_PORT}`;
    return { ...base, enabled: true, mode: "forced on", url, source: given?.source ?? "discovered", adminUrl, reason: tokenOk ? `Switched on: SEO_ORCHESTRATOR=crewai (${url}, not probed).` : `Switched on by SEO_ORCHESTRATOR=crewai (${url}), but SEO_AGENT_TOKEN is not set: every call fails.` };
  }
  if (isBuild(env)) return { ...base, enabled: false, mode: "auto", url: given?.url ?? null, source: given?.source ?? null, adminUrl, reason: "Not checked while building." };
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (given) {
    const p = await probeAgent(given.url, fetchImpl);
    const where = given.source === "env" ? "SEO_AGENT_URL" : "the saved endpoint";
    if (!p.ok) return { ...base, enabled: false, mode: "auto", url: given.url, source: given.source, adminUrl, reason: `Disabled: ${where} (${given.url}) did not answer as the SEO agent (${p.error}).` };
    if (!tokenOk) return { ...base, enabled: false, mode: "auto", url: given.url, source: given.source, adminUrl, version: p.version, reason: `Disabled: the agent answers at ${given.url}, but SEO_AGENT_TOKEN is not set.` };
    return { ...base, enabled: true, mode: "auto", url: given.url, source: given.source, adminUrl, version: p.version, reason: `On: ${where} (${given.url}), version ${p.version}.` };
  }
  const tried = await discoveryCandidates(env);
  const probes = await Promise.all(tried.map(async (url) => ({ url, p: await probeAgent(url, fetchImpl) })));
  const found = probes.find((x) => x.p.ok);
  if (!found || !found.p.ok) {
    return { ...base, tried, enabled: false, mode: "auto", url: null, source: null, adminUrl, reason: `Disabled: no SEO agent found (tried ${tried.join(", ")}). Add its endpoint here to use one elsewhere.` };
  }
  if (!tokenOk) return { ...base, tried, enabled: false, mode: "auto", url: found.url, source: "discovered", adminUrl, version: found.p.version, reason: `Disabled: found the agent at ${found.url}, but SEO_AGENT_TOKEN is not set.` };
  return { ...base, tried, enabled: true, mode: "auto", url: found.url, source: "discovered", adminUrl, version: found.p.version, reason: `On: discovered at ${found.url}, version ${found.p.version}.` };
}

type CacheEntry = { sig: string; status: AgentStatus; expires: number; refreshing: Promise<AgentStatus> | null };
const g = globalThis as unknown as { __seoAgentStatus?: CacheEntry; __seoAgentFirst?: { sig: string; p: Promise<AgentStatus> } };

/** What the status depends on besides the database and the network (tests change the environment between cases). */
const sigOf = (env: Env) => [env.SEO_ORCHESTRATOR ?? "", env.SEO_AGENT_URL ?? "", env.POD_NAMESPACE ?? "", agentToken(env) ? "t" : ""].join("|");

export function clearAgentCache() {
  g.__seoAgentStatus = undefined;
  g.__seoAgentFirst = undefined;
}

/**
 * The agent's status. With the process environment and no test doubles, the answer is cached (see the top of this
 * file); `fresh` checks again now (the admin's "Check again"). SEO_ORCHESTRATOR overrides are never cached.
 */
export async function agentStatus(deps: EndpointDeps = {}, opts: { fresh?: boolean } = {}): Promise<AgentStatus> {
  const env = deps.env ?? process.env;
  const forced = orchestratorSetting(env) !== "auto";
  const doubles = (deps.env !== undefined && deps.env !== process.env) || deps.fetchImpl || deps.readAdminUrl;
  if (forced || doubles) return resolve(env, deps);
  const sig = sigOf(env);
  const now = Date.now();
  const c = g.__seoAgentStatus;
  if (!opts.fresh && c && c.sig === sig) {
    if (now >= c.expires && !c.refreshing) {
      c.refreshing = resolve(env, deps)
        .then((s) => {
          g.__seoAgentStatus = { sig, status: s, expires: Date.now() + (s.enabled ? TTL_ON_MS : TTL_OFF_MS), refreshing: null };
          return s;
        })
        .catch(() => {
          c.refreshing = null;
          return c.status;
        });
    }
    return c.status;
  }
  // First check (or a fresh one): concurrent callers share it.
  if (!opts.fresh && g.__seoAgentFirst?.sig === sig) return g.__seoAgentFirst.p;
  const p: Promise<AgentStatus> = resolve(env, deps).then(
    (s) => {
      g.__seoAgentStatus = { sig, status: s, expires: Date.now() + (s.enabled ? TTL_ON_MS : TTL_OFF_MS), refreshing: null };
      if (g.__seoAgentFirst?.p === p) g.__seoAgentFirst = undefined;
      return s;
    },
    (e: unknown) => {
      // Never keep a failed first check: the next caller tries again.
      if (g.__seoAgentFirst?.p === p) g.__seoAgentFirst = undefined;
      throw e;
    },
  );
  g.__seoAgentFirst = { sig, p };
  return p;
}

export const agentEnabled = async (deps: EndpointDeps = {}) => (await agentStatus(deps)).enabled;

/**
 * Which path SEO work takes: "crewai" when the agent is on, else "legacy" (the web worker runs the SEO jobs itself).
 * Replaces the old SEO_ORCHESTRATOR-only switch (which still forces either way).
 */
export async function orchestrator(deps: EndpointDeps = {}): Promise<Orchestrator> {
  const forced = orchestratorSetting(deps.env ?? process.env);
  if (forced !== "auto") return forced;
  return (await agentEnabled(deps)) ? "crewai" : "legacy";
}

/**
 * The base URL calls go to: SEO_AGENT_URL as given (no probe), else the status's endpoint. Null when the agent is
 * disabled (or forced off).
 */
export async function agentBaseUrl(deps: EndpointDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (orchestratorSetting(env) === "legacy") return null;
  const envUrl = envUrlOf(env);
  if (envUrl) return envUrl;
  const s = await agentStatus(deps);
  return s.enabled ? s.url : null;
}

/**
 * The MCP servers run in the seo-agent (its MCP edge), so each is on only when its switch (PUBLIC_MCP_ENABLED /
 * ADMIN_MCP_ENABLED, mirrored from the agent) is on and the agent is on.
 */
export async function mcpEnabled(which: "public" | "admin", deps: EndpointDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const flag = which === "public" ? publicMcpEnabled(env) : adminMcpEnabled(env);
  return flag && (await agentEnabled(deps).catch(() => false));
}
