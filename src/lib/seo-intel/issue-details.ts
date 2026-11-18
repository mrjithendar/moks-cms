import type { AuditResult, Finding } from "./audit-article";
import type { DraftCategory } from "./settings";

/**
 * v2 Phase 5: the detail behind every number on Content optimization. Pure: built from the same audit the counts come
 * from (audit-article.ts), so a popover can never disagree with its number.
 */
export const METRICS = ["errors", "warnings", "notices", "broken_links", "missing_alt", "heading_issues", "score"] as const;
export type Metric = (typeof METRICS)[number];

type Info = { why: string; fix: string; fixCategory: DraftCategory | null };
/** One line each: why it matters, how to fix, and which draft category (if any) Claude may use to fix it. */
export const CHECK_INFO: Record<string, Info> = {
  title_length: { why: "Long titles are cut off in results; very short ones rarely describe the page.", fix: "Keep the search title around 50–60 characters, leading with the searcher's words.", fixCategory: "title_meta" },
  meta_description: { why: "The snippet under the title is often taken from it when it fits.", fix: "Write one or two plain sentences, 120–155 characters, saying what the reader gets.", fixCategory: "title_meta" },
  h1_in_body: { why: "The title is already the page's only H1; a second one blurs the outline.", fix: "Demote body H1s to H2.", fixCategory: "faq_headings" },
  heading_skip: { why: "Skipped levels break the outline screen readers and snippets rely on.", fix: "Use the next level down (H2 → H3), not a jump.", fixCategory: "faq_headings" },
  structure: { why: "Long text without sections is hard to scan and to quote in results.", fix: "Add H2 sections where the topic changes.", fixCategory: "faq_headings" },
  code_examples: { why: "Tutorial readers expect commands they can run.", fix: "Add the commands or code the steps describe.", fixCategory: null },
  alt_text: { why: "Screen-reader users and image search depend on alt text.", fix: "Describe what the image shows in a short phrase.", fixCategory: "alt_text" },
  structured_data: { why: "Without an image, the article's JSON-LD and social cards have none.", fix: "Set a cover image in the editor.", fixCategory: null },
  internal_links: { why: "Links help readers find the next step and help crawlers discover pages.", fix: "Link related articles from phrases already in the text.", fixCategory: "internal_links" },
  broken_links: { why: "Links to missing pages are dead ends for readers and crawlers.", fix: "Point the link at the current URL or remove it.", fixCategory: null },
  freshness: { why: "Technical articles go stale; readers check the date.", fix: "Review for accuracy; update the date only for substantive changes.", fixCategory: "freshness" },
  outdated_tech: { why: "Deprecated APIs and versions mislead readers.", fix: "Verify against upstream docs and update only what is outdated, citing the source.", fixCategory: "freshness" },
  indexability: { why: "Noindex or a foreign canonical keeps this URL out of results.", fix: "Check that it is intentional in the editor's SEO settings.", fixCategory: null },
  intent_match: { why: "The page shape does not match what searchers arriving here want.", fix: "Add steps, code or a comparison table that answers that intent.", fixCategory: "faq_headings" },
};
const HEADING_CHECKS = new Set(["h1_in_body", "heading_skip", "structure"]);
export const PENALTY = { error: 0.15, warning: 0.07, info: 0.02 } as const;

export type IssueDetail = {
  check: string;
  severity: "error" | "warning" | "notice";
  message: string;
  /** Where: heading path, line number or element/field. */
  location: string;
  line: number | null;
  field: string | null;
  why: string;
  fix: string;
  fixCategory: DraftCategory | null;
};

const sev = (f: Finding): IssueDetail["severity"] => (f.severity === "info" ? "notice" : f.severity);

function headingPathAt(audit: AuditResult, line: number): string {
  const path: { level: number; text: string }[] = [];
  for (const h of audit.headings) {
    if (h.line > line) break;
    while (path.length && path[path.length - 1]!.level >= h.level) path.pop();
    path.push(h);
  }
  return path.map((p) => p.text).join(" › ");
}

/** One finding → one or more located issues (an alt-text finding about 3 images → 3 issues, each with its line). */
export function locate(f: Finding, audit: AuditResult, body: string): IssueDetail[] {
  const info = CHECK_INFO[f.check] ?? { why: "", fix: "", fixCategory: null };
  const lines = body.split("\n");
  const base = { check: f.check, severity: sev(f), message: f.message, why: info.why, fix: info.fix, fixCategory: info.fixCategory, field: f.field ?? null };
  const at = (line: number, element: string): IssueDetail => {
    const hp = headingPathAt(audit, line);
    return { ...base, line, location: `${hp ? `${hp} · ` : ""}line ${line} · ${element}`, field: "body" };
  };
  const find = (pred: (l: string) => boolean) => lines.flatMap((l, i) => (pred(l) ? [i + 1] : []));
  switch (f.check) {
    case "alt_text": {
      if (f.field === "featuredImage") return [{ ...base, line: null, location: "Cover image (editor sidebar)" }];
      const srcs = (f.detail?.images as string[] | undefined) ?? [];
      return srcs.flatMap((src) => find((l) => l.includes(`](${src}`) && /!\[\s*\]/.test(l)).map((n) => at(n, `image ${src}`)));
    }
    case "broken_links": {
      const links = (f.detail?.links as string[] | undefined) ?? [];
      return links.flatMap((href) => find((l) => l.includes(`](${href}`)).slice(0, 1).map((n) => at(n, `link → ${href}`)));
    }
    case "h1_in_body":
      return audit.headings.filter((h) => h.level === 1).map((h) => at(h.line, `H1 “${h.text}”`));
    case "heading_skip": {
      const line = Number(f.detail?.line ?? 0) || null;
      return [line ? at(line, "heading") : { ...base, line: null, location: "Heading outline" }];
    }
    case "outdated_tech": {
      const match = String(f.detail?.match ?? "");
      const n = match ? find((l) => l.includes(match.split("\n")[0]!.slice(0, 40))) : [];
      return [n[0] ? at(n[0], `“${match.slice(0, 40)}”`) : { ...base, line: null, location: "Body" }];
    }
    case "title_length":
      return [{ ...base, line: null, location: "Search title (seoTitle)" }];
    case "meta_description":
      return [{ ...base, line: null, location: "Meta description (seoDescription)" }];
    default:
      return [{ ...base, line: null, location: f.field ? `Field: ${f.field}` : "Article" }];
  }
}

export function issuesFor(metric: Metric, audit: AuditResult, body: string): IssueDetail[] {
  const pick = (f: Finding) => {
    switch (metric) {
      case "errors":
        return f.severity === "error";
      case "warnings":
        return f.severity === "warning";
      case "notices":
        return f.severity === "info";
      case "broken_links":
        return f.check === "broken_links";
      case "missing_alt":
        return f.check === "alt_text";
      case "heading_issues":
        return HEADING_CHECKS.has(f.check);
      default:
        return true;
    }
  };
  const order = { error: 0, warning: 1, notice: 2 };
  return audit.findings.filter(pick).flatMap((f) => locate(f, audit, body)).sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0));
}

/** The numbers shown in the table. Counts are located issues (an alt-text finding about 3 images counts 3). */
export function metricCounts(audit: AuditResult, body: string): Record<Exclude<Metric, "score">, number> & { score: number } {
  const n = (m: Metric) => issuesFor(m, audit, body).length;
  return { errors: n("errors"), warnings: n("warnings"), notices: n("notices"), broken_links: n("broken_links"), missing_alt: n("missing_alt"), heading_issues: n("heading_issues"), score: Math.round(audit.score * 100) };
}

/** How the score was calculated: 100 minus a fixed penalty per finding, by severity. */
export function scoreBreakdown(audit: AuditResult) {
  const rows = audit.findings.map((f) => ({ check: f.check, severity: sev(f), message: f.message, points: Math.round(PENALTY[f.severity] * 100) }));
  const total = rows.reduce((s, r) => s + r.points, 0);
  const pts = (v: number) => Math.round(v * 100);
  return {
    formula: `100 − ${pts(PENALTY.error)} per error − ${pts(PENALTY.warning)} per warning − ${pts(PENALTY.info)} per notice (minimum 0)`,
    weights: [
      { input: "Error", weight: pts(PENALTY.error) },
      { input: "Warning", weight: pts(PENALTY.warning) },
      { input: "Notice", weight: pts(PENALTY.info) },
    ],
    rows,
    deducted: total,
    score: Math.max(0, 100 - total),
  };
}
