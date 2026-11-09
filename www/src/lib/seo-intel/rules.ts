import { createHash } from "node:crypto";
import { relatedCategories } from "@/config/taxonomy";
import { auditArticle } from "./audit-article";
import type { AnalysisData, Article } from "./data";
import { expectedCtr } from "./queries";
import { clamp01, logNorm, type ScoreInputs } from "./scoring";
import type { SeoSettings } from "./settings";

/**
 * Deterministic recommendation rules. They run without an LLM, read only synced data and article content, and
 * produce candidates with evidence rows (metric, period, value, source). Expected impact is qualitative only:
 * never a traffic forecast or a ranking promise.
 */
export type Evidence = { metric: string; period: string; value: number | null; valueText?: string; source: "gsc" | "ga4" | "cms" | "crawl" | "rule"; detail?: Record<string, unknown> };
export type Category = "low_ctr" | "striking_distance" | "content_decay" | "content_gap" | "internal_links" | "outdated_tech" | "quality";

export type Candidate = {
  fingerprint: string;
  category: Category;
  ruleKey: string;
  articleId: string | null;
  url: string | null;
  query: string | null;
  problem: string;
  proposedAction: string;
  evidence: Evidence[];
  inputs: ScoreInputs;
  confidence: "high" | "medium" | "low";
  expectedImpact: string;
};

export type LinkSuggestion = { sourceId: string; targetId: string; anchor: string; reason: string; score: number; evidence: Record<string, unknown> };

export const fingerprint = (...parts: (string | null | undefined)[]) => createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex").slice(0, 40);

const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const isBrand = (q: string, s: SeoSettings) => s.thresholds.brandTerms.some((b) => q.includes(b));
const range = (r: [string, string]) => `${r[0]}..${r[1]}`;
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9.+#]+/).filter((t) => t.length > 2 && !STOP.has(t)));
const STOP = new Set(["the", "and", "for", "with", "how", "what", "why", "you", "your", "are", "using", "use", "from", "into", "vs", "versus", "guide", "tutorial", "example", "examples"]);
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};

export function lowCtrRule(d: AnalysisData, s: SeoSettings): Candidate[] {
  if (!d.periods) return [];
  const t = s.thresholds;
  const maxImpr = Math.max(1, ...d.pageQuery.map((r) => r.impressions));
  const out: Candidate[] = [];
  for (const r of d.pageQuery) {
    if (r.impressions < t.lowCtrMinImpressions || r.position === null || isBrand(r.query, s)) continue;
    const ctr = r.impressions ? r.clicks / r.impressions : 0;
    const exp = expectedCtr(r.position);
    if (ctr >= exp * t.lowCtrRatio) continue;
    const a = d.articleByUrl.get(r.page);
    out.push({
      fingerprint: fingerprint("low_ctr", a?.id ?? r.page, r.query),
      category: "low_ctr",
      ruleKey: "low_ctr.position_band",
      articleId: a?.id ?? null,
      url: r.page,
      query: r.query,
      problem: `"${r.query}" shows this page ${Math.round(r.impressions)} times at average position ${r.position.toFixed(1)}, but CTR is ${fmtPct(ctr)}, well below the ${fmtPct(exp)} yardstick for that position band.`,
      proposedAction: "Rewrite the search title and meta description so they answer this query directly (state the outcome, include the term naturally, avoid truncation). Check the snippet Google shows for the query first.",
      evidence: [
        { metric: "impressions", period: range(d.periods.cur), value: r.impressions, source: "gsc", detail: { query: r.query } },
        { metric: "ctr", period: range(d.periods.cur), value: ctr, source: "gsc" },
        { metric: "position", period: range(d.periods.cur), value: r.position, source: "gsc" },
        { metric: "expected_ctr_for_band", period: "yardstick", value: exp, source: "rule", detail: { ratio: t.lowCtrRatio } },
      ],
      inputs: { searchOpportunity: logNorm(r.impressions, maxImpr), rankingOpportunity: clamp01((11 - Math.min(r.position, 11)) / 10), relevance: a ? 1 : 0.5, qualityGap: clamp01(1 - ctr / exp), effort: 0.9 },
      confidence: r.impressions >= t.lowCtrMinImpressions * 3 ? "high" : "medium",
      expectedImpact: "Likely more clicks from impressions this page already gets, if the new snippet matches intent better. No ranking change is implied.",
    });
  }
  return out;
}

export function strikingDistanceRule(d: AnalysisData, s: SeoSettings): Candidate[] {
  if (!d.periods) return [];
  const t = s.thresholds;
  const rows = d.pageQuery.filter((r) => r.position !== null && r.position >= t.strikingPositionMin && r.position <= t.strikingPositionMax && r.impressions >= t.strikingMinImpressions);
  const maxImpr = Math.max(1, ...rows.map((r) => r.impressions));
  return rows.map((r) => {
    const a = d.articleByUrl.get(r.page);
    const pos = r.position!;
    return {
      fingerprint: fingerprint("striking_distance", a?.id ?? r.page, r.query),
      category: "striking_distance" as const,
      ruleKey: "striking_distance.position_5_20",
      articleId: a?.id ?? null,
      url: r.page,
      query: r.query,
      problem: `"${r.query}" ranks at average position ${pos.toFixed(1)} with ${Math.round(r.impressions)} impressions: close to ${pos > 10 ? "the first page" : "the top results"}.`,
      proposedAction: `Strengthen the section that answers "${r.query}": a clear heading that matches the query, a direct answer near the top, a worked example, and internal links from related articles with descriptive anchor text.`,
      evidence: [
        { metric: "position", period: range(d.periods!.cur), value: pos, source: "gsc" as const, detail: { query: r.query } },
        { metric: "impressions", period: range(d.periods!.cur), value: r.impressions, source: "gsc" as const },
        { metric: "clicks", period: range(d.periods!.cur), value: r.clicks, source: "gsc" as const },
      ],
      inputs: { searchOpportunity: logNorm(r.impressions, maxImpr), rankingOpportunity: clamp01((t.strikingPositionMax - pos) / (t.strikingPositionMax - t.strikingPositionMin)), relevance: a ? 1 : 0.5, effort: 0.5 },
      confidence: (r.impressions >= t.strikingMinImpressions * 3 ? "medium" : "low") as Candidate["confidence"],
      expectedImpact: "Possible ranking improvement for a query the page already partly satisfies; outcomes vary and are not guaranteed.",
    };
  });
}

export function decayRule(d: AnalysisData, s: SeoSettings): Candidate[] {
  if (!d.periods) return [];
  const t = s.thresholds;
  const out: Candidate[] = [];
  const maxPrev = Math.max(1, ...[...d.pages.values()].map((p) => p.prev?.clicks ?? 0));
  for (const [page, m] of d.pages) {
    if (!m.prev || m.prev.clicks < t.decayMinClicks) continue;
    const drop = (m.prev.clicks - m.cur.clicks) / m.prev.clicks;
    if (drop < t.decayDropRatio) continue;
    const yoyDrop = m.yoy && m.yoy.clicks >= t.decayMinClicks ? (m.yoy.clicks - m.cur.clicks) / m.yoy.clicks : null;
    // With year-over-year history, a decline must show there too (rules out seasonality); without it, confidence is lower.
    if (yoyDrop !== null && yoyDrop < t.decayDropRatio) continue;
    const a = d.articleByUrl.get(page);
    const ev: Evidence[] = [
      { metric: "clicks", period: range(d.periods.cur), value: m.cur.clicks, source: "gsc" },
      { metric: "clicks", period: range(d.periods.prev), value: m.prev.clicks, source: "gsc" },
      { metric: "click_change", period: "28d vs prior 28d", value: -drop, source: "gsc" },
    ];
    if (yoyDrop !== null) ev.push({ metric: "clicks", period: range(d.periods.yoy), value: m.yoy!.clicks, source: "gsc", detail: { yearOverYear: true } }, { metric: "click_change", period: "28d vs same 28d last year", value: -yoyDrop, source: "gsc" });
    if (m.cur.position !== null && m.prev.position !== null) ev.push({ metric: "position_change", period: "28d vs prior 28d", value: m.cur.position - m.prev.position, source: "gsc" });
    out.push({
      fingerprint: fingerprint("content_decay", a?.id ?? page),
      category: "content_decay",
      ruleKey: yoyDrop !== null ? "content_decay.28d_and_yoy" : "content_decay.28d_only",
      articleId: a?.id ?? null,
      url: page,
      query: null,
      problem: `Clicks fell ${fmtPct(drop)} (${Math.round(m.prev.clicks)} → ${Math.round(m.cur.clicks)}) versus the previous 28 days${yoyDrop !== null ? ` and ${fmtPct(yoyDrop)} year over year` : "; no year-over-year history yet, so seasonality is not ruled out"}.`,
      proposedAction: "Check what changed: queries lost (Search performance → filter by this page), newer competing content, outdated versions or screenshots. Refresh facts and examples, then set a new update date only for substantive changes.",
      evidence: ev,
      inputs: { searchOpportunity: logNorm(m.prev.clicks, maxPrev), trend: clamp01(drop), relevance: a ? 1 : 0.5, effort: 0.4 },
      confidence: yoyDrop !== null ? "high" : "low",
      expectedImpact: "Refreshing decayed content can recover lost visibility when the decline is due to staleness; it cannot offset demand changes.",
    });
  }
  return out;
}

/** Queries with real demand where no article is a good match (best position beyond page 2 or weak topical overlap). */
export function contentGapRule(d: AnalysisData, s: SeoSettings): Candidate[] {
  if (!d.periods) return [];
  const byQuery = new Map<string, { impressions: number; clicks: number; best: { page: string; position: number | null } | null }>();
  for (const r of d.pageQuery) {
    const e = byQuery.get(r.query) ?? { impressions: 0, clicks: 0, best: null };
    e.impressions += r.impressions;
    e.clicks += r.clicks;
    if (r.position !== null && (!e.best || e.best.position === null || r.position < e.best.position)) e.best = { page: r.page, position: r.position };
    byQuery.set(r.query, e);
  }
  const maxImpr = Math.max(1, ...[...byQuery.values()].map((v) => v.impressions));
  const out: Candidate[] = [];
  for (const [query, e] of byQuery) {
    if (e.impressions < s.thresholds.gapMinImpressions || isBrand(query, s) || !e.best) continue;
    const a = d.articleByUrl.get(e.best.page);
    const overlap = a ? jaccard(tokens(query), tokens(`${a.title} ${a.tags.join(" ")} ${a.seoTitle ?? ""}`)) : 0;
    const far = e.best.position !== null && e.best.position > 20;
    if (!far && overlap >= 0.2) continue;
    out.push({
      fingerprint: fingerprint("content_gap", query),
      category: "content_gap",
      ruleKey: far ? "content_gap.no_page_in_top_20" : "content_gap.weak_match",
      articleId: null,
      url: e.best.page,
      query,
      problem: `"${query}" has ${Math.round(e.impressions)} impressions, but the best page (${new URL(e.best.page).pathname}, position ${e.best.position?.toFixed(1) ?? "n/a"}) ${far ? "ranks beyond the top 20" : "is only loosely about this topic"}.`,
      proposedAction: "Consider a dedicated article (or a clearly headed section in the closest article) that answers this query directly. See Editorial calendar for a drafted brief.",
      evidence: [
        { metric: "impressions", period: range(d.periods.cur), value: e.impressions, source: "gsc", detail: { query } },
        { metric: "best_position", period: range(d.periods.cur), value: e.best.position, source: "gsc", detail: { page: e.best.page } },
        { metric: "topic_overlap", period: "content", value: Math.round(overlap * 100) / 100, source: "cms" },
      ],
      inputs: { searchOpportunity: logNorm(e.impressions, maxImpr), relevance: clamp01(1 - overlap), qualityGap: far ? 1 : 0.6, effort: 0.2 },
      confidence: e.impressions >= s.thresholds.gapMinImpressions * 4 ? "medium" : "low",
      expectedImpact: "New, well-matched content can earn impressions and clicks for this demand over time; it is an editorial bet, not a forecast.",
    });
  }
  return out;
}

/** Related but unlinked articles: shared GSC queries, shared tags, same or related category. */
export function internalLinkRule(d: AnalysisData, s: SeoSettings): { suggestions: LinkSuggestion[]; candidates: Candidate[] } {
  const queriesByArticle = new Map<string, Set<string>>();
  for (const r of d.pageQuery) {
    const a = d.articleByUrl.get(r.page);
    if (!a) continue;
    const set = queriesByArticle.get(a.id) ?? new Set();
    set.add(r.query);
    queriesByArticle.set(a.id, set);
  }
  const related = new Set(relatedCategories.flatMap(([x, y]) => [`${x}|${y}`, `${y}|${x}`]));
  const suggestions: LinkSuggestion[] = [];
  const candidates: Candidate[] = [];
  for (const src of d.articles) {
    const existing = new Set(auditArticle(src).internalLinks.map((l) => l.toLowerCase()));
    const scored: LinkSuggestion[] = [];
    for (const tgt of d.articles) {
      if (tgt.id === src.id || existing.has(tgt.path) || tgt.noindex) continue;
      const sharedQ = jaccard(queriesByArticle.get(src.id) ?? new Set(), queriesByArticle.get(tgt.id) ?? new Set());
      const sharedTags = jaccard(new Set(src.tags), new Set(tgt.tags));
      const cat = src.category === tgt.category ? 1 : related.has(`${src.category}|${tgt.category}`) ? 0.5 : 0;
      const score = Math.round((0.5 * sharedQ + 0.3 * sharedTags + 0.2 * cat) * 1000) / 1000;
      if (score < 0.25) continue;
      const reasons = [sharedQ > 0 && `${Math.round(sharedQ * 100)}% shared search queries`, sharedTags > 0 && `shared tags (${src.tags.filter((t) => tgt.tags.includes(t)).join(", ")})`, cat === 1 ? "same category" : cat ? "related category" : null].filter(Boolean);
      scored.push({ sourceId: src.id, targetId: tgt.id, anchor: tgt.title, reason: reasons.join("; "), score, evidence: { sharedQueries: sharedQ, sharedTags, category: cat } });
    }
    const top = scored.sort((a, b) => b.score - a.score).slice(0, s.thresholds.maxLinksPerPage);
    suggestions.push(...top);
    if (top.length) {
      candidates.push({
        fingerprint: fingerprint("internal_links", src.id),
        category: "internal_links",
        ruleKey: "internal_links.related_unlinked",
        articleId: src.id,
        url: src.url,
        query: null,
        problem: `${top.length} closely related article(s) are not linked from this article.`,
        proposedAction: `Add contextual links (descriptive anchor text, where the topic comes up) to: ${top.map((t) => `"${d.articles.find((a) => a.id === t.targetId)!.title}"`).join(", ")}. See Internal linking for the reasons.`,
        evidence: top.map((t) => ({ metric: "relatedness", period: "current", value: t.score, source: "cms" as const, detail: { target: t.targetId, reason: t.reason } })),
        inputs: { relevance: top[0]!.score, qualityGap: clamp01(top.length / s.thresholds.maxLinksPerPage), effort: 0.8 },
        confidence: top.some((t) => (t.evidence.sharedQueries as number) > 0) ? "medium" : "low",
        expectedImpact: "Helps readers and crawlers find related content and spreads internal link signals; effects on rankings are indirect.",
      });
    }
  }
  return { suggestions, candidates };
}

/** Outdated technology and on-page quality, from the article audit. */
export function contentRules(d: AnalysisData, s: SeoSettings, now = new Date()): Candidate[] {
  void s;
  const out: Candidate[] = [];
  for (const a of d.articles) {
    const topQueries = d.pageQuery.filter((r) => r.page === a.url).sort((x, y) => y.impressions - x.impressions).slice(0, 10).map((r) => r.query);
    const audit = auditArticle(a, { knownPaths: d.knownPaths, now, topQueries });
    const metrics = d.pages.get(a.url);
    const outdated = audit.findings.filter((f) => f.check === "outdated_tech");
    if (outdated.length) {
      const confirmed = outdated.some((f) => f.source);
      out.push({
        fingerprint: fingerprint("outdated_tech", a.id),
        category: "outdated_tech",
        ruleKey: confirmed ? "outdated_tech.cited" : "outdated_tech.verify",
        articleId: a.id,
        url: a.url,
        query: null,
        problem: outdated.map((f) => f.message).join(" "),
        proposedAction: confirmed ? "Update the cited APIs/commands to their current replacements and note the change in the article's corrections or update date." : "Verify these versions/commands against current upstream documentation; update only what is actually outdated.",
        evidence: outdated.map((f) => ({ metric: "pattern", period: "content", value: null, valueText: String(f.detail?.match ?? ""), source: "cms" as const, detail: { label: f.message, ...(f.source ? { source: f.source } : {}) } })),
        inputs: { qualityGap: confirmed ? 0.9 : 0.5, relevance: 1, effort: 0.5, ...(metrics ? { searchOpportunity: clamp01(Math.log10(1 + metrics.cur.impressions) / 5) } : {}) },
        confidence: confirmed ? "high" : "low",
        expectedImpact: "Keeps the article accurate for readers; accuracy problems erode trust and engagement.",
      });
    }
    const quality = audit.findings.filter((f) => ["structure", "code_examples", "alt_text", "heading_skip", "h1_in_body", "broken_links", "intent_match", "title_length"].includes(f.check));
    if (quality.some((f) => f.severity !== "info") || quality.some((f) => f.check === "intent_match")) {
      out.push({
        fingerprint: fingerprint("quality", a.id),
        category: "quality",
        ruleKey: "quality.audit",
        articleId: a.id,
        url: a.url,
        query: null,
        problem: quality.map((f) => f.message).join(" "),
        proposedAction: "Fix the listed structure and accessibility issues in the editor (Content optimization shows each finding with the field it concerns).",
        evidence: [{ metric: "audit_score", period: "content", value: audit.score, source: "cms" }, ...quality.map((f) => ({ metric: f.check, period: "content", value: null, valueText: f.message, source: "cms" as const }))],
        inputs: { qualityGap: clamp01(1 - audit.score), relevance: 1, effort: 0.7, ...(metrics ? { searchOpportunity: clamp01(Math.log10(1 + metrics.cur.impressions) / 5) } : {}) },
        confidence: "medium",
        expectedImpact: "Better structure and accessibility help readers and how search engines understand the page; no ranking change is promised.",
      });
    }
  }
  return out;
}

export function runRules(d: AnalysisData, s: SeoSettings, now = new Date()) {
  const links = internalLinkRule(d, s);
  return { candidates: [...lowCtrRule(d, s), ...strikingDistanceRule(d, s), ...decayRule(d, s), ...contentGapRule(d, s), ...links.candidates, ...contentRules(d, s, now)], linkSuggestions: links.suggestions };
}

export type { Article };
