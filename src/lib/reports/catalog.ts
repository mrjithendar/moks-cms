import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { SourceState } from "./types";

/**
 * What a report can be about (D-102): the categories, and the data sources each reads. The list of sources is code (each
 * needs its own queries), but which of them a site has is discovered: every source is probed in the database before a
 * report is built and when the form opens (its tables exist, it has rows, its integration has synced), and the crews,
 * flows, models and providers are read from the catalogue and the run history, never listed here. A source that is not
 * there is reported as such, with the reason; nothing is left out silently or filled in.
 */
export type CategoryDef = { key: string; label: string; description: string; icon: string; sources: string[]; scoped?: boolean };

export const CATEGORIES: CategoryDef[] = [
  { key: "crewai", label: "CrewAI execution and performance", description: "Flow runs, success rates, durations and the slowest steps.", icon: "flow", sources: ["flow_runs", "run_steps"], scoped: true },
  { key: "seo", label: "SEO performance", description: "Search clicks, impressions, CTR and position; growing and declining pages; recommendations.", icon: "search", sources: ["gsc_totals", "gsc_pages", "recommendations"] },
  { key: "traffic", label: "Website traffic and analytics", description: "Sessions, users, engagement and channels from Google Analytics 4.", icon: "traffic", sources: ["ga4"] },
  { key: "search", label: "Search Console and keyword performance", description: "Queries, striking-distance keywords and tracked keyword positions.", icon: "keyword", sources: ["gsc_queries", "tracked_keywords"] },
  { key: "content", label: "Content generation and publishing", description: "Posts published, AI drafts generated and decided, content flow output.", icon: "content", sources: ["posts", "drafts", "news"] },
  { key: "editorial", label: "Editorial calendar and content planning", description: "Planned, scheduled, published and late calendar items; new ideas.", icon: "calendar", sources: ["calendar", "content_ideas"] },
  { key: "quality", label: "Content quality and optimization", description: "Content audit scores, draft quality gates and failures, accepted optimisations.", icon: "quality", sources: ["audits", "drafts", "optimizations", "news"] },
  { key: "ai_usage", label: "AI and LLM usage", description: "Model calls, tokens, caching, latency and truncated answers.", icon: "ai", sources: ["llm_usage"], scoped: true },
  { key: "llm_cost", label: "LLM cost and budget analysis", description: "Cost by provider, model, crew, flow, agent and category; cost per run and per draft; budgets.", icon: "cost", sources: ["llm_usage", "llm_budget", "flow_runs"], scoped: true },
  { key: "reliability", label: "Workflow reliability and failures", description: "Failed runs and steps with their errors, stuck runs, queue and sync failures.", icon: "alert", sources: ["flow_runs", "run_steps", "jobs", "sync_jobs", "news"], scoped: true },
  { key: "agents", label: "Agent and crew performance", description: "Each agent's calls, tokens, cost, latency and truncation, by crew.", icon: "agent", sources: ["run_calls", "llm_usage"], scoped: true },
  { key: "rag", label: "RAG, embeddings and knowledge sources", description: "Indexed articles and chunks, Ask the Blog answers, retrieval evaluation, ML models.", icon: "knowledge", sources: ["chunks", "ask", "rag_eval", "ml_models"] },
  { key: "technical", label: "Technical SEO and website health", description: "Crawl issues by check and severity, broken links, search-engine submissions.", icon: "health", sources: ["tech_scans", "links", "submissions"] },
  { key: "operations", label: "Infrastructure and operational health", description: "Background jobs, data syncs, backups and the live system checks.", icon: "server", sources: ["jobs", "sync_jobs", "backups", "health"] },
  { key: "business", label: "Business and growth insights", description: "New users, comments, messages, bookings, invoices and payments.", icon: "growth", sources: ["users", "comments", "messages", "bookings", "invoices"] },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const categoryOf = (key: string) => CATEGORIES.find((c) => c.key === key);

/**
 * `empty`: what it means when the source has never had a row (what to set up). `external`: filled by an integration or a
 * sync (Search Console, GA4, run history, the agent's budget…): never having had a row means it is not set up, so its
 * figures are unknown, not zero. A site's own tables (posts, comments, the calendar) with no row really hold zero.
 */
export type SourceDef = { key: string; label: string; tables: string[]; empty: string; external?: boolean };

export const SOURCES: SourceDef[] = [
  { key: "flow_runs", label: "Flow runs", tables: ["seo_flow_runs"], empty: "no flow has run yet (the SEO agent writes these)" },
  { key: "run_steps", label: "Flow run steps", tables: ["seo_flow_run_steps"], empty: "no step history yet (run history needs migration 0036 and the agent's grants)", external: true },
  { key: "run_calls", label: "Model calls per agent", tables: ["seo_flow_run_calls"], empty: "no model call recorded per agent yet (Settings → SEO agent → Run history)", external: true },
  { key: "llm_usage", label: "LLM usage ledger", tables: ["seo_llm_usage"], empty: "no LLM call recorded yet" },
  { key: "llm_budget", label: "LLM budget", tables: ["seo_agent_llm_budget"], empty: "no LLM budget set (Settings → AI & models → LLM providers & budget)", external: true },
  { key: "gsc_totals", label: "Google Search Console (site totals)", tables: ["seo_gsc_daily_totals"], empty: "nothing synced from Search Console yet (Settings → Search & SEO → Data sources)", external: true },
  { key: "gsc_pages", label: "Google Search Console (pages)", tables: ["seo_gsc_page_daily"], empty: "nothing synced from Search Console yet", external: true },
  { key: "gsc_queries", label: "Google Search Console (queries)", tables: ["seo_gsc_query_daily"], empty: "nothing synced from Search Console yet", external: true },
  { key: "ga4", label: "Google Analytics 4", tables: ["seo_ga4_page_daily"], empty: "nothing synced from Google Analytics 4 yet (Settings → Search & SEO → Data sources)", external: true },
  { key: "recommendations", label: "SEO recommendations", tables: ["seo_recommendations"], empty: "no recommendation yet" },
  { key: "tracked_keywords", label: "Tracked keywords and rankings", tables: ["seo_tracked_keywords", "seo_serp_ranks"], empty: "no tracked keyword (AI & SEO → Keywords) or no DataForSEO ranking yet", external: true },
  { key: "posts", label: "Posts", tables: ["post"], empty: "no post yet" },
  { key: "drafts", label: "AI drafts", tables: ["seo_drafts"], empty: "no AI draft yet" },
  { key: "news", label: "Content flow runs and articles", tables: ["news_runs", "news_articles"], empty: "no content flow has run yet" },
  { key: "calendar", label: "Editorial calendar", tables: ["seo_editorial_calendar"], empty: "the calendar is empty" },
  { key: "content_ideas", label: "Content ideas", tables: ["seo_content_ideas"], empty: "no content idea yet" },
  { key: "audits", label: "Content audits", tables: ["seo_content_audits"], empty: "no content audit yet" },
  { key: "optimizations", label: "Article optimisations", tables: ["seo_article_optimizations"], empty: "no optimisation proposed yet" },
  { key: "chunks", label: "Article index (chunks and embeddings)", tables: ["seo_article_chunks"], empty: "the article index is empty (run Reindex)", external: true },
  { key: "ask", label: "Ask the Blog", tables: ["seo_ask_log", "seo_ask_gaps"], empty: "no question asked yet" },
  { key: "rag_eval", label: "Retrieval evaluation", tables: ["seo_rag_eval_runs"], empty: "no retrieval evaluation has run", external: true },
  { key: "ml_models", label: "ML models", tables: ["seo_ml_models"], empty: "no ML model trained yet" },
  { key: "tech_scans", label: "Technical crawl", tables: ["seo_technical_scans", "seo_technical_issues"], empty: "no technical crawl yet", external: true },
  { key: "links", label: "Link checks", tables: ["seo_link_checks"], empty: "no link checked yet", external: true },
  { key: "submissions", label: "Search-engine submissions", tables: ["seo_search_submissions"], empty: "nothing submitted yet" },
  { key: "jobs", label: "Background job queue", tables: ["job"], empty: "no background job yet" },
  { key: "sync_jobs", label: "Data syncs", tables: ["seo_sync_jobs"], empty: "no data sync yet" },
  { key: "backups", label: "Backups", tables: ["backup_run"], empty: "no backup has run (Tools → Backups)" },
  { key: "health", label: "System checks (live)", tables: [], empty: "" },
  { key: "users", label: "Users", tables: ["user"], empty: "no user" },
  { key: "comments", label: "Comments", tables: ["comment"], empty: "no comment yet" },
  { key: "messages", label: "Contact messages", tables: ["contact_message"], empty: "no message yet" },
  { key: "bookings", label: "Bookings", tables: ["cal_booking"], empty: "no booking yet (Cal.com)" },
  { key: "invoices", label: "Invoices and payments", tables: ["invoice", "hire_payment"], empty: "no invoice or payment yet" },
];
export const sourceOf = (key: string) => SOURCES.find((s) => s.key === key);

export type Discovered = { key: string; label: string; status: SourceState; rows: number | null; detail: string; tables: string[]; categories: string[] };

/**
 * Probe every source: its tables exist (a migration not applied, or a module not installed, means "unavailable") and
 * how many rows they hold ("empty": never had data, with what to set up). Rows in the report's dates are counted by the
 * category that reads them.
 */
export async function discoverSources(db: Db): Promise<Discovered[]> {
  const tables = [...new Set(SOURCES.flatMap((s) => s.tables))];
  const present = new Set(
    rowsOf<{ t: string }>(await db.execute(sql`select t from unnest(${`{${tables.join(",")}}`}::text[]) as t where to_regclass('public.' || quote_ident(t)) is not null`)).map((r) => r.t),
  );
  const counts = new Map<string, number>();
  for (const t of present) {
    // Exact counts would scan the big tables; a capped count is enough to tell empty from not.
    const [r] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from (select 1 from ${sql.identifier(t)} limit 100000) x`));
    counts.set(t, Number(r?.n ?? 0));
  }
  return SOURCES.map((s) => {
    const categories = CATEGORIES.filter((c) => c.sources.includes(s.key)).map((c) => c.key);
    if (!s.tables.length) return { key: s.key, label: s.label, status: "ok" as SourceState, rows: null, detail: "checked live when the report is built", tables: [], categories };
    const missing = s.tables.filter((t) => !present.has(t));
    if (missing.length === s.tables.length) return { key: s.key, label: s.label, status: "unavailable" as SourceState, rows: null, detail: `table ${missing.join(", ")} does not exist on this site (a module not installed or a migration not applied)`, tables: s.tables, categories };
    const rows = s.tables.reduce((n, t) => n + (counts.get(t) ?? 0), 0);
    return { key: s.key, label: s.label, status: (rows ? "ok" : "empty") as SourceState, rows, detail: rows ? `${s.tables.join(", ")}${rows >= 100000 ? " (100,000+ rows)" : ""}` : s.empty, tables: s.tables, categories };
  });
}

/** The crews and flows a report can be narrowed to: the catalogue, plus any flow that has runs but no catalogue row. */
export async function discoverCrewsFlows(db: Db): Promise<{ crews: { key: string; label: string }[]; flows: { key: string; label: string; crews: string[] }[] }> {
  const crews = rowsOf<{ key: string; label: string }>(await db.execute(sql`select key, label from crewai_crews where deleted_at is null order by label`).catch(() => ({ rows: [] }) as never));
  const flows = rowsOf<{ key: string; label: string; crews: string[] | string | null }>(
    await db
      .execute(
        sql`select flow_name as key, min(label) as label, array_agg(distinct c) filter (where c is not null) as crews
          from (select f.flow_name, f.label, unnest(case when cardinality(f.crews) = 0 then array[null]::text[] else f.crews end) as c from crewai_flows f where f.deleted_at is null and f.definition <> 'content') x
          group by flow_name
          union all
          select distinct r.flow_name, r.flow_name, null from seo_flow_runs r
          where not exists (select 1 from crewai_flows f where f.flow_name = r.flow_name) and r.started_at > now() - interval '180 days'
          order by 2`,
      )
      .catch(() => ({ rows: [] }) as never),
  );
  const arr = (v: string[] | string | null) => (Array.isArray(v) ? v : typeof v === "string" && v.startsWith("{") ? v.slice(1, -1).split(",").filter(Boolean) : []);
  return { crews: crews.map((c) => ({ key: String(c.key), label: String(c.label) })), flows: flows.map((f) => ({ key: String(f.key), label: String(f.label), crews: arr(f.crews) })) };
}
