/**
 * Where each value of the setting row `news` is edited, now that there is no news settings page (2026-11-21: there is
 * no Newsroom; news is one kind of content a crew job writes). The row and its schema (lib/news/schema.ts,
 * moks-seo-agent app/news/config.py) are unchanged; each group below is drawn by components/news/JobSettingsCard.tsx
 * on the page that owns that subject and saves only its own fields (lib/news/service.ts saveNewsSettings merges).
 *
 * - The switch (`enabled`): AI & SEO → Jobs (components/news/JobsSwitch.tsx).
 * - limits:   AI & SEO → Settings → Agent limits.
 * - models:   AI & SEO → Settings → AI & drafts.
 * - quality:  AI & SEO → Settings → AI & drafts.
 * - ranking:  AI & SEO → Settings → ML & retrieval.
 * - fetching: AI & SEO → Content sources.
 * - logs:     AI & SEO → Settings → Run history.
 *
 * The values themselves (and their defaults) are the row's, as before: nothing new is preset here.
 * Pure data, no I/O: the card (browser), the section files (server) and the tests import it.
 */

export type SettingField =
  | { key: string; label: string; kind: "number"; step?: number; hint?: string; quality?: boolean }
  | { key: string; label: string; kind: "text"; hint?: string }
  | { key: string; label: string; kind: "lines"; hint?: string }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[]; hint?: string };

export type SettingGroup = { id: JobSettingGroupId; title: string; description: string; fields: SettingField[] };
export type JobSettingGroupId = "limits" | "models" | "quality" | "ranking" | "fetching" | "logs";

const q = (key: string, label: string, step = 0.01): SettingField => ({ key, label, kind: "number", step, quality: true });

export const JOB_SETTING_GROUPS: Record<JobSettingGroupId, SettingGroup> = {
  limits: {
    id: "limits",
    title: "Crew job limits",
    description: "Apply to every crew job together, on top of each job's own caps. LLM spend has no cap here: it counts in the one LLM budget (Settings → LLM budget).",
    fields: [
      { key: "max_drafts_per_day", label: "Drafts per day (all jobs)", kind: "number" },
      { key: "draft_concurrency", label: "Drafts in parallel", kind: "number", hint: "1–4; each draft is one crew run" },
      { key: "image_daily_usd", label: "Cover images per day (USD)", kind: "number", step: 0.05 },
      { key: "image_monthly_usd", label: "Cover images per month (USD)", kind: "number", step: 0.5 },
    ],
  },
  models: {
    id: "models",
    title: "Crew job models",
    description: "The models a job uses unless the job names its own (Job → AI & ML).",
    fields: [
      {
        key: "image_provider",
        label: "Cover image provider",
        kind: "select",
        options: [
          { value: "template", label: "Template (free)" },
          { value: "gemini", label: "Gemini (Admin → Integrations)" },
          { value: "openai", label: "OpenAI (OPENAI_API_KEY for the seo-agent)" },
        ],
      },
      { key: "writer_model", label: "Writer model", kind: "text" },
      { key: "fast_model", label: "Fast model (topic classification fallback)", kind: "text" },
      { key: "vision_model", label: "Vision model (cover safety, alt text)", kind: "text" },
    ],
  },
  quality: {
    id: "quality",
    title: "Quality gates",
    description: "Every draft a crew job writes is checked against these before it reaches the review queue; a draft that fails is kept with the reason.",
    fields: [
      q("max_ngram_overlap", "Max 8-gram overlap per paragraph"),
      q("max_shared_run_words", "Max verbatim run (words)", 1),
      q("max_paragraph_cosine", "Max paragraph similarity (cosine)"),
      q("max_quote_words", "Max quote length (words)", 1),
      q("min_analysis_share", "Min share of original analysis"),
      q("readability_min", "Readability min (Flesch)", 1),
      q("readability_max", "Readability max (Flesch)", 1),
      q("title_max", "Title max (characters)", 1),
      q("max_internal_links", "Max internal links", 1),
    ],
  },
  ranking: {
    id: "ranking",
    title: "Content topics and ranking",
    description: "How crew jobs classify items into content topics and when the ranking model may train from your review decisions.",
    fields: [
      { key: "classifier_threshold", label: "Topic classifier confidence", kind: "number", step: 0.01, hint: "Below this, the fast model is asked" },
      { key: "ranker_min_feedback", label: "Review decisions before the ranker trains", kind: "number" },
    ],
  },
  fetching: {
    id: "fetching",
    title: "Fetching",
    description: "How the content sources are read. robots.txt is always honoured.",
    fields: [
      { key: "paywalled_hosts", label: "Paywalled hosts (never fetched; one per line)", kind: "lines" },
      { key: "primary_source_hosts", label: "Extra primary-source hosts the researcher may fetch (one per line)", kind: "lines" },
      { key: "max_items_per_source", label: "Items per source per fetch", kind: "number" },
      { key: "item_retention_days", label: "Keep unused source items (days)", kind: "number" },
    ],
  },
  logs: {
    id: "logs",
    title: "Job run logs",
    description: "How long a crew job run's step log is kept (AI & SEO → Job runs).",
    fields: [{ key: "log_retention_days", label: "Keep job run logs (days)", kind: "number" }],
  },
};

/** The part of the row a group edits (what its card starts from and saves). */
export function groupValues(group: SettingGroup, row: Record<string, unknown>): Record<string, unknown> {
  const quality = (row.quality ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of group.fields) {
    if (f.kind === "number" && f.quality) out.quality = { ...(out.quality as Record<string, unknown> | undefined), [f.key]: quality[f.key] };
    else out[f.key] = row[f.key];
  }
  return out;
}
