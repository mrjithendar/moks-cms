/**
 * SEO switches (docs/seo/FLOWS.md, DECISIONS.md D-54 …).
 *
 * SEO_ORCHESTRATOR: "legacy" (default) keeps v2's direct Claude path (job queue + Message Batches) and the in-process
 * scheduler; "crewai" (v4) sends every AI workflow and scheduled SEO job through the seo-agent's CrewAI Flows: drafting,
 * approval → publish_flow, rejection, regeneration, and the sync/audit/recommendations/report jobs (triggered by
 * Kubernetes CronJobs; the in-process scheduler then skips those job types). Rollback = set it back to legacy.
 * "langgraph" (v3) is accepted as an alias of "crewai": the LangGraph runtime no longer exists.
 */
export type Orchestrator = "legacy" | "crewai";

export function orchestrator(env: Record<string, string | undefined> = process.env): Orchestrator {
  const v = env.SEO_ORCHESTRATOR?.trim().toLowerCase();
  return v === "crewai" || v === "langgraph" ? "crewai" : "legacy";
}

/** seo-agent base URL (ClusterIP service; never public). */
export function agentUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.SEO_AGENT_URL?.trim() || "http://seo-agent.jithendar:8080").replace(/\/+$/, "");
}

/** Web app → seo-agent bearer token. */
export const agentToken = (env: Record<string, string | undefined> = process.env) => env.SEO_AGENT_TOKEN?.trim() || null;
/** seo-agent → web app callback bearer token (a different secret). */
export const callbackToken = (env: Record<string, string | undefined> = process.env) => env.SEO_AGENT_CALLBACK_TOKEN?.trim() || null;

/** Port of the cluster-internal callback listener on the web pods (0 = off). Off unless the orchestrator is crewai. */
export function callbackPort(env: Record<string, string | undefined> = process.env): number {
  if (orchestrator(env) !== "crewai") return 0;
  const n = Number(env.SEO_AGENT_CALLBACK_PORT ?? 9465);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

/** Ask the Blog kill switch: ASK_BLOG_ENABLED=true turns the public widget and /api/ask on. Default off. */
export const askEnabled = (env: Record<string, string | undefined> = process.env) => env.ASK_BLOG_ENABLED?.trim().toLowerCase() === "true";

/** Documentation domains the editorial crew may read (through the SSRF-safe fetcher). Same default as seo-agent. */
export const DEFAULT_DOCS_ALLOWLIST = ["kubernetes.io", "docs.aws.amazon.com", "developer.hashicorp.com", "docs.python.org", "docs.crewai.com", "modelcontextprotocol.io"];

/** Public read-only MCP server switch (mirrors seo-agent's PUBLIC_MCP_ENABLED; the site shows how to connect only then). */
export const publicMcpEnabled = (env: Record<string, string | undefined> = process.env) => env.PUBLIC_MCP_ENABLED?.trim().toLowerCase() === "true";
/** Admin MCP switch (mirrors seo-agent's ADMIN_MCP_ENABLED): the OAuth endpoints refuse new authorizations while off. */
export const adminMcpEnabled = (env: Record<string, string | undefined> = process.env) => env.ADMIN_MCP_ENABLED?.trim().toLowerCase() === "true";

/**
 * Job types the CrewAI flows own in crewai mode (each runs once, through a flow triggered by its CronJob); the
 * in-process scheduler (seoTick) skips them then. The rest (keywords refresh, retention, outcomes, digest) stay there.
 */
export const FLOW_OWNED_JOBS = ["gsc_sync", "ga4_sync", "technical_scan", "recommendations", "drafts_weekly", "drafts_poll", "report_weekly", "report_monthly"] as const;

export function docsAllowlist(env: Record<string, string | undefined> = process.env): string[] {
  const v = (env.SEO_AGENT_DOCS_ALLOWLIST ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return v.length ? v : DEFAULT_DOCS_ALLOWLIST;
}
