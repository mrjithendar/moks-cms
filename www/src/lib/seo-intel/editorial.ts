import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { AnalysisData, Article } from "./data";
import { fingerprint, type Candidate } from "./rules";
import { scoreOf } from "./scoring";
import type { SeoSettings } from "./settings";

/**
 * Editorial suggestions grounded in the site's own articles, categories and Search Console queries.
 * - "measured": backed by GSC demand (a content-gap query); evidence lists the numbers.
 * - "editorial_idea": a theme the publication covers thinly; speculative, no search data behind it.
 * Suggestions land in seo_editorial_calendar as "suggested"; an admin approves, drafts and publishes them through the
 * normal editor. Existing calendar items are never overwritten (a human may have edited them).
 */
export type Theme = { cluster: string; category: string; keywords: string[]; audience: string; diagram: string; code: string };

export const THEMES: Theme[] = [
  { cluster: "DevOps & CI/CD", category: "devops-sre", keywords: ["ci/cd", "cicd", "pipeline", "github actions", "jenkins", "gitops", "devops"], audience: "DevOps engineers automating delivery", diagram: "pipeline stages from commit to production", code: "workflow YAML" },
  { cluster: "AWS", category: "aws-cloud", keywords: ["aws", "iam", "vpc", "s3", "lambda", "ecr", "cloudfront", "bedrock"], audience: "cloud engineers on AWS", diagram: "AWS architecture with network boundaries", code: "AWS CLI / Terraform snippets" },
  { cluster: "Kubernetes & EKS", category: "kubernetes", keywords: ["kubernetes", "k8s", "eks", "helm", "kubectl", "ingress", "pod", "argo"], audience: "platform engineers running Kubernetes", diagram: "cluster components and traffic flow", code: "manifests and kubectl commands" },
  { cluster: "Terraform & IaC", category: "infrastructure-as-code", keywords: ["terraform", "opentofu", "iac", "kustomize", "pulumi", "state"], audience: "engineers managing infrastructure as code", diagram: "module and state layout", code: "HCL modules and plan output" },
  { cluster: "Linux", category: "devops-sre", keywords: ["linux", "bash", "systemd", "shell", "ssh"], audience: "engineers operating Linux servers", diagram: "process / service relationships", code: "shell commands with expected output" },
  { cluster: "Observability & SRE", category: "devops-sre", keywords: ["prometheus", "grafana", "loki", "opentelemetry", "otel", "slo", "sre", "alert", "tracing"], audience: "SREs owning reliability", diagram: "telemetry pipeline", code: "PromQL / collector config" },
  { cluster: "Platform engineering", category: "devops-sre", keywords: ["platform engineering", "internal developer platform", "backstage", "golden path"], audience: "platform teams", diagram: "platform capabilities map", code: "templates and policy examples" },
  { cluster: "Python", category: "ai-engineering", keywords: ["python", "pandas", "fastapi", "asyncio", "pytest"], audience: "Python developers", diagram: "module / data-flow sketch", code: "runnable Python with tests" },
  { cluster: "JavaScript / TypeScript", category: "ai-engineering", keywords: ["javascript", "typescript", "node", "next.js", "react"], audience: "JS/TS developers", diagram: "request lifecycle", code: "TypeScript examples" },
  { cluster: "AI engineering & RAG", category: "ai-engineering", keywords: ["rag", "retrieval", "embedding", "vector", "llm", "prompt", "eval"], audience: "engineers shipping LLM features", diagram: "retrieval and generation pipeline", code: "Python/TS retrieval code with evaluation" },
  { cluster: "Agents, MCP & frameworks", category: "ai-agents", keywords: ["agent", "agentic", "mcp", "model context protocol", "langgraph", "crewai", "tool use"], audience: "engineers building AI agents", diagram: "agent loop with tools and guardrails", code: "agent graph / MCP server code" },
  { cluster: "LLMOps & MLOps", category: "mlops", keywords: ["llmops", "mlops", "model serving", "monitoring", "fine-tuning", "inference"], audience: "ML platform engineers", diagram: "model lifecycle", code: "deployment and monitoring config" },
  { cluster: "Security & networking", category: "cybersecurity", keywords: ["security", "cve", "tls", "mtls", "network policy", "zero trust", "firewall", "supply chain", "istio"], audience: "engineers hardening cloud workloads", diagram: "trust boundaries", code: "policy and config examples" },
];

const lc = (s: string) => s.toLowerCase();
export function themeOf(text: string): Theme | null {
  const t = lc(text);
  let best: { theme: Theme; hits: number } | null = null;
  for (const theme of THEMES) {
    const hits = theme.keywords.filter((k) => t.includes(k)).length;
    if (hits && (!best || hits > best.hits)) best = { theme, hits };
  }
  return best?.theme ?? null;
}

function intentOf(q: string): "how-to" | "explainer" | "comparison" | "troubleshooting" | "reference" {
  if (/^(how to|how do|how can)\b/.test(q)) return "how-to";
  if (/\bvs\.?\b|\bversus\b|\bcompar|\balternatives?\b/.test(q)) return "comparison";
  if (/\berror\b|\bfail|\bnot working\b|\bfix\b|\btroubleshoot/.test(q)) return "troubleshooting";
  if (/^(what is|what are|why)\b/.test(q)) return "explainer";
  return "reference";
}

const cap = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

export function titleFor(q: string): string {
  const intent = intentOf(q);
  const clean = q.replace(/\s+/g, " ").trim();
  if (intent === "how-to") return cap(clean) + ": a step-by-step guide";
  if (intent === "comparison") return cap(clean) + ": differences and when to use each";
  if (intent === "troubleshooting") return cap(clean) + ": causes and fixes";
  if (intent === "explainer") return cap(clean.replace(/\?$/, "")) + "? A practical explanation";
  return cap(clean) + ": a practical guide";
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

const relatedArticles = (articles: Article[], theme: Theme | null, text: string) => {
  const words = new Set(lc(text).split(/\W+/).filter((w) => w.length > 3));
  return articles
    .map((a) => ({ a, s: (theme && a.category === theme.category ? 1 : 0) + [...words].filter((w) => lc(`${a.title} ${a.tags.join(" ")}`).includes(w)).length }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, 3)
    .map((x) => ({ id: x.a.id, title: x.a.title, path: x.a.path }));
};

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
  };

  // Measured: one brief per content-gap query (top 10 by score).
  const gaps = candidates.filter((c) => c.category === "content_gap" && c.query).map((c) => ({ c, sc: scoreOf(c.inputs, s.weights, bands) })).sort((a, b) => b.sc.score - a.sc.score).slice(0, 10);
  for (const { c, sc } of gaps) {
    const q = c.query!;
    const theme = themeOf(q);
    const intent = intentOf(q);
    const recId = rowsOf<{ id: string }>(await db.execute(sql`select id from seo_recommendations where fingerprint = ${c.fingerprint}`))[0]?.id ?? null;
    const supporting = d.pageQuery.filter((r) => r.query === q || (theme && theme.keywords.some((k) => r.query.includes(k)) && r.query.includes(q.split(" ")[0]!))).sort((a, b) => b.impressions - a.impressions).slice(0, 8).map((r) => r.query);
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
        internalLinks: relatedArticles(d.articles, theme, q),
        readingTimeMinutes: intent === "how-to" || intent === "troubleshooting" ? 10 : 7,
      },
      evidence: c.evidence,
    });
  }

  // Editorial ideas: themes with fewer than two published articles. Speculative; no search data.
  const ideas: Theme[] = THEMES.filter((t) => d.articles.filter((a) => themeOf(`${a.title} ${a.tags.join(" ")}`)?.cluster === t.cluster).length < 2).slice(0, 6);
  for (const t of ideas) {
    const coverage = d.articles.filter((a) => themeOf(`${a.title} ${a.tags.join(" ")}`)?.cluster === t.cluster).length;
    await insert(fingerprint("editorial", "idea", t.cluster), {
      title: `${t.cluster}: a practical guide for ${t.audience}`,
      kind: "editorial_idea",
      category: t.category,
      cluster: t.cluster,
      score: 0.2,
      band: "low",
      brief: {
        audience: t.audience,
        intent: "explainer",
        supportingQueries: [],
        gap: `The publication has ${coverage} published article(s) on ${t.cluster}. This is an editorial idea, not backed by search data.`,
        outline: outlineFor("explainer", t.cluster),
        codeExamples: [t.code],
        diagrams: [t.diagram],
        internalLinks: relatedArticles(d.articles, t, t.keywords.join(" ")),
        readingTimeMinutes: 8,
      },
      evidence: [{ metric: "published_articles_in_theme", period: "current", value: coverage, source: "cms" }],
    });
  }
  return created;
}
