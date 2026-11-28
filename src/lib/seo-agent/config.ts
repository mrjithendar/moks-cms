/**
 * SEO switches (docs/seo/FLOWS.md, DECISIONS.md D-54 …).
 *
 * Which path SEO work takes: "crewai" (v4) sends every AI workflow and scheduled SEO job through the seo-agent's CrewAI
 * Flows (drafting, approval → publish_flow, rejection, regeneration, and the sync/audit/recommendations/report jobs,
 * triggered by Kubernetes CronJobs; the in-process scheduler then skips those job types); "legacy" keeps v2's direct
 * Claude path (job queue + Message Batches) and the in-process scheduler. It is "crewai" exactly when the seo-agent is
 * found and answers (endpoint.ts: orchestrator(), agentStatus()); otherwise the agent is disabled.
 */
export type Orchestrator = "legacy" | "crewai";

/**
 * SEO_ORCHESTRATOR as an override: "legacy" forces the agent off, "crewai" (or the v3 alias "langgraph": the LangGraph
 * runtime no longer exists) forces it on without probing; unset or anything else: "auto" (find the agent).
 */
export function orchestratorSetting(env: Record<string, string | undefined> = process.env): Orchestrator | "auto" {
  const v = env.SEO_ORCHESTRATOR?.trim().toLowerCase();
  return v === "crewai" || v === "langgraph" ? "crewai" : v === "legacy" ? "legacy" : "auto";
}

/** Web app → seo-agent bearer token. */
export const agentToken = (env: Record<string, string | undefined> = process.env) => env.SEO_AGENT_TOKEN?.trim() || null;
/** seo-agent → web app callback bearer token (a different secret). */
export const callbackToken = (env: Record<string, string | undefined> = process.env) => env.SEO_AGENT_CALLBACK_TOKEN?.trim() || null;

/**
 * Port of the cluster-internal callback listener on the web pods (0 = off). Off when SEO_ORCHESTRATOR=legacy; otherwise
 * it listens whenever SEO_AGENT_CALLBACK_TOKEN is set (internal-server.ts), because the agent may be found at any time.
 */
export function callbackPort(env: Record<string, string | undefined> = process.env): number {
  if (orchestratorSetting(env) === "legacy") return 0;
  const n = Number(env.SEO_AGENT_CALLBACK_PORT ?? 9465);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

/**
 * Ask the Blog deployment switch: ASK_BLOG_ENABLED=true allows the public widget and /api/ask. Default off. Whether
 * they are actually on is then the admin's setting (lib/seo-agent/ask-settings.ts, askState()): both must be on.
 */
export const askEnabled = (env: Record<string, string | undefined> = process.env) => env.ASK_BLOG_ENABLED?.trim().toLowerCase() === "true";

/** Documentation domains the editorial crew may read (through the SSRF-safe fetcher). Same default as seo-agent. */
export const DEFAULT_DOCS_ALLOWLIST = [
  "kubernetes.io",
  "docs.aws.amazon.com",
  "developer.hashicorp.com",
  "docs.python.org",
  "docs.crewai.com",
  "modelcontextprotocol.io",
  "minikube.sigs.k8s.io",
  "helm.sh",
  "docs.docker.com",
  "istio.io",
  "developer.konghq.com",
  "docs.konghq.com",
  "argo-cd.readthedocs.io",
  "karpenter.sh",
  "keda.sh",
  "velero.io",
  "docs.cilium.io",
  "linkerd.io",
  "prometheus.io",
  "prometheus.github.io",
  "grafana.com",
  "opentelemetry.io",
  "docs.github.com",
  "docs.gitlab.com",
  "docs.ansible.com",
  "developers.cloudflare.com",
  "cloud.google.com",
  "learn.microsoft.com",
  "www.postgresql.org",
  "redis.io",
  "nextjs.org",
  "react.dev",
  "nodejs.org",
  "developer.mozilla.org",
  "go.dev",
  "fastapi.tiangolo.com",
  "docs.pydantic.dev",
  "docs.claude.com",
  "platform.claude.com",
  "docs.langchain.com",
  "man7.org",
  "www.freedesktop.org",
  "systemd.io",
  "docs.kernel.org",
  "www.gnu.org",
];

/** Public read-only MCP server switch (mirrors seo-agent's PUBLIC_MCP_ENABLED; the site shows how to connect only then). */
export const publicMcpEnabled = (env: Record<string, string | undefined> = process.env) => env.PUBLIC_MCP_ENABLED?.trim().toLowerCase() === "true";
/** Admin MCP switch (mirrors seo-agent's ADMIN_MCP_ENABLED): the OAuth endpoints refuse new authorizations while off. */
export const adminMcpEnabled = (env: Record<string, string | undefined> = process.env) => env.ADMIN_MCP_ENABLED?.trim().toLowerCase() === "true";

/**
 * Job types the CrewAI flows own in crewai mode (each runs once, through a flow triggered by its CronJob); the
 * in-process scheduler (seoTick) skips them then. The rest (keywords refresh, retention, outcomes, digest) stay there.
 */
export const FLOW_OWNED_JOBS = ["gsc_sync", "ga4_sync", "technical_scan", "recommendations", "drafts_weekly", "report_weekly", "report_monthly"] as const;

export function docsAllowlist(env: Record<string, string | undefined> = process.env): string[] {
  const v = (env.SEO_AGENT_DOCS_ALLOWLIST ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return v.length ? v : DEFAULT_DOCS_ALLOWLIST;
}
