import { blocksOf, linksIn, type BaseSnapshot, type Change } from "./changeset";
import { escapeRe, forbiddenRanges, proseWords } from "./internal-links";
import type { SeoSettings } from "./settings";

/**
 * Automated external links to official documentation (owner decision 2026-11-10), conservative by design.
 *
 * Deterministic, no model: a curated allowlist maps a product/project name to its official docs. For one article:
 * - at most `maxExternalPerArticle` new links (default 2), and none when the article already has that many or more
 *   external links;
 * - the FIRST mention of a name only, and only if the article doesn't already link to that docs host;
 * - never in headings, code, tables, image captions, the first sentence, existing links, inline code or raw HTML;
 *   a paragraph that already has a link gets no second one; ≥ `minWordsBetween` words from another new link;
 * - names match case-sensitively and as whole words ("Helm", not "at the helm"; "Argo CD", not "argocd").
 * Rendered with rel="nofollow noopener" like every external link (src/lib/mdx/link-rel.ts).
 */
export type DocsEntry = { key: string; names: string[]; url: string; title: string };

/** Official docs only. Keep URLs to stable landing pages (they're linked from many articles). */
export const OFFICIAL_DOCS: readonly DocsEntry[] = [
  { key: "kubernetes", names: ["Kubernetes"], url: "https://kubernetes.io/docs/", title: "Kubernetes documentation" },
  { key: "kubectl", names: ["kubectl"], url: "https://kubernetes.io/docs/reference/kubectl/", title: "kubectl reference" },
  { key: "helm", names: ["Helm"], url: "https://helm.sh/docs/", title: "Helm documentation" },
  { key: "kustomize", names: ["Kustomize"], url: "https://kubectl.docs.kubernetes.io/references/kustomize/", title: "Kustomize reference" },
  { key: "argocd", names: ["Argo CD"], url: "https://argo-cd.readthedocs.io/en/stable/", title: "Argo CD documentation" },
  { key: "flux", names: ["Flux CD"], url: "https://fluxcd.io/flux/", title: "Flux documentation" },
  { key: "istio", names: ["Istio"], url: "https://istio.io/latest/docs/", title: "Istio documentation" },
  { key: "cert-manager", names: ["cert-manager"], url: "https://cert-manager.io/docs/", title: "cert-manager documentation" },
  { key: "k3s", names: ["k3s", "K3s"], url: "https://docs.k3s.io/", title: "K3s documentation" },
  { key: "minikube", names: ["minikube", "Minikube"], url: "https://minikube.sigs.k8s.io/docs/", title: "minikube documentation" },
  { key: "docker", names: ["Docker"], url: "https://docs.docker.com/", title: "Docker documentation" },
  { key: "terraform", names: ["Terraform"], url: "https://developer.hashicorp.com/terraform/docs", title: "Terraform documentation" },
  { key: "opentofu", names: ["OpenTofu"], url: "https://opentofu.org/docs/", title: "OpenTofu documentation" },
  { key: "vault", names: ["HashiCorp Vault"], url: "https://developer.hashicorp.com/vault/docs", title: "Vault documentation" },
  { key: "ansible", names: ["Ansible"], url: "https://docs.ansible.com/", title: "Ansible documentation" },
  { key: "prometheus", names: ["Prometheus"], url: "https://prometheus.io/docs/introduction/overview/", title: "Prometheus documentation" },
  { key: "grafana", names: ["Grafana"], url: "https://grafana.com/docs/grafana/latest/", title: "Grafana documentation" },
  { key: "loki", names: ["Grafana Loki"], url: "https://grafana.com/docs/loki/latest/", title: "Loki documentation" },
  { key: "opentelemetry", names: ["OpenTelemetry"], url: "https://opentelemetry.io/docs/", title: "OpenTelemetry documentation" },
  { key: "jaeger", names: ["Jaeger"], url: "https://www.jaegertracing.io/docs/latest/", title: "Jaeger documentation" },
  { key: "github-actions", names: ["GitHub Actions"], url: "https://docs.github.com/en/actions", title: "GitHub Actions documentation" },
  { key: "dependabot", names: ["Dependabot"], url: "https://docs.github.com/en/code-security/dependabot", title: "Dependabot documentation" },
  { key: "jenkins", names: ["Jenkins"], url: "https://www.jenkins.io/doc/", title: "Jenkins documentation" },
  { key: "eks", names: ["Amazon EKS"], url: "https://docs.aws.amazon.com/eks/", title: "Amazon EKS documentation" },
  { key: "ecr", names: ["Amazon ECR"], url: "https://docs.aws.amazon.com/ecr/", title: "Amazon ECR documentation" },
  { key: "s3", names: ["Amazon S3"], url: "https://docs.aws.amazon.com/s3/", title: "Amazon S3 documentation" },
  { key: "lambda", names: ["AWS Lambda"], url: "https://docs.aws.amazon.com/lambda/", title: "AWS Lambda documentation" },
  { key: "iam", names: ["AWS IAM"], url: "https://docs.aws.amazon.com/iam/", title: "AWS IAM documentation" },
  { key: "postgresql", names: ["PostgreSQL"], url: "https://www.postgresql.org/docs/current/", title: "PostgreSQL documentation" },
  { key: "pgvector", names: ["pgvector"], url: "https://github.com/pgvector/pgvector", title: "pgvector" },
  { key: "cloudnativepg", names: ["CloudNativePG"], url: "https://cloudnative-pg.io/documentation/current/", title: "CloudNativePG documentation" },
  { key: "redis", names: ["Redis"], url: "https://redis.io/docs/latest/", title: "Redis documentation" },
  { key: "nextjs", names: ["Next.js"], url: "https://nextjs.org/docs", title: "Next.js documentation" },
  { key: "langgraph", names: ["LangGraph"], url: "https://langchain-ai.github.io/langgraph/", title: "LangGraph documentation" },
  { key: "langchain", names: ["LangChain"], url: "https://python.langchain.com/docs/introduction/", title: "LangChain documentation" },
  { key: "crewai", names: ["CrewAI"], url: "https://docs.crewai.com/", title: "CrewAI documentation" },
  { key: "mcp", names: ["Model Context Protocol"], url: "https://modelcontextprotocol.io/", title: "Model Context Protocol" },
  { key: "mlflow", names: ["MLflow"], url: "https://mlflow.org/docs/latest/", title: "MLflow documentation" },
  { key: "kubeflow", names: ["Kubeflow"], url: "https://www.kubeflow.org/docs/", title: "Kubeflow documentation" },
  { key: "pytorch", names: ["PyTorch"], url: "https://pytorch.org/docs/stable/", title: "PyTorch documentation" },
  { key: "trivy", names: ["Trivy"], url: "https://trivy.dev/latest/docs/", title: "Trivy documentation" },
  { key: "falco", names: ["Falco"], url: "https://falco.org/docs/", title: "Falco documentation" },
  { key: "owasp-llm", names: ["OWASP Top 10 for LLM Applications"], url: "https://genai.owasp.org/llm-top-10/", title: "OWASP Top 10 for LLM Applications" },
];

export const ALLOWED_EXTERNAL_URLS: ReadonlySet<string> = new Set(OFFICIAL_DOCS.map((d) => d.url));

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const docsKey = (u: string) => {
  try {
    const url = new URL(u);
    // github.com hosts many projects: compare host + first path segment there.
    return url.hostname.replace(/^www\./, "") + (url.hostname.endsWith("github.com") ? `/${url.pathname.split("/")[1] ?? ""}` : "");
  } catch {
    return "";
  }
};

export type PlannedExternal = { entry: DocsEntry; anchor: string; blockId: string; headingPath: string };
export type ExternalLimits = { maxExternalPerArticle: number; minWordsBetween: number };
/** A name → URL rule: the official docs above, or one of the owner's keyword links (link-keywords.ts). */
export type MentionEntry = DocsEntry & { caseSensitive?: boolean };
export type MentionOpts = {
  budget: number;
  minWordsBetween: number;
  /** True when the article already links to this entry's target (it is then skipped). */
  alreadyLinked: (url: string) => boolean;
  /** Blocks already taken by other planned links (one new link per paragraph across all planners). */
  takenBlocks?: Set<string>;
};

/**
 * First-mention linking (pure), shared by the official-docs and keyword-link planners. For each entry only the FIRST
 * mention in the article counts: if it's in a heading, code, caption, existing link, inline code, raw HTML or the first
 * sentence, the entry isn't linked at all (no hunting for a later mention). Whole words only; a paragraph that already
 * has a link gets none; one new link per paragraph; ≥ minWordsBetween words between new links; at most `budget`.
 */
export function planMentionLinks(body: string, entries: readonly MentionEntry[], o: MentionOpts): PlannedExternal[] {
  if (o.budget <= 0 || !entries.length) return [];
  const all = blocksOf(body);
  const blocks = all.filter((b) => (b.kind === "paragraph" || b.kind === "list") && !b.hasImage);
  const firstPara = all.find((b) => b.kind === "paragraph");
  const firstSentenceEnd = firstPara ? firstPara.start + (/[.!?](\s|$)/.exec(firstPara.source)?.index ?? firstPara.source.length) + 1 : 0;
  const wordOffset = (abs: number) => (body.slice(0, abs).replace(/(```|~~~)[\s\S]*?\1/g, " ").match(/\S+/g) ?? []).length;

  const firsts: { entry: MentionEntry; abs: number; anchor: string; blockId: string; headingPath: string; blockSource: string }[] = [];
  for (const entry of entries) {
    if (o.alreadyLinked(entry.url)) continue;
    const re = new RegExp(`(?<![\\w./-])(?:${entry.names.map(escapeRe).join("|")})(?![\\w-]|\\.\\w)`, entry.caseSensitive === false ? "i" : "");
    const b = all.find((x) => re.test(x.source));
    if (!b || !blocks.includes(b)) continue;
    const m = re.exec(b.source)!;
    const start = m.index;
    const end = start + m[0].length;
    const abs = b.start + start;
    if (forbiddenRanges(b.source).some(([s, e]) => start < e && end > s) || abs < firstSentenceEnd) continue;
    firsts.push({ entry, abs, anchor: m[0], blockId: b.id, headingPath: b.headingPath, blockSource: b.source });
  }
  firsts.sort((a, b) => a.abs - b.abs);

  const planned: PlannedExternal[] = [];
  const taken: number[] = [];
  const usedBlocks = o.takenBlocks ?? new Set<string>();
  for (const f of firsts) {
    if (planned.length >= o.budget) break;
    if (usedBlocks.has(f.blockId) || linksIn(f.blockSource).length > 0) continue; // one link per paragraph
    if (f.blockSource.split(f.anchor).length - 1 !== 1) continue; // the change's "before" must be unique in its block
    const wo = wordOffset(f.abs);
    if (taken.some((x) => Math.abs(x - wo) < o.minWordsBetween)) continue;
    planned.push({ entry: f.entry, anchor: f.anchor, blockId: f.blockId, headingPath: f.headingPath });
    taken.push(wo);
    usedBlocks.add(f.blockId);
  }
  return planned;
}

/** External links already in a body (not this site). */
export const externalLinksIn = (body: string, origin = "https://jithendar.com") => linksIn(body).filter((u) => /^https?:\/\//i.test(u) && hostOf(u) !== hostOf(origin));

/** Plan new official-docs links for one article body (pure). `entries` adds the owner's external keyword links. */
export function planExternalLinks(body: string, limits: ExternalLimits, origin = "https://jithendar.com", entries: readonly MentionEntry[] = OFFICIAL_DOCS, takenBlocks?: Set<string>): { planned: PlannedExternal[]; skipped: string | null } {
  if (limits.maxExternalPerArticle <= 0) return { planned: [], skipped: "external linking is off" };
  const existing = externalLinksIn(body, origin);
  const budget = limits.maxExternalPerArticle - existing.length;
  if (budget <= 0) return { planned: [], skipped: `already has ${existing.length} external links` };
  const linkedDocs = new Set(existing.map(docsKey));
  const exact = new Set(existing);
  const planned = planMentionLinks(body, entries, { budget, minWordsBetween: limits.minWordsBetween, alreadyLinked: (u) => exact.has(u) || linkedDocs.has(docsKey(u)), takenBlocks });
  return { planned, skipped: planned.length ? null : "no first mention of an allowlisted tool in eligible prose" };
}

/** Draft changes (type external_link) for one article. */
export function externalLinkChangesFor(s: SeoSettings, base: BaseSnapshot, startAt: number, origin?: string): Change[] {
  if (!s.links.enabled || s.links.auto.maxExternalPerArticle === 0 || proseWords(base.body) < 150) return [];
  const plan = planExternalLinks(base.body, { maxExternalPerArticle: s.links.auto.maxExternalPerArticle, minWordsBetween: s.links.minWordsBetween }, origin);
  return plan.planned.map((p, i) => ({
    id: `c${startAt + i}`,
    type: "external_link" as const,
    location: { blockId: p.blockId, headingPath: p.headingPath || null, field: null },
    before: p.anchor,
    after: `[${p.anchor}](${p.entry.url})`,
    rationale: `First mention of ${p.anchor}: link to the official ${p.entry.title} (nofollow).`,
    evidenceRef: [],
    sourceUrls: [p.entry.url],
    origin: "rules" as const,
    decision: "pending" as const,
    edited: null,
    flags: [],
    target: p.entry.url,
  }));
}
