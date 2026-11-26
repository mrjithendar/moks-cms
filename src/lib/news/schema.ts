import { z } from "zod";
import { MAX_DEFAULT_CATEGORIES } from "./limits";

/**
 * News desk config shapes. They mirror seo-agent/app/news/config.py (JobConfig, Quality, NewsSettings): both
 * test suites parse docs/news/fixtures/job-config.json, so a field added on one side and not the other fails a test.
 */
export const FEATURES = ["credibility", "source_count", "burst", "recency", "topic_match", "audience", "novelty", "severity", "keyword_overlap"] as const;
export const AGENT_KEYS = ["researcher", "analyst", "writer", "fact_checker", "seo_editor", "art_director"] as const;
export const SOURCE_TYPES = ["rss", "atom", "json_api", "github_releases", "sitemap", "html_allowlisted"] as const;
export const REJECT_CATEGORIES = ["off_topic", "low_value", "duplicate", "inaccurate", "style", "other"] as const;
export const IMAGE_PROVIDERS = ["template", "gemini", "openai"] as const;
/** What a content flow writes (crew-jobs plan PR 3; a crew job until 2026-11-23): news is one kind of content. seo-agent/app/news/config.py. */
export const OUTPUTS = ["news", "article"] as const;
/** Where a content flow's candidates come from: the content sources (News Desk crew) and/or the content ideas (Editorial crew). */
export const INTAKES = ["sources", "ideas"] as const;
export const MAX_NEWS_JOBS = 25; // bounds the `job` metric label (seo-agent app/metrics.py MAX_NEWS_JOBS)

const words = z.array(z.string().trim().min(1).max(80)).max(100);

export const jobConfigSchema = z
  .object({
    source_ids: z.array(z.string().uuid()).max(200).default([]),
    include_keywords: words.default([]),
    exclude_keywords: words.default([]),
    include_entities: words.default([]),
    exclude_entities: words.default([]),
    topics: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/)).max(40).default([]),
    max_articles_per_run: z.number().int().min(0).max(20).default(3),
    max_articles_per_day: z.number().int().min(0).max(40).default(5),
    min_score: z.number().min(0).max(1).default(0.45),
    dedupe_window_days: z.number().int().min(1).max(60).default(7),
    language: z.string().regex(/^[a-z]{2}$/).default("en"),
    length_min_words: z.number().int().min(100).max(5000).default(350),
    length_max_words: z.number().int().min(150).max(8000).default(1200),
    author: z.string().max(80).nullable().default(null),
    default_categories: z.array(z.string().max(60)).max(MAX_DEFAULT_CATEGORIES).default([]),
    writing_profile_version: z.number().int().min(1).nullable().default(null),
    image_profile_version: z.number().int().min(1).nullable().default(null),
    models: z.partialRecord(z.enum(AGENT_KEYS), z.string().regex(/^claude-[a-z0-9-]{3,40}$/)).default({}),
    budget: z
      .object({
        llm_daily_usd: z.number().min(0).max(100).default(1),
        llm_monthly_usd: z.number().min(0).max(1000).default(15),
        image_daily_usd: z.number().min(0).max(100).default(0.5),
        image_monthly_usd: z.number().min(0).max(1000).default(5),
        max_tokens_per_draft: z.number().int().min(10_000).max(400_000).default(120_000),
      })
      .strict()
      .default({ llm_daily_usd: 1, llm_monthly_usd: 15, image_daily_usd: 0.5, image_monthly_usd: 5, max_tokens_per_draft: 120_000 }),
    diversity: z.object({ max_per_topic_per_day: z.number().int().min(1).max(20).default(2), max_per_source_per_day: z.number().int().min(1).max(20).default(2) }).strict().default({ max_per_topic_per_day: 2, max_per_source_per_day: 2 }),
    image: z.object({ enabled: z.boolean().default(true), provider: z.enum(IMAGE_PROVIDERS).nullable().default(null), variants: z.number().int().min(1).max(4).nullable().default(null) }).strict().default({ enabled: true, provider: null, variants: null }),
    digest_size: z.number().int().min(2).max(12).default(5),
    recency_half_life_hours: z.number().min(1).max(720).default(36),
    max_age_hours: z.number().min(1).max(2160).default(96),
    weights: z.partialRecord(z.enum(FEATURES), z.number().min(0).max(1)).default({}),
    expiry_days: z.number().int().min(1).max(3650).nullable().default(null),
    publishing_slots: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(12).default([]),
    notify: z.boolean().default(true),
    output: z.enum(OUTPUTS).default("news"),
    intake: z
      .array(z.enum(INTAKES))
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length, "list sources and ideas at most once each")
      .default(["sources"]),
    // The job's own quality-gate values, by field; a field left out uses the shared value (Settings → AI & models → AI &
    // drafts → Quality gates). Checked against the gates' own ranges when parsed (qualitySchema, below).
    quality: z
      .record(z.string(), z.number())
      .superRefine((q, ctx) => {
        const known = Object.keys(qualitySchema.shape);
        for (const k of Object.keys(q)) if (!known.includes(k)) ctx.addIssue({ code: "custom", message: `unknown quality gate ${k}`, path: [k] });
        const r = qualitySchema.safeParse({ ...qualitySchema.parse({}), ...q });
        if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: i.path });
      })
      .default({}),
  })
  .strict()
  .refine((c) => c.length_min_words < c.length_max_words, { message: "length_min_words must be below length_max_words", path: ["length_min_words"] });

export type JobConfig = z.output<typeof jobConfigSchema>;

export const jobInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().max(2000).default(""),
    enabled: z.boolean().default(false),
    cron: z.string().trim().min(9).max(100).default("0 7 * * *"),
    timezone: z.string().trim().min(1).max(60).default("Asia/Kolkata"),
    mode: z.enum(["single_stories", "daily_digest", "both"]).default("single_stories"),
    writing_profile_key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).default("news-default"),
    image_profile_key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).default("cover-template"),
    review_priority: z.number().int().min(0).max(100).default(50),
    config: jobConfigSchema.default(jobConfigSchema.parse({})),
  })
  .strict();
export type JobInput = z.output<typeof jobInput>;

export const sourceInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    type: z.enum(SOURCE_TYPES),
    url: z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "https only"),
    topic_hints: z.array(z.string().max(60)).max(20).default([]),
    credibility: z.number().min(0).max(1).default(0.7),
    fetch_interval_minutes: z.number().int().min(5).max(10080).default(60),
    enabled: z.boolean().default(false),
    terms_note: z.string().max(2000).nullable().default(null),
  })
  .strict();

export const writingProfileInput = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    name: z.string().trim().min(2).max(120),
    system_style: z.string().max(6000).default(""),
    structure_template: z.string().max(6000).default(""),
    tone: z.string().max(1000).default(""),
    audience: z.string().max(1000).default(""),
    banned_phrases: z.array(z.string().trim().min(1).max(120)).max(60).default([]),
    required_sections: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    examples: z.array(z.record(z.string(), z.string().max(4000))).max(6).default([]),
    temperature: z.number().min(0).max(1).nullable().default(null),
    model: z.string().regex(/^claude-[a-z0-9-]{3,40}$/).nullable().default(null),
  })
  .strict();

export const imageProfileInput = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    name: z.string().trim().min(2).max(120),
    provider: z.enum(IMAGE_PROVIDERS).default("template"),
    style_prompt: z.string().max(2000).default(""),
    negative_prompt: z.string().max(1000).default(""),
    aspect_ratios: z.array(z.enum(["1200x630", "1600x900"])).min(1).default(["1200x630", "1600x900"]),
    palette: z.record(z.string(), z.unknown()).default({}),
    template_fallback: z.boolean().default(true),
    variants: z.number().int().min(1).max(4).default(2),
    safety_rules: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const qualitySchema = z
  .object({
    ngram: z.number().int().min(5).max(15).default(8),
    max_ngram_overlap: z.number().min(0).max(1).default(0.12),
    max_shared_run_words: z.number().int().min(10).max(80).default(25),
    max_paragraph_cosine: z.number().min(0.5).max(1).default(0.93),
    max_quote_words: z.number().int().min(5).max(60).default(25),
    min_analysis_share: z.number().min(0).max(1).default(0.25),
    readability_min: z.number().min(-50).max(100).default(25),
    readability_max: z.number().min(0).max(120).default(75),
    title_max: z.number().int().min(30).max(110).default(60),
    meta_min: z.number().int().min(50).max(160).default(110),
    meta_max: z.number().int().min(80).max(200).default(160),
    max_internal_links: z.number().int().min(0).max(10).default(3),
  })
  .strict();

/**
 * Setting row `news`: the content flows' shared settings (where each is edited: lib/news/settings-fields.ts). `enabled` is the
 * content flows' switch (AI & SEO → Flows; it was the news desk's switch in the Newsroom, then "Jobs on"). It is absent until an admin first
 * saves it; until then the deployment's NEWS_DESK_ENABLED decides, as before (see newsDeskState). `paused` is the
 * earlier pause box: it is still honoured when a row has it, and the form now writes it as false.
 */
export const newsSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    paused: z.boolean().default(false),
    // Not enforced since the one LLM budget (plan P5): kept so rows saved before still load. No form shows them.
    llm_daily_usd: z.number().min(0).max(100).default(2),
    llm_monthly_usd: z.number().min(0).max(1000).default(20),
    image_daily_usd: z.number().min(0).max(100).default(1),
    image_monthly_usd: z.number().min(0).max(1000).default(10),
    max_drafts_per_day: z.number().int().min(0).max(100).default(10),
    image_provider: z.enum(IMAGE_PROVIDERS).default("template"),
    writer_model: z.string().regex(/^claude-[a-z0-9-]{3,40}$/).default("claude-sonnet-5-5"),
    fast_model: z.string().regex(/^claude-[a-z0-9-]{3,40}$/).default("claude-haiku-5-5"),
    vision_model: z.string().regex(/^claude-[a-z0-9-]{3,40}$/).default("claude-haiku-5-5"),
    classifier_threshold: z.number().min(0).max(1).default(0.55),
    ranker_min_feedback: z.number().int().min(20).max(10_000).default(100),
    log_retention_days: z.number().int().min(7).max(730).default(90),
    item_retention_days: z.number().int().min(14).max(730).default(180),
    draft_concurrency: z.number().int().min(1).max(4).default(2),
    max_items_per_source: z.number().int().min(5).max(200).default(50),
    quality: qualitySchema.default(qualitySchema.parse({})),
    image_prices: z.partialRecord(z.enum(IMAGE_PROVIDERS), z.number().min(0).max(5)).default({ template: 0, gemini: 0.04, openai: 0.04 }),
    paywalled_hosts: z.array(z.string().max(200)).max(200).default([]),
    primary_source_hosts: z.array(z.string().max(200)).max(200).default([]),
  })
  .strict();
export type NewsSettings = z.output<typeof newsSettingsSchema>;

const ENV_ON = ["1", "true", "yes", "on"];
const ENV_OFF = ["0", "false", "no", "off"];

/**
 * Whether the news desk runs, and who decided. The same rule as the seo-agent (seo-agent/app/news/config.py):
 * - NEWS_DESK_ENABLED set to false in the deployment: forced off, whatever the admin switch says (emergency override).
 * - Otherwise the admin switch decides once it has been saved (`enabled` in the row), together with the old `paused`.
 * - Never saved: NEWS_DESK_ENABLED=true keeps the desk on as before this switch existed; anything else is off.
 */
export type NewsDeskState = { on: boolean; by: "deployment_off" | "admin" | "deployment_legacy" | "default"; envValue: "true" | "false" | "unset" };
export function newsDeskState(settings: Pick<NewsSettings, "enabled" | "paused"> | null, env: Record<string, string | undefined> = process.env): NewsDeskState {
  const raw = (env.NEWS_DESK_ENABLED ?? "").trim().toLowerCase();
  const envValue = ENV_ON.includes(raw) ? "true" : ENV_OFF.includes(raw) ? "false" : "unset";
  if (envValue === "false") return { on: false, by: "deployment_off", envValue };
  if (settings && settings.enabled !== undefined) return { on: settings.enabled && !settings.paused, by: "admin", envValue };
  if (envValue === "true") return { on: !settings?.paused, by: "deployment_legacy", envValue };
  return { on: false, by: "default", envValue };
}

/** What the admin sees for a state (AI & SEO → Flows): one sentence, and whether the switch can change it. */
export function newsDeskStateText(st: NewsDeskState): string {
  if (st.by === "deployment_off") return "Switched off by the deployment: NEWS_DESK_ENABLED is false. Remove NEWS_DESK_ENABLED from the ConfigMaps to control content flows here.";
  if (st.by === "admin") return st.on ? "Content flows are on." : "Content flows are switched off.";
  if (st.by === "deployment_legacy") return st.on ? "Content flows are on because NEWS_DESK_ENABLED is true in the deployment. Use the switch here to control them from the admin." : "Content flows are paused.";
  return "Content flows are off. Switch them on here.";
}
