/**
 * The SEO agent's flows as the CrewAI console shows them: a readable name, a group, one line on what each does, and
 * whether a run can be started again from the console. Pure and client-safe.
 *
 * The flows themselves are code in the SEO agent (seo-agent/app/flows/__init__.py SPECS). Since migration 0041 (D-100)
 * the lists, names, descriptions and categories admins see come from the catalogue (lib/crewai/catalog.ts, crewai_flows),
 * which the agent's GET /flows fills; this list is the fallback for run pages of flows the catalogue does not list (the
 * runners) and for the start rules of an older agent.
 *
 * Re-run (`rerun`):
 * - "yes": the console starts the flow again with the same inputs (or edited ones), as a manual run.
 * - "review": drafting flows; their draft is regenerated from the review queue, which keeps one open draft per article.
 * - "approval": publish_flow starts only from a human approval in the review UI (the agent refuses anything else).
 * - "cron": the content flows' housekeeping is started by its schedule only.
 * - "news": per-story news runs; retry them from the news run page.
 */

export type FlowGroup = "Content" | "Insights" | "Data sync" | "Promotion" | "Content flows" | "Maintenance" | "Custom" | "Other";
export type Rerun = "yes" | "review" | "approval" | "cron" | "news" | "no";
export type FlowInfo = { name: string; label: string; group: FlowGroup; description: string; rerun: Rerun };

const F = (name: string, label: string, group: FlowGroup, rerun: Rerun, description: string): FlowInfo => ({ name, label, group, rerun, description });

export const FLOWS: FlowInfo[] = [
  F("new_article_flow", "New article", "Content", "review", "The Editorial crew researches, writes, reviews and edits a new article from a calendar item; the draft waits for review."),
  F("optimize_article_flow", "Optimize article", "Content", "review", "The Optimization crew turns recommendations into a change set for a published article; the draft waits for review."),
  F("publish_flow", "Publish", "Content", "approval", "Publishes an approved draft, verifies it live, submits it to search engines and reindexes it. Starts only from an approval."),
  F("weekly_recommendations_flow", "Weekly recommendations", "Content", "yes", "Picks this week's articles to improve and starts an Optimize article run for each."),
  F("internal_linking_flow", "Internal linking", "Content", "yes", "Plans internal links between related articles."),
  F("report_flow", "Report", "Insights", "yes", "The Report crew writes the weekly or monthly briefing, checks its numbers, renders the PDF and emails it."),
  F("tech_audit_flow", "Technical audit", "Insights", "yes", "Crawls the site and records technical SEO issues."),
  F("ask_gaps_flow", "Ask the Blog gaps", "Insights", "yes", "Groups questions Ask the Blog could not answer into article ideas."),
  F("gsc_sync_flow", "Search Console sync", "Data sync", "yes", "Imports Google Search Console data."),
  F("ga4_sync_flow", "GA4 sync", "Data sync", "yes", "Imports Google Analytics 4 data."),
  F("seo_intel_sync_flow", "SEO knowledge sync", "Data sync", "yes", "Sends the keyword clusters and Search Console performance to the shared knowledge base (moks-rag, collection seo_intel) the agents ground new articles in."),
  F("promotion_flow", "Promotion", "Promotion", "yes", "The Promotion crew scores where to share new articles and drafts the posts."),
  F("content_ideas_flow", "Content ideas", "Promotion", "yes", "Turns community and search signals into article ideas for the calendar."),
  F("custom_flow", "Custom flow", "Custom", "yes", "Runs a flow you made from crews (Flows → Custom flows): its custom crews, conditions and drafts for review. It never publishes."),
  F("news_dispatch_flow", "Content flows housekeeping", "Content flows", "cron", "Keeps the content flows' gauges current on every run (its schedule, every 15 minutes as seeded) and does their daily clean-up in the run between 03:00 and 03:15 UTC. The content flows themselves start on their own times (the one dispatcher)."),
  F("news_job_flow", "Content flow", "Content flows", "yes", "Runs one content flow (Flows → Content flows): finds stories or ideas in its sources, ranks them and drafts them for review."),
  F("news_ingest_flow", "News ingest", "Content flows", "yes", "Fetches and stores items from the news sources."),
  F("news_draft_flow", "News draft", "Content flows", "news", "The News desk crew writes one story or digest."),
  F("news_image_flow", "News image", "Content flows", "news", "Generates and checks a cover image for a news draft."),
  F("news_train_flow", "News model training", "Content flows", "yes", "Retrains the news ranking model from editor decisions."),
  F("news_style_review_flow", "News style review", "Content flows", "yes", "Reviews recent edits to keep the news writing profile current."),
  F("news_playground_flow", "News playground", "Content flows", "news", "A trial draft from the profile playground."),
  F("reindex_flow", "Reindex", "Maintenance", "yes", "Rebuilds the article search index the agents and Ask the Blog use."),
  F("rag_reindex_flow", "Hybrid RAG reindex", "Maintenance", "yes", "Sends every published post to the shared Hybrid RAG service (moks-rag, collection cms_content) one at a time and removes every other post from it, saying what happened to each. Settings → Integrations → Hybrid RAG → Reindex all posts starts it."),
  F("seo_ml_flow", "ML models", "Maintenance", "yes", "Retrains the SEO models (decay, query clusters, intent, priority, related articles)."),
  F("crew_test_flow", "Crew test run", "Maintenance", "yes", "Runs one crew with edited prompts on the inputs of an earlier run (Crews → Test run, like Jenkins Replay). Saves nothing."),
];

/**
 * Flows that tick on a short fixed schedule to keep gauges current, not work anyone asked for: the console's totals
 * (runs, success rate, run time, cost, runs per day) leave them out, so a tick every 15 minutes (~96 runs a day, each
 * a fraction of a second) does not drown the real runs. They are still listed under Flows, in Flow runs and in
 * Recent failures.
 */
export const BACKGROUND_FLOWS: readonly string[] = ["news_dispatch_flow"];

/** The crew a flow runs, for "Replay with edited prompts" (moks-seo-agent crews' CrewDef.replay). */
export const CREW_OF_FLOW: Record<string, string> = {
  new_article_flow: "editorial",
  optimize_article_flow: "optimization",
  report_flow: "report",
  promotion_flow: "promotion",
  content_ideas_flow: "promotion",
  news_draft_flow: "news",
  news_playground_flow: "news",
};

/** Flows a schedule may start: seo-agent/app/flows/__init__.py CRON_FLOWS (the agent refuses any other; seo-agent/tests/test_console.py keeps the two equal). */
export const SCHEDULABLE_FLOWS: readonly string[] = [
  "custom_flow",
  "gsc_sync_flow",
  "ga4_sync_flow",
  "tech_audit_flow",
  "weekly_recommendations_flow",
  "internal_linking_flow",
  "reindex_flow",
  "ask_gaps_flow",
  "report_flow",
  "seo_ml_flow",
  "seo_intel_sync_flow",
  "rag_reindex_flow",
  "promotion_flow",
  "content_ideas_flow",
  "news_dispatch_flow",
  "news_train_flow",
  "news_style_review_flow",
];

const BY_NAME = new Map(FLOWS.map((f) => [f.name, f]));

export function flowInfo(name: string): FlowInfo {
  return BY_NAME.get(name) ?? { name, label: name.replace(/_flow$/, "").replace(/_/g, " "), group: "Other", rerun: "no", description: "" };
}

export const flowLabel = (name: string) => flowInfo(name).label;

/** Why a run of this flow cannot be started from the console (null: it can). */
export function rerunBlocked(name: string): string | null {
  switch (flowInfo(name).rerun) {
    case "yes":
      return null;
    case "review":
      return "Drafting runs are regenerated from the review queue, which keeps one open draft per article.";
    case "approval":
      return "Publish runs start only from an approval in the review queue.";
    case "cron":
      return "The news dispatcher runs on its schedule only (CrewAI console → Schedules → news-dispatch → Run now).";
    case "news":
      return "Retry news drafts and images from the news run page.";
    default:
      return "This flow is not known to this version of the console.";
  }
}

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "paused_budget"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_STATUSES: readonly string[] = ["queued", "running"];
export const TRIGGERS = ["cron", "manual", "approval", "flow", "mcp"] as const;

export const TRIGGER_LABELS: Record<string, string> = { cron: "Schedule", manual: "Manual", approval: "Approval", flow: "Another flow", mcp: "MCP client" };
export const STATUS_LABELS: Record<string, string> = { queued: "Queued", running: "In progress", succeeded: "Success", failed: "Failure", cancelled: "Cancelled", paused_budget: "Paused: budget" };
