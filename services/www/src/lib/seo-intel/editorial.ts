import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { AnalysisData, Article } from "./data";
import { fingerprint, type Candidate } from "./rules";
import { scoreOf } from "./scoring";
import type { SeoSettings } from "./settings";

/**
 * Editorial suggestions grounded in the site's own articles, categories and Search Console queries.
 * - "measured": backed by GSC demand (a content-gap query); evidence lists the numbers. Skipped when the query is
 *   already a published article's subject, or is a "vs" between two different themes (e.g. "shell scripting vs fastapi").
 * - "editorial_idea": one specific topic (Theme.topics) that no published article covers yet, in the theme the
 *   publication covers least; speculative, no search data behind it. Never a whole theme: a brief as wide as
 *   "Terraform & IaC" made the crew's researcher fetch and copy documentation until its answer was cut off.
 * Coverage counts an article towards every theme its title or tags name (whole words), not only its best match.
 * Titles are kept to 60 characters (what search results show). At most MAX_OPEN_IDEAS ideas wait as "suggested";
 * a topic already on the calendar (any status, dropped included) is not suggested again.
 * Suggestions land in seo_editorial_calendar as "suggested" (shown as unscheduled); a person generates, improves and
 * schedules them there (calendar.ts, D-94). Existing calendar items are never overwritten (a human may have edited
 * them). calendar-auto.ts adds ideas from the AI, the ML query clusters and Google Analytics next to these.
 */
export type Topic = { name: string; match: string[] };
export type Theme = { cluster: string; category: string; keywords: string[]; audience: string; diagram: string; code: string; topics: Topic[] };

const t = (name: string, ...match: string[]): Topic => ({ name, match: match.length ? match : [name] });

export const THEMES: Theme[] = [
  { cluster: "DevOps & CI/CD", category: "devops-sre", keywords: ["ci/cd", "cicd", "pipeline", "github actions", "jenkins", "gitops", "devops"], audience: "DevOps engineers automating delivery", diagram: "pipeline stages from commit to production", code: "workflow YAML", topics: [t("GitHub Actions reusable workflows", "reusable workflow"), t("Argo CD ApplicationSets", "applicationset"), t("Caching in CI pipelines", "ci cache", "build cache"), t("Blue-green and canary deployments", "canary", "blue-green")] },
  { cluster: "AWS", category: "aws-cloud", keywords: ["aws", "iam", "vpc", "s3", "lambda", "ecr", "cloudfront", "bedrock"], audience: "cloud engineers on AWS", diagram: "AWS architecture with network boundaries", code: "AWS CLI / Terraform snippets", topics: [t("IAM roles for service accounts on EKS", "irsa", "pod identity"), t("AWS Lambda cold starts", "cold start"), t("S3 lifecycle rules and storage classes", "s3 lifecycle", "storage class"), t("CloudFront in front of an origin", "cloudfront")] },
  { cluster: "Kubernetes & EKS", category: "kubernetes", keywords: ["kubernetes", "k8s", "eks", "helm", "kubectl", "ingress", "pod", "argo"], audience: "platform engineers running Kubernetes", diagram: "cluster components and traffic flow", code: "manifests and kubectl commands", topics: [t("Kubernetes resource requests and limits", "requests and limits", "resource limits"), t("Horizontal Pod Autoscaler", "hpa", "autoscaler"), t("Kubernetes NetworkPolicy", "networkpolicy", "network policy"), t("Helm chart testing", "helm test", "chart testing")] },
  { cluster: "Terraform & IaC", category: "infrastructure-as-code", keywords: ["terraform", "opentofu", "iac", "kustomize", "pulumi", "state"], audience: "engineers managing infrastructure as code", diagram: "module and state layout", code: "HCL modules and plan output", topics: [t("OpenTofu", "opentofu"), t("Terraform remote state and locking", "remote state", "state locking"), t("Testing Terraform modules", "terraform test", "terratest"), t("Pulumi", "pulumi"), t("Kustomize overlays", "kustomize")] },
  { cluster: "Linux", category: "devops-sre", keywords: ["linux", "bash", "systemd", "shell", "ssh"], audience: "engineers operating Linux servers", diagram: "process / service relationships", code: "shell commands with expected output", topics: [t("systemd services and timers", "systemd"), t("SSH hardening", "ssh hardening", "sshd"), t("Bash error handling", "set -euo pipefail", "bash error"), t("Linux disk and inode troubleshooting", "inode", "disk full")] },
  { cluster: "Observability & SRE", category: "devops-sre", keywords: ["prometheus", "grafana", "loki", "opentelemetry", "otel", "slo", "sre", "alert", "tracing"], audience: "SREs owning reliability", diagram: "telemetry pipeline", code: "PromQL / collector config", topics: [t("Writing SLOs and error budgets", "slo", "error budget"), t("PromQL for alerting", "promql"), t("OpenTelemetry Collector pipelines", "opentelemetry collector", "otel collector"), t("Loki log queries", "logql", "loki")] },
  { cluster: "Platform engineering", category: "devops-sre", keywords: ["platform engineering", "internal developer platform", "backstage", "golden path"], audience: "platform teams", diagram: "platform capabilities map", code: "templates and policy examples", topics: [t("Backstage software templates", "backstage"), t("Golden paths for new services", "golden path"), t("Self-service environments", "self-service", "preview environment")] },
  { cluster: "Python", category: "ai-engineering", keywords: ["python", "pandas", "fastapi", "asyncio", "pytest"], audience: "Python developers", diagram: "module / data-flow sketch", code: "runnable Python with tests", topics: [t("pytest fixtures", "pytest"), t("asyncio in practice", "asyncio"), t("FastAPI dependency injection", "fastapi"), t("Python packaging with uv", "uv", "pyproject")] },
  { cluster: "JavaScript / TypeScript", category: "ai-engineering", keywords: ["javascript", "typescript", "node", "next.js", "react"], audience: "JS/TS developers", diagram: "request lifecycle", code: "TypeScript examples", topics: [t("TypeScript strict mode", "strict mode", "tsconfig"), t("Next.js caching", "next.js cache", "revalidate"), t("Node.js streams", "node streams", "node.js streams")] },
  { cluster: "AI engineering & RAG", category: "ai-engineering", keywords: ["rag", "retrieval", "embedding", "vector", "llm", "prompt", "eval"], audience: "engineers shipping LLM features", diagram: "retrieval and generation pipeline", code: "Python/TS retrieval code with evaluation", topics: [t("Evaluating a RAG pipeline", "rag eval", "ragas"), t("Chunking strategies for RAG", "chunking"), t("Hybrid search and reranking", "hybrid search", "reranker", "rerank")] },
  { cluster: "Agents, MCP & frameworks", category: "ai-agents", keywords: ["agent", "agentic", "mcp", "model context protocol", "langgraph", "crewai", "tool use"], audience: "engineers building AI agents", diagram: "agent loop with tools and guardrails", code: "agent graph / MCP server code", topics: [t("Building an MCP server", "mcp server"), t("Tool-use guardrails for agents", "guardrail"), t("CrewAI flows and crews", "crewai"), t("LangGraph state machines", "langgraph")] },
  { cluster: "LLMOps & MLOps", category: "mlops", keywords: ["llmops", "mlops", "model serving", "monitoring", "fine-tuning", "inference"], audience: "ML platform engineers", diagram: "model lifecycle", code: "deployment and monitoring config", topics: [t("Serving models with vLLM", "vllm"), t("Prompt versioning and evaluation", "prompt version", "prompt eval"), t("Monitoring LLM cost and latency", "llm cost", "token usage")] },
  { cluster: "Security & networking", category: "cybersecurity", keywords: ["security", "cve", "tls", "mtls", "network policy", "zero trust", "firewall", "supply chain", "istio"], audience: "engineers hardening cloud workloads", diagram: "trust boundaries", code: "policy and config examples", topics: [t("mTLS with Istio", "mtls"), t("Supply-chain security with SBOMs", "sbom", "cosign"), t("Kubernetes secrets management", "external secrets", "sealed secrets", "sops"), t("Zero-trust access", "zero trust")] },
];

const lc = (s: string) => s.toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const wordRe = new Map<string, RegExp>();
/** Whole-word (or whole-phrase) match, plural "s" allowed: "pod" matches "pods" but not "podcast", "state" not "statement". */
export function hasTerm(text: string, term: string): boolean {
  let re = wordRe.get(term);
  if (!re) wordRe.set(term, (re = new RegExp(`(^|[^a-z0-9])${escape(lc(term))}s?($|[^a-z0-9])`)));
  return re.test(lc(text));
}

/** The theme a query or title is mostly about (most keyword hits; null if none). */
export function themeOf(text: string): Theme | null {
  let best: { theme: Theme; hits: number } | null = null;
  for (const theme of THEMES) {
    const hits = theme.keywords.filter((k) => hasTerm(text, k)).length;
    if (hits && (!best || hits > best.hits)) best = { theme, hits };
  }
  return best?.theme ?? null;
}

const articleText = (a: Article) => `${a.title} ${a.tags.join(" ")}`;
/** Every theme an article's title or tags name: a Terraform-on-EKS post counts for both themes. */
export function themesOfArticle(a: Article): Theme[] {
  return THEMES.filter((theme) => theme.keywords.some((k) => hasTerm(articleText(a), k)));
}
export const topicCovered = (topic: Topic, articles: Article[]) => articles.some((a) => topic.match.some((m) => hasTerm(`${articleText(a)} ${a.description}`, m)));

function intentOf(q: string): "how-to" | "explainer" | "comparison" | "troubleshooting" | "reference" {
  if (/^(how to|how do|how can)\b/.test(q)) return "how-to";
  if (/\bvs\.?\b|\bversus\b|\bcompar|\balternatives?\b/.test(q)) return "comparison";
  if (/\berror\b|\bfail|\bnot working\b|\bfix\b|\btroubleshoot/.test(q)) return "troubleshooting";
  if (/^(what is|what are|why)\b/.test(q)) return "explainer";
  return "reference";
}

const cap = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
export const MAX_TITLE = 60;

/** Keep a title to MAX_TITLE characters: drop the ": subtitle" first, then cut at a word boundary. */
export function fitTitle(title: string, max = MAX_TITLE): string {
  if (title.length <= max) return title;
  const head = title.split(/:\s/)[0]!;
  if (head.length <= max) return head;
  const cut = head.slice(0, max + 1).replace(/\s+\S*$/, "");
  return (cut || head.slice(0, max)).replace(/[\s,;:–-]+$/, "");
}

export function titleFor(q: string): string {
  const intent = intentOf(q);
  const clean = q.replace(/\s+/g, " ").trim();
  if (intent === "how-to") return fitTitle(cap(clean) + ": a step-by-step guide");
  if (intent === "comparison") return fitTitle(cap(clean) + ": differences and when to use each");
  if (intent === "troubleshooting") return fitTitle(cap(clean) + ": causes and fixes");
  if (intent === "explainer") return fitTitle(cap(clean.replace(/\?$/, "")) + "? A practical explanation");
  return fitTitle(cap(clean) + ": a practical guide");
}

const STOP = new Set(["how", "to", "the", "and", "what", "is", "are", "a", "an", "for", "with", "in", "on", "of", "vs", "versus", "do", "i", "can", "why", "guide", "tutorial", "example"]);
const queryTerms = (q: string) => lc(q).split(/[^a-z0-9.#+/-]+/).filter((w) => w.length > 1 && !STOP.has(w));

/** Why a content-gap query should not become a calendar item (null: keep it). */
export function skipMeasured(q: string, articles: Article[]): string | null {
  const vs = lc(q).split(/\s+(?:vs\.?|versus)\s+/);
  if (vs.length === 2) {
    const [a, b] = vs.map((side) => themeOf(side));
    if (a && b && a.cluster !== b.cluster) return "compares two different themes";
  }
  const terms = queryTerms(q);
  if (terms.length && articles.some((a) => terms.every((w) => hasTerm(a.title, w)))) return "already the subject of a published article";
  return null;
}

function outlineFor(intent: ReturnType<typeof intentOf>, topic: string): string[] {
  switch (intent) {
    case "how-to":
      return ["What you will build and prerequisites", `Step-by-step: ${topic}`, "Verify it works", "Common mistakes", "Next steps"];
    case "comparison":
      return ["Short answer", "How each option works", "Comparison table", "When to choose which", "Migration notes"];
    case "troubleshooting":
      return ["Symptoms", "Likely causes", "Diagnose step by step", "Fixes", "Prevent it next time"];
    case "explainer":
      return [`${topic} in one paragraph`, "How it works", "A worked example", "Trade-offs and pitfalls", "Further reading"];
    default:
      return ["Overview", "Core concepts", "Hands-on example", "Production considerations", "Summary"];
  }
}

const relatedArticles = (articles: Article[], theme: Theme | null, terms: string[]) =>
  articles
    .map((a) => ({ a, s: (theme && themesOfArticle(a).includes(theme) ? 1 : 0) + terms.filter((w) => hasTerm(articleText(a), w)).length }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, 3)
    .map((x) => ({ id: x.a.id, title: x.a.title, path: x.a.path }));

/** Editorial ideas waiting as "suggested" at most; dropping or approving one makes room for the next. */
export const MAX_OPEN_IDEAS = 6;

export async function generateEditorialSuggestions(db: Db, s: SeoSettings, d: AnalysisData, candidates: Candidate[], now = new Date()): Promise<number> {
  void now;
  const bands = { high: s.thresholds.bandHigh, medium: s.thresholds.bandMedium };
  let created = 0;
  const insert = async (fp: string, item: Record<string, unknown>) => {
    const rows = rowsOf<{ id: string }>(await db.execute(sql`
      insert into seo_editorial_calendar (fingerprint, title, status, kind, category, cluster, priority_score, priority_band, recommendation_id, brief, evidence)
      values (${fp}, ${item.title as string}, 'suggested', ${item.kind as string}, ${(item.category as string) ?? null}, ${(item.cluster as string) ?? null}, ${item.score as number}, ${item.band as string},
        ${(item.recommendationId as string) ?? null}, ${JSON.stringify(item.brief)}::jsonb, ${JSON.stringify(item.evidence)}::jsonb)
      on conflict (fingerprint) do nothing returning id`));
    created += rows.length;
    return rows.length > 0;
  };

  // Measured: one brief per content-gap query (top 10 by score), minus the ones skipMeasured rules out.
  const gaps = candidates
    .filter((c) => c.category === "content_gap" && c.query && !skipMeasured(c.query, d.articles))
    .map((c) => ({ c, sc: scoreOf(c.inputs, s.weights, bands) }))
    .sort((a, b) => b.sc.score - a.sc.score)
    .slice(0, 10);
  for (const { c, sc } of gaps) {
    const q = c.query!;
    const theme = themeOf(q);
    const intent = intentOf(q);
    const recId = rowsOf<{ id: string }>(await db.execute(sql`select id from seo_recommendations where fingerprint = ${c.fingerprint}`))[0]?.id ?? null;
    const supporting = d.pageQuery.filter((r) => r.query === q || (theme && theme.keywords.some((k) => hasTerm(r.query, k)) && r.query.includes(q.split(" ")[0]!))).sort((a, b) => b.impressions - a.impressions).slice(0, 8).map((r) => r.query);
    await insert(fingerprint("editorial", "measured", q), {
      title: titleFor(q),
      kind: "measured",
      category: theme?.category ?? null,
      cluster: theme?.cluster ?? "Uncategorised",
      score: sc.score,
      band: sc.band,
      recommendationId: recId,
      brief: {
        audience: theme?.audience ?? "engineers searching for this topic",
        intent,
        supportingQueries: [...new Set([q, ...supporting])],
        gap: c.problem,
        outline: outlineFor(intent, q),
        codeExamples: theme ? [theme.code] : ["minimal runnable example"],
        diagrams: theme ? [theme.diagram] : [],
        internalLinks: relatedArticles(d.articles, theme, queryTerms(q)),
        readingTimeMinutes: intent === "how-to" || intent === "troubleshooting" ? 10 : 7,
      },
      evidence: c.evidence,
    });
  }

  // Editorial ideas: one uncovered topic per theme, least-covered themes first. Speculative; no search data.
  const known = new Set(rowsOf<{ fingerprint: string | null }>(await db.execute(sql`select fingerprint from seo_editorial_calendar where fingerprint is not null`)).map((r) => r.fingerprint));
  const [{ n: open } = { n: 0 }] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_editorial_calendar where kind = 'editorial_idea' and status = 'suggested'`));
  let room = MAX_OPEN_IDEAS - Number(open);
  const coverage = new Map(THEMES.map((theme) => [theme.cluster, 0]));
  for (const a of d.articles) for (const theme of themesOfArticle(a)) coverage.set(theme.cluster, coverage.get(theme.cluster)! + 1);
  const byCoverage = [...THEMES].sort((x, y) => coverage.get(x.cluster)! - coverage.get(y.cluster)!);
  for (const theme of byCoverage) {
    if (room <= 0) break;
    const topic = theme.topics.find((tp) => !known.has(fingerprint("editorial", "idea", theme.cluster, tp.name)) && !topicCovered(tp, d.articles));
    if (!topic) continue;
    const n = coverage.get(theme.cluster)!;
    const made = await insert(fingerprint("editorial", "idea", theme.cluster, topic.name), {
      title: fitTitle(`${topic.name}: a practical guide`),
      kind: "editorial_idea",
      category: theme.category,
      cluster: theme.cluster,
      score: 0.2,
      band: "low",
      brief: {
        audience: theme.audience,
        intent: "explainer",
        supportingQueries: [],
        gap: `The publication has ${n} published article(s) on ${theme.cluster}, none on ${topic.name}. This is an editorial idea, not backed by search data.`,
        outline: outlineFor("explainer", topic.name),
        codeExamples: [theme.code],
        diagrams: [theme.diagram],
        internalLinks: relatedArticles(d.articles, theme, topic.match),
        readingTimeMinutes: 8,
        notes: `Scope: ${topic.name} only. This is not a general overview of ${theme.cluster}; link to the related articles instead of repeating them.`,
      },
      evidence: [
        { metric: "published_articles_in_theme", period: "current", value: n, source: "cms" },
        { metric: "published_articles_on_topic", period: "current", value: 0, source: "cms" },
      ],
    });
    if (made) room--;
  }
  return created;
}
