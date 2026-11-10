/**
 * SEO v3 switches (docs/seo/AGENTS.md, DECISIONS.md D-41 …).
 *
 * SEO_ORCHESTRATOR: "legacy" (default) keeps v2's direct Claude path (job queue + Message Batches); "langgraph" sends
 * draft generation, approval, rejection and regeneration through the seo-agent service. Rollback = set it back to
 * legacy: every v2 code path is still there and drafts created by either path stay reviewable.
 */
export type Orchestrator = "legacy" | "langgraph";

export function orchestrator(env: Record<string, string | undefined> = process.env): Orchestrator {
  return env.SEO_ORCHESTRATOR?.trim().toLowerCase() === "langgraph" ? "langgraph" : "legacy";
}

/** seo-agent base URL (ClusterIP service; never public). */
export function agentUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.SEO_AGENT_URL?.trim() || "http://seo-agent.jithendar:8080").replace(/\/+$/, "");
}

/** Web app → seo-agent bearer token. */
export const agentToken = (env: Record<string, string | undefined> = process.env) => env.SEO_AGENT_TOKEN?.trim() || null;
/** seo-agent → web app callback bearer token (a different secret). */
export const callbackToken = (env: Record<string, string | undefined> = process.env) => env.SEO_AGENT_CALLBACK_TOKEN?.trim() || null;

/** Port of the cluster-internal callback listener on the web pods (0 = off). Off unless the orchestrator is langgraph. */
export function callbackPort(env: Record<string, string | undefined> = process.env): number {
  if (orchestrator(env) !== "langgraph") return 0;
  const n = Number(env.SEO_AGENT_CALLBACK_PORT ?? 9465);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

/** Ask the Blog kill switch: ASK_BLOG_ENABLED=true turns the public widget and /api/ask on. Default off. */
export const askEnabled = (env: Record<string, string | undefined> = process.env) => env.ASK_BLOG_ENABLED?.trim().toLowerCase() === "true";

/** Documentation domains the editorial crew may read (through the SSRF-safe fetcher). Same default as seo-agent. */
export const DEFAULT_DOCS_ALLOWLIST = ["kubernetes.io", "docs.aws.amazon.com", "developer.hashicorp.com", "docs.python.org", "langchain-ai.github.io", "docs.crewai.com", "modelcontextprotocol.io"];

export function docsAllowlist(env: Record<string, string | undefined> = process.env): string[] {
  const v = (env.SEO_AGENT_DOCS_ALLOWLIST ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return v.length ? v : DEFAULT_DOCS_ALLOWLIST;
}
