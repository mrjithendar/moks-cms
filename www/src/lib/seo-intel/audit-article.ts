import { createHash } from "node:crypto";

/**
 * Content audit of one article (pure: no I/O). Checks structure and on-page signals that matter to readers and
 * search engines. Word count and keyword density are deliberately NOT scored: they are not ranking factors.
 * Every finding says what was checked and why; "possibly outdated" findings ask the editor to verify unless a
 * source is cited.
 */
export type AuditInput = {
  id: string;
  collection: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  category: string;
  tags: string[];
  contentType: string;
  seoTitle: string | null;
  seoDescription: string | null;
  featuredImage: { src: string; alt: string } | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  noindex: boolean;
  canonicalUrl: string | null;
};

export type Finding = {
  check: string;
  severity: "error" | "warning" | "info";
  message: string;
  /** Field the finding relates to (for the editor panel). */
  field?: string;
  detail?: Record<string, unknown>;
  /** For "outdated" findings: a source that confirms it. Without one the finding only says "verify". */
  source?: string;
};

export type Heading = { level: number; text: string; line: number };

export type AuditResult = { score: number; findings: Finding[]; headings: Heading[]; internalLinks: string[]; externalLinks: string[]; codeBlocks: number; images: { src: string; alt: string }[]; contentHash: string };

/** Markdown headings outside fenced code. */
export function headingsOf(body: string): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  body.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: i + 1 });
  });
  return out;
}

const stripCode = (body: string) => body.replace(/(```|~~~)[\s\S]*?\1/g, "");

export function linksOf(body: string): { internal: string[]; external: string[] } {
  const internal: string[] = [];
  const external: string[] = [];
  for (const m of stripCode(body).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<a\s[^>]*href="([^"]+)"/g)) {
    const href = (m[1] ?? m[2] ?? "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
    if (href.startsWith("/") || /^https?:\/\/(www\.)?jithendar\.com(\/|$)/i.test(href)) internal.push(href.replace(/^https?:\/\/(www\.)?jithendar\.com/i, "").split(/[?#]/)[0] || "/");
    else if (/^https?:\/\//i.test(href)) external.push(href);
  }
  return { internal, external };
}

export function imagesOf(body: string): { src: string; alt: string }[] {
  const out: { src: string; alt: string }[] = [];
  for (const m of stripCode(body).matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) out.push({ alt: m[1]!.trim(), src: m[2]! });
  for (const m of stripCode(body).matchAll(/<img\s[^>]*>/g)) {
    const src = /src="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const alt = /alt="([^"]*)"/.exec(m[0])?.[1] ?? "";
    out.push({ src, alt: alt.trim() });
  }
  return out;
}

/**
 * Version strings and APIs worth a second look. Entries with `source` were removed/deprecated upstream (cited); the
 * rest only say "possibly outdated: verify" — a version number alone does not make an article wrong.
 */
export const OUTDATED_PATTERNS: { re: RegExp; label: string; source?: string }[] = [
  { re: /apiVersion:\s*extensions\/v1beta1/, label: "Kubernetes extensions/v1beta1 API (removed in 1.16/1.22)", source: "https://kubernetes.io/docs/reference/using-api/deprecation-guide/" },
  { re: /apiVersion:\s*networking\.k8s\.io\/v1beta1/, label: "Ingress networking.k8s.io/v1beta1 (removed in Kubernetes 1.22)", source: "https://kubernetes.io/docs/reference/using-api/deprecation-guide/#v1-22" },
  { re: /apiVersion:\s*policy\/v1beta1/, label: "policy/v1beta1 (PodSecurityPolicy / PodDisruptionBudget, removed in 1.25)", source: "https://kubernetes.io/docs/reference/using-api/deprecation-guide/#v1-25" },
  { re: /apiVersion:\s*batch\/v1beta1/, label: "CronJob batch/v1beta1 (removed in Kubernetes 1.25)", source: "https://kubernetes.io/docs/reference/using-api/deprecation-guide/#v1-25" },
  { re: /::set-output\s+name=/, label: "GitHub Actions ::set-output (deprecated; use $GITHUB_OUTPUT)", source: "https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/" },
  { re: /\bactions\/(checkout|setup-node|setup-python)@v[12]\b/, label: "Old major version of a GitHub action (runs on a deprecated Node runtime)" },
  { re: /\bdocker-compose\s+(up|down|build|run)\b/, label: "docker-compose v1 command (Compose v2 is `docker compose`)" },
  { re: /\bpython2(\.\d)?\b|\bPython 2\.\d\b/, label: "Python 2 (end of life)" },
  { re: /\bterraform\s+0\.1[0-2]\b|required_version\s*=\s*"[~>=\s]*0\.1[0-2]/, label: "Terraform 0.10–0.12 syntax or version" },
  { re: /\bKubernetes\s+1\.(1\d|2[0-7])\b/i, label: "Kubernetes version reference (1.10–1.27); check against the current supported releases" },
  { re: /\bnode(js)?\s*(v)?1[0-6]\b/i, label: "Node.js version 10–16 (end of life)" },
];

const SERP_TITLE_MAX = 60;

export function auditArticle(a: AuditInput, ctx: { knownPaths?: Set<string>; now?: Date; topQueries?: string[] } = {}): AuditResult {
  const now = ctx.now ?? new Date();
  const findings: Finding[] = [];
  const headings = headingsOf(a.body);
  const { internal, external } = linksOf(a.body);
  const images = imagesOf(a.body);
  const codeBlocks = (a.body.match(/^\s*(```|~~~)/gm)?.length ?? 0) / 2;
  const title = (a.seoTitle?.trim() || a.title).trim();
  const desc = (a.seoDescription?.trim() || a.description).trim();

  if (title.length > SERP_TITLE_MAX) findings.push({ check: "title_length", severity: "warning", field: "seoTitle", message: `Search title is ${title.length} characters; Google usually truncates around ${SERP_TITLE_MAX}.` });
  if (title.length < 20) findings.push({ check: "title_length", severity: "warning", field: "seoTitle", message: `Search title is only ${title.length} characters; it may not describe the page.` });
  if (desc.length < 70 || desc.length > 160) findings.push({ check: "meta_description", severity: "info", field: "seoDescription", message: `Meta description is ${desc.length} characters (70–160 is a practical range; Google may rewrite it either way).` });
  if (headings.some((h) => h.level === 1)) findings.push({ check: "h1_in_body", severity: "warning", field: "body", message: "The body contains an H1; the article title is already the page's H1." });
  for (let i = 1; i < headings.length; i++) {
    if (headings[i]!.level > headings[i - 1]!.level + 1) {
      findings.push({ check: "heading_skip", severity: "info", field: "body", message: `Heading level jumps from H${headings[i - 1]!.level} to H${headings[i]!.level} at "${headings[i]!.text}".`, detail: { line: headings[i]!.line } });
      break;
    }
  }
  const sections = headings.filter((h) => h.level === 2).length;
  if (sections === 0 && a.body.length > 4000) findings.push({ check: "structure", severity: "warning", field: "body", message: "No H2 sections in a long article: readers and search snippets rely on clear sections." });
  if (a.contentType === "tutorial" && codeBlocks === 0) findings.push({ check: "code_examples", severity: "warning", field: "body", message: "A tutorial with no code blocks: add runnable examples or commands." });
  const missingAlt = images.filter((i) => !i.alt);
  if (missingAlt.length) findings.push({ check: "alt_text", severity: "error", field: "body", message: `${missingAlt.length} image(s) without alt text.`, detail: { images: missingAlt.map((i) => i.src).slice(0, 10) } });
  if (a.featuredImage && !a.featuredImage.alt.trim()) findings.push({ check: "alt_text", severity: "error", field: "featuredImage", message: "The cover image has no alt text." });
  if (!a.featuredImage) findings.push({ check: "structured_data", severity: "info", field: "featuredImage", message: "No cover image: the article's JSON-LD and social cards have no image." });
  if (internal.length === 0) findings.push({ check: "internal_links", severity: "warning", field: "body", message: "No internal links to other articles." });
  if (ctx.knownPaths) {
    const broken = [...new Set(internal)].filter((p) => !ctx.knownPaths!.has(p.toLowerCase().replace(/\/+$/, "") || "/") && !p.startsWith("/media/") && !p.startsWith("/images/"));
    if (broken.length) findings.push({ check: "broken_links", severity: "error", field: "body", message: `${broken.length} internal link(s) to pages that do not exist.`, detail: { links: broken.slice(0, 20) } });
  }
  const last = a.updatedAt ?? a.publishedAt;
  if (last && now.getTime() - last.getTime() > 548 * 86_400_000 && ["tutorial", "analysis"].includes(a.contentType)) {
    findings.push({ check: "freshness", severity: "info", field: "updatedAt", message: `Last substantive update ${last.toISOString().slice(0, 10)} (over 18 months ago): review for accuracy.` });
  }
  for (const p of OUTDATED_PATTERNS) {
    const m = p.re.exec(a.body);
    if (m) findings.push({ check: "outdated_tech", severity: p.source ? "warning" : "info", field: "body", message: p.source ? `Outdated: ${p.label}.` : `Possibly outdated, verify: ${p.label}.`, ...(p.source ? { source: p.source } : {}), detail: { match: m[0].slice(0, 80) } });
  }
  if (a.noindex) findings.push({ check: "indexability", severity: "info", field: "noindex", message: "The article is set to noindex; it will not appear in search results." });
  if (a.canonicalUrl) findings.push({ check: "indexability", severity: "info", field: "canonicalUrl", message: `Canonical points elsewhere (${a.canonicalUrl}); this URL is not meant to rank.` });
  // Intent: how-to / comparison queries landing on content that does not answer that shape.
  const q = ctx.topQueries ?? [];
  if (q.some((x) => /^(how to|how do)/.test(x)) && a.contentType !== "tutorial" && codeBlocks === 0) findings.push({ check: "intent_match", severity: "info", message: "How-to searches land here, but the article has no steps or code: consider a worked example." });
  if (q.some((x) => /\bvs\.?\b|\bversus\b|\bcompar/.test(x)) && !/\|.+\|/.test(a.body)) findings.push({ check: "intent_match", severity: "info", message: "Comparison searches land here; a comparison table may answer them better." });

  const penalty = findings.reduce((s, f) => s + (f.severity === "error" ? 0.15 : f.severity === "warning" ? 0.07 : 0.02), 0);
  const contentHash = createHash("sha256").update(JSON.stringify([a.title, a.description, a.seoTitle, a.seoDescription, a.body])).digest("hex").slice(0, 32);
  return { score: Math.max(0, Math.round((1 - penalty) * 100) / 100), findings, headings, internalLinks: internal, externalLinks: external, codeBlocks, images, contentHash };
}
