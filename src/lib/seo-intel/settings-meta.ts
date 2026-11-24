/**
 * Presentation metadata for Settings → SEO (client-safe: no database imports). The settings document itself, its
 * validation and defaults stay in settings.ts; this only says how to group and explain it.
 */

export type SettingsTab = { id: string; label: string; sections: string[]; description: string };

/** Sections not listed here land in "Other", so a new settings section is never hidden. */
export const SETTINGS_TABS: SettingsTab[] = [
  { id: "data", label: "Data sources", sections: ["google", "sync", "dataforseo"], description: "Which Google properties are read, how far back, and how long data is kept; DataForSEO for volume, difficulty, live rankings and backlinks." },
  { id: "schedules", label: "Schedules", sections: ["schedules"], description: "When the web worker runs each job (UTC). While the SEO agent is on, the jobs its flows own run as flows on their own schedules instead (AI & SEO → Flows → Schedules)." },
  { id: "scoring", label: "Scoring & rules", sections: ["weights", "thresholds"], description: "How recommendations are found and ranked (docs/seo/SCORING.md)." },
  { id: "content", label: "Content & links", sections: ["keywords", "links", "submission"], description: "Keyword opportunities, internal-linking limits and search-engine submission." },
  { id: "ai", label: "AI & drafts", sections: ["drafts", "llm", "aiVisibility"], description: "Claude drafting (always stops at human review), the optional explanation model, and AI visibility (are AI assistants citing the site?)." },
  { id: "crawler", label: "Crawler", sections: ["crawler"], description: "Limits for the technical SEO crawl of this site." },
  { id: "reports", label: "Reports", sections: ["reports"], description: "Weekly and monthly report e-mail." },
  { id: "runs", label: "Run history", sections: ["runHistory"], description: "What the CrewAI console keeps of each SEO agent run: model-call transcripts, and how long log lines and transcripts are kept." },
];

export const SECTION_LABELS: Record<string, string> = {
  google: "Google properties",
  sync: "Sync and retention",
  schedules: "Schedules (UTC; weekday 0 = Sunday)",
  weights: "Scoring weights (relative; renormalised when an input is missing)",
  thresholds: "Rule thresholds",
  crawler: "Technical crawler",
  llm: "LLM enrichment (optional; off by default)",
  reports: "Reports (email only after recipients are set and email is enabled)",
  drafts: "Claude drafts (automation stops at “ready for review”; empty models = environment defaults; spend counts in the one LLM budget)",
  links: "Internal linking limits (conservative by default)",
  submission: "Search-engine submission (kill switch: SEO_SUBMISSION_ENABLED)",
  keywords: "Keyword opportunities",
  aiVisibility: "AI visibility (weekly prompts to AI assistants with web search; API keys only in the site's Secret)",
  dataforseo: "DataForSEO (pay as you go; credentials DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD in the site's Secret)",
  runHistory: "Run history (CrewAI console: Admin → AI & SEO → CrewAI console)",
};

/** One line of help per field that isn't self-explanatory, keyed by its dotted path. */
export const FIELD_HELP: Record<string, string> = {
  "aiVisibility.enabled": "Master switch for the weekly run. Each assistant also needs its switch below and its API key.",
  "aiVisibility.costPerAnswerUsd": "ChatGPT, Perplexity and Gemini do not return a price: each answer is counted at this estimate. Set it from their pricing.",
  "aiVisibility.brandNames": "Names that count as a mention besides the site name and host, e.g. the author's name.",
  "aiVisibility.models.claude": "Anthropic model id (web search needs a current model).",
  "aiVisibility.models.chatgpt": "OpenAI model id with web search support; required to switch ChatGPT on.",
  "aiVisibility.models.perplexity": "Perplexity Sonar model id (sonar, sonar-pro).",
  "aiVisibility.models.gemini": "Gemini model id with Google Search grounding; required to switch Gemini on.",
  "runHistory.transcripts": "Keep each model call's system prompt, prompt and answer, so a run's log can show exactly what an agent was asked and said. Off: only tokens, cost and time are kept. Applies from the agent's next call (within a minute).",
  "runHistory.logs": "Keep each run's structured log lines: steps, model and tool calls, retries, conditions and errors, with passwords, keys and tokens redacted. Off: only the steps, their detail and the outcome are kept (the service log still has every line). On by default.",
  "runHistory.stepIo": "Keep what went into and came out of each step: sizes, keys and short redacted previews, never whole payloads. On by default.",
  "runHistory.logRetentionDays": "Run log lines older than this are deleted by the daily retention job. Runs, their steps, cost and outcome are kept.",
  "runHistory.transcriptRetentionDays": "Model-call transcripts older than this are deleted by the daily retention job.",
  "aiVisibility.providers.google_ai_overview": "The AI Overview on Google's results page, read through DataForSEO (needs its credentials; billed by DataForSEO, counted here).",
  "dataforseo.enabled": "Master switch. Nothing is bought while off or while the credentials are missing.",
  "dataforseo.locationCode": "Market for volume and rankings: 2840 United States, 2356 India, 2826 United Kingdom, 2276 Germany.",
  "dataforseo.monthlyBudgetUsd": "Hard cap per calendar month (UTC), counted from the cost DataForSEO returns. 0 = buy nothing.",
  "dataforseo.keywordMetrics.maxKeywords": "Top Search Console queries by impressions (tracked keywords always included) that get volume and difficulty.",
  "dataforseo.keywordMetrics.refreshDays": "A query's metrics are bought again only after this many days.",
  "dataforseo.rankTracking.depth": "Results checked per tracked keyword; billed per 10. A keyword below this depth shows as not ranking.",
  "dataforseo.backlinks.enabled": "The Backlinks API has its own DataForSEO subscription; switch on only once it is active.",
  "google.gscProperty": "sc-domain:example.com for a domain property, or the URL-prefix form with a trailing slash. Empty = SEO_GSC_PROPERTY.",
  "google.ga4PropertyId": "Numeric GA4 property id (Admin → Property details). Empty = SEO_GA4_PROPERTY_ID.",
  "google.urlInspection.dailyLimit": "Google allows 2,000 inspections per property per day; keep well below.",
  "google.pageSpeed.enabled": "Needs PAGESPEED_API_KEY in the site's Secret for field (CrUX) data at a useful quota.",
  "sync.trailingDays": "Recent days re-fetched on every sync: Search Console revises its last ~3 days.",
  "sync.retentionMonths": "Daily rows older than this are deleted. Year-over-year decay checks need at least 13.",
  "sync.staleAfterHours": "After this long without a good sync, pages show “stale” and SeoDataStale fires.",
  "sync.maxRequestsPerRun": "Hard cap on Google API calls per sync run.",
  "weights.searchOpportunity": "Demand involved (impressions, log-scaled).",
  "weights.rankingOpportunity": "How close the page is to a better result.",
  "weights.relevance": "How directly the site's own content is concerned.",
  "weights.qualityGap": "How far the current state is from good.",
  "weights.trend": "Size of a decline (decay).",
  "weights.effort": "Ease of the fix: cheap fixes score higher.",
  "thresholds.lowCtrMinImpressions": "A query needs at least this many impressions (28 days) before a low CTR counts.",
  "thresholds.lowCtrRatio": "Flag when CTR < expected CTR for the position × this ratio.",
  "thresholds.strikingPositionMin": "Striking-distance band: lowest average position.",
  "thresholds.strikingPositionMax": "Striking-distance band: highest average position.",
  "thresholds.decayMinClicks": "Pages need at least this many clicks in the earlier window to be checked for decay.",
  "thresholds.decayDropRatio": "A click drop of this share (0.3 = 30 %) counts as decay.",
  "thresholds.gapMinImpressions": "Minimum demand for a content-gap recommendation.",
  "thresholds.maxLinksPerPage": "Internal-link suggestions per article.",
  "thresholds.bandHigh": "Score at or above this is “high”.",
  "thresholds.bandMedium": "Score at or above this is “medium”.",
  "thresholds.brandTerms": "Queries containing these are excluded from low-CTR and gap rules.",
  "crawler.requestsPerSecond": "Politeness limit against your own site.",
  "drafts.maxRewriteRatio": "A draft may change at most this share of the article's text.",
  "llm.dailyRequestLimit": "Requests per day for the optional explanation model; 0 = none.",
  "llm.baseUrl": "Only for OpenAI-compatible endpoints (e.g. Ollama in the cluster).",
};

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function tabOf(section: string): string {
  return SETTINGS_TABS.find((t) => t.sections.includes(section))?.id ?? "other";
}

/** Dotted paths of every leaf (arrays are leaves). */
export function leafPaths(v: Json, prefix: string[] = []): string[] {
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.entries(v).flatMap(([k, x]) => leafPaths(x, [...prefix, k]));
  return prefix.length ? [prefix.join(".")] : [];
}

export function getIn(v: Json, path: string): Json | undefined {
  let cur: Json | undefined = v;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, Json>)[k];
  }
  return cur;
}

const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Paths whose value differs between two documents. */
export function changedPaths(a: Json, b: Json): string[] {
  const paths = new Set([...leafPaths(a), ...leafPaths(b)]);
  return [...paths].filter((p) => !same(getIn(a, p), getIn(b, p))).sort();
}

/** "thresholds.lowCtrRatio: Number must be …" → { "thresholds.lowCtrRatio": ["Number must be …"] }. */
export function issuesByPath(issues: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) {
    const m = /^([\w.]+):\s*(.*)$/.exec(i);
    const key = m ? m[1]! : "";
    (out[key] ??= []).push(m ? m[2]! : i);
  }
  return out;
}
