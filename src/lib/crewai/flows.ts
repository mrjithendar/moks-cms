/**
 * The SEO agent's flows as the CrewAI console shows them: a readable name, a group, one line on what each does, and
 * whether a run can be started again from the console. Pure and client-safe.
 *
 * The flows themselves are code in moks-tech/moks-seo-agent (app/flows/__init__.py SPECS). A flow this list does not
 * know (a newer agent) still shows, under its own name in "Other", and cannot be re-run from here.
 *
 * Re-run (`rerun`):
 * - "yes": the console starts the flow again with the same inputs (or edited ones), as a manual run.
 * - "review": drafting flows; their draft is regenerated from the review queue, which keeps one open draft per article.
 * - "approval": publish_flow starts only from a human approval in the review UI (the agent refuses anything else).
 * - "cron": the news dispatcher is started by its schedule only.
 * - "news": per-story news runs; retry them from the news run page.
 */

export type FlowGroup = "Content" | "Insights" | "Data sync" | "Promotion" | "News desk" | "Maintenance" | "Other";
export type Rerun = "yes" | "review" | "approval" | "cron" | "news" | "no";
export type FlowInfo = { name: string; label: string; group: FlowGroup; description: string; rerun: Rerun };

export const FLOW_GROUPS: FlowGroup[] = ["Content", "Insights", "Data sync", "Promotion", "News desk", "Maintenance", "Other"];

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
  F("promotion_flow", "Promotion", "Promotion", "yes", "The Promotion crew scores where to share new articles and drafts the posts."),
  F("content_ideas_flow", "Content ideas", "Promotion", "yes", "Turns community and search signals into article ideas for the calendar."),
  F("news_dispatch_flow", "News dispatcher", "News desk", "cron", "Starts each news job that is due (every 15 minutes)."),
  F("news_job_flow", "News job", "News desk", "yes", "Fetches, ranks and drafts the stories of one news job."),
  F("news_ingest_flow", "News ingest", "News desk", "yes", "Fetches and stores items from the news sources."),
  F("news_draft_flow", "News draft", "News desk", "news", "The News desk crew writes one story or digest."),
  F("news_image_flow", "News image", "News desk", "news", "Generates and checks a cover image for a news draft."),
  F("news_train_flow", "News model training", "News desk", "yes", "Retrains the news ranking model from editor decisions."),
  F("news_style_review_flow", "News style review", "News desk", "yes", "Reviews recent edits to keep the news writing profile current."),
  F("news_playground_flow", "News playground", "News desk", "news", "A trial draft from the profile playground."),
  F("reindex_flow", "Reindex", "Maintenance", "yes", "Rebuilds the article search index the agents and Ask the Blog use."),
  F("seo_ml_flow", "ML models", "Maintenance", "yes", "Retrains the SEO models (decay, query clusters, intent, priority, related articles)."),
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
      return "The news dispatcher runs on its schedule only.";
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
