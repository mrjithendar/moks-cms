import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";

/**
 * Settings of the SEO intelligence platform: one JSON document in the `setting` table (key "seo"), validated
 * with zod, merged over defaults. Read from the database on every call (no per-process cache): production runs
 * two replicas without Redis, so a cached copy could not be invalidated on the other replica (docs/seo/DECISIONS.md).
 *
 * No Google credential is ever stored here: the service-account key comes only from the environment
 * (GOOGLE_SEO_SERVICE_ACCOUNT_JSON). No LLM provider, model or key either (D-110): model calls go through LiteLLM
 * (lib/llm/client.ts), which holds them; this document names LiteLLM aliases at most (AI visibility).
 */
const KEY = "seo";

export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
/** Draft change categories the model may work on automatically (each togglable in Settings → Drafts). */
export const DRAFT_CATEGORIES = ["title_meta", "striking_expansion", "freshness", "internal_links", "alt_text", "faq_headings", "new_article"] as const;
export type DraftCategory = (typeof DRAFT_CATEGORIES)[number];
/** A LiteLLM alias (Models + Endpoints in LiteLLM); empty = not set. */
const aliasName = z.string().trim().max(120).regex(/^[A-Za-z0-9._:\-/@]*$/, "Use the alias exactly as LiteLLM names it.");

const hour = z.coerce.number().int().min(0).max(23);
const weekday = z.coerce.number().int().min(0).max(6); // 0 = Sunday (UTC)
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);

export const weightsSchema = z.object({
  searchOpportunity: num(0, 100),
  rankingOpportunity: num(0, 100),
  relevance: num(0, 100),
  qualityGap: num(0, 100),
  trend: num(0, 100),
  effort: num(0, 100),
});
export type Weights = z.infer<typeof weightsSchema>;

const settingsSchema = z.object({
  google: z.object({
    /** Search Console property: "sc-domain:jithendar.com" (domain property) or "https://jithendar.com/" (URL prefix). */
    gscProperty: z.string().trim().max(200).regex(/^(|sc-domain:[a-z0-9.-]+|https:\/\/[a-z0-9.-]+\/)$/, "Use sc-domain:example.com or https://example.com/"),
    /** GA4 numeric property id (not the G-… measurement id). */
    ga4PropertyId: z.string().trim().regex(/^\d{0,20}$/, "Use the numeric GA4 property id"),
    searchTypes: z.array(z.enum(SEARCH_TYPES)).min(1).max(SEARCH_TYPES.length),
    urlInspection: z.object({ enabled: z.boolean(), dailyLimit: num(0, 2000) }),
    pageSpeed: z.object({ enabled: z.boolean() }),
  }),
  sync: z.object({
    /** Days re-synced on every daily run (GSC data is provisional for ~2–3 days). */
    trailingDays: num(1, 14),
    /** Months of history kept in the daily tables; GSC itself keeps 16. */
    retentionMonths: num(1, 36),
    /** A view is "stale" when its last successful sync is older than this. */
    staleAfterHours: num(6, 24 * 14),
    /** Upper bound on Google API requests in one run (protects quota). */
    maxRequestsPerRun: num(1, 5000),
    /** Rows per Search Analytics request (API maximum 25,000). */
    rowLimit: num(100, 25_000),
  }),
  schedules: z.object({
    gscDaily: z.object({ enabled: z.boolean(), hourUtc: hour }),
    ga4Daily: z.object({ enabled: z.boolean(), hourUtc: hour }),
    technicalWeekly: z.object({ enabled: z.boolean(), weekday, hourUtc: hour }),
    recommendationsWeekly: z.object({ enabled: z.boolean(), weekday, hourUtc: hour }),
    reportsWeekly: z.object({ enabled: z.boolean(), weekday, hourUtc: hour }),
    reportsMonthly: z.object({ enabled: z.boolean(), dayOfMonth: num(1, 28), hourUtc: hour }),
  }),
  weights: weightsSchema,
  thresholds: z.object({
    lowCtrMinImpressions: num(1, 1_000_000),
    /** Flag when CTR < expected CTR for the position band × this ratio. */
    lowCtrRatio: num(0.05, 1),
    strikingMinImpressions: num(1, 1_000_000),
    strikingPositionMin: num(1, 100),
    strikingPositionMax: num(1, 100),
    decayMinClicks: num(1, 1_000_000),
    /** Relative drop (0.3 = 30 %) between equivalent periods that counts as decay. */
    decayDropRatio: num(0.05, 1),
    gapMinImpressions: num(1, 1_000_000),
    maxLinksPerPage: num(1, 20),
    bandHigh: num(0, 1),
    bandMedium: num(0, 1),
    /** Queries containing any of these terms are brand queries (excluded from low-CTR). */
    brandTerms: z.array(z.string().trim().toLowerCase().min(2).max(60)).max(20),
  }),
  crawler: z.object({
    requestsPerSecond: num(0.1, 5),
    maxPages: num(1, 5000),
    timeoutMs: num(1000, 30_000),
    maxBytes: num(10_000, 10_000_000),
    maxRedirects: num(0, 10),
  }),
  /** The optional explanation model (llm.ts): LiteLLM's fast alias. */
  llm: z.object({
    enabled: z.boolean(),
    timeoutMs: num(2000, 120_000),
    maxOutputTokens: num(100, 4000),
    dailyRequestLimit: num(0, 5000),
  }),
  reports: z.object({
    emailEnabled: z.boolean(),
    recipients: z.array(z.string().trim().toLowerCase().email()).max(10),
    /** Report email (D-102): {title}, {period} and {site} are filled in. */
    subjectTemplate: z.string().trim().min(3).max(200),
    introText: z.string().trim().max(1000),
    attachPdf: z.boolean(),
    /** 0 = the email provider's own limit. A bigger PDF is sent as a download link. */
    attachMaxMb: num(0, 40),
    /** Download links in emails stay valid this long; 0 = the longest R2 allows (7 days). */
    linkHours: num(0, 168),
    /** Reports made in the CrewAI console are deleted (with their files) this many days after they are made; 0 = kept. */
    keepDays: num(0, 3650),
  }),
  /** v2: AI-drafted change sets (docs/seo/REVIEW_WORKFLOW.md), on LiteLLM's default alias. Automation stops at "ready for review". */
  drafts: z.object({
    enabled: z.boolean(),
    maxOutputTokens: num(1000, 32_000),
    /** Flag a draft that rewrites more than this share of the body when its recommendations did not ask for it. */
    maxRewriteRatio: num(0.05, 1),
    autoEligible: z.object(Object.fromEntries(DRAFT_CATEGORIES.map((c) => [c, z.boolean()])) as Record<DraftCategory, z.ZodBoolean>),
    /** News articles: their own (narrower) set of categories; news drafts show in the News tab. */
    news: z.object({ enabled: z.boolean(), categories: z.array(z.enum(DRAFT_CATEGORIES)).max(DRAFT_CATEGORIES.length) }),
    weekly: z.object({ enabled: z.boolean(), weekday, hourUtc: hour, maxArticles: num(1, 200) }),
    digest: z.object({ enabled: z.boolean(), weekday, hourUtc: hour, recipients: z.array(z.string().trim().toLowerCase().email()).max(10) }),
  }),
  /** v2 Phase 4: conservative automated internal linking (docs/seo/INTERNAL_LINKING.md). */
  links: z.object({
    enabled: z.boolean(),
    maxNewPerDraft: num(0, 10),
    wordsPerLink: num(100, 2000),
    minWordsBetween: num(0, 1000),
    maxInboundPerTargetPerRun: num(1, 50),
    minRelevance: num(0, 1),
    anchorMinWords: num(1, 6),
    anchorMaxWords: num(2, 10),
    /**
     * Automatic link maintenance (owner decision 2026-11-10): a weekly job plans internal links (the limits above) and
     * official-docs external links for a few published articles and PUBLISHES them without review, through the same
     * publish → verify → rollback path as an approved draft (docs/seo/INTERNAL_LINKING.md "Automatic publishing").
     */
    auto: z.object({
      enabled: z.boolean(),
      weekday,
      hourUtc: hour,
      /** Articles updated per weekly run (not aggressive: a handful at a time). */
      maxArticlesPerRun: num(1, 50),
      /** New external (official-docs) links per article; 0 turns external linking off. */
      maxExternalPerArticle: num(0, 5),
      /** An article is left alone for this many days after an automatic link update. */
      cooldownDays: num(1, 365),
    }),
    /** Weekly broken-link check of every link in published posts and pages (broken-links.ts). */
    check: z.object({
      enabled: z.boolean(),
      weekday,
      hourUtc: hour,
      /** External URLs fetched per run (the rest wait for the next run); internal links are always all checked. */
      maxExternalPerRun: num(10, 2000),
      /** An external URL that was fine is re-checked after this many days. */
      recheckDays: num(1, 90),
    }),
  }),
  /** v2 Phase 3: compliant search-engine submission (docs/seo/SUBMISSION.md). Kill switch: SEO_SUBMISSION_ENABLED. */
  submission: z.object({
    indexNow: z.boolean(),
    googleSitemap: z.boolean(),
    urlInspection: z.boolean(),
    inspectionDelayHours: num(24, 168),
  }),
  /** v2 Phase 6: keyword opportunities. */
  keywords: z.object({
    brandRegex: z.string().trim().max(200),
    risingMinGrowth: num(0.05, 10),
    decliningPositions: num(1, 50),
    trackedAlertPositions: num(1, 50),
    classifyWithLlm: z.boolean(),
    clusterSimilarity: num(0.1, 0.95),
  }),
  /** DataForSEO (dataforseo.ts): volume/difficulty, live rank tracking, backlinks. Credentials only from the environment. */
  dataforseo: z.object({
    enabled: z.boolean(),
    /** DataForSEO location code: 2840 United States, 2356 India, 2826 United Kingdom, 2276 Germany. */
    locationCode: z.coerce.number().int().min(1000).max(99_999_999),
    languageCode: z.string().trim().regex(/^[a-z]{2}(-[a-z]{2,4})?$/i, "Use a language code such as en or pt-br."),
    /** Hard monthly cap on DataForSEO spend (USD); a run stops before a request that would cross it. */
    monthlyBudgetUsd: num(0, 1000),
    keywordMetrics: z.object({ enabled: z.boolean(), maxKeywords: num(10, 10_000), refreshDays: num(7, 180) }),
    rankTracking: z.object({ enabled: z.boolean(), weekday, hourUtc: hour, depth: num(10, 100) }),
    backlinks: z.object({ enabled: z.boolean(), weekday, hourUtc: hour }),
  }),
  /** AI visibility (ai-visibility.ts): weekly prompts to AI assistants; are we cited? Keys only from the environment. */
  aiVisibility: z.object({
    enabled: z.boolean(),
    weekday,
    hourUtc: hour,
    maxPrompts: num(1, 200),
    /** Extra names that count as a mention (the site name and host always do). */
    brandNames: z.array(z.string().trim().min(3).max(60)).max(10),
    providers: z.object({ claude: z.boolean(), chatgpt: z.boolean(), perplexity: z.boolean(), gemini: z.boolean(), google_ai_overview: z.boolean() }),
    /** The LiteLLM alias each assistant is asked through (with web search); an assistant without one is not asked. */
    aliases: z.object({ claude: aliasName, chatgpt: aliasName, perplexity: aliasName, gemini: aliasName }),
  }),
  /** Run history of the SEO agent's flows (CrewAI console, migration 0036): model-call transcripts and retention. */
  runHistory: z.object({
    /** Keep each model call's system prompt, prompt and answer (the agent reads this through GET /run-history/settings). */
    transcripts: z.boolean(),
    /** Keep each run's structured log lines (redacted). Off: steps, their detail and the outcome only. */
    logs: z.boolean().default(true),
    /** Keep each step's input and output metadata (sizes, keys, short redacted previews) in its detail. */
    stepIo: z.boolean().default(true),
    logRetentionDays: num(7, 365),
    transcriptRetentionDays: num(1, 90),
  }),
});

export type SeoSettings = z.infer<typeof settingsSchema>;
export type SeoSettingsInput = z.input<typeof settingsSchema>;

export const DEFAULT_SEO_SETTINGS: SeoSettings = {
  google: { gscProperty: "", ga4PropertyId: "", searchTypes: ["web"], urlInspection: { enabled: false, dailyLimit: 200 }, pageSpeed: { enabled: false } },
  sync: { trailingDays: 4, retentionMonths: 16, staleAfterHours: 48, maxRequestsPerRun: 400, rowLimit: 25_000 },
  schedules: {
    gscDaily: { enabled: true, hourUtc: 6 },
    ga4Daily: { enabled: true, hourUtc: 6 },
    technicalWeekly: { enabled: true, weekday: 1, hourUtc: 3 },
    recommendationsWeekly: { enabled: true, weekday: 1, hourUtc: 7 },
    reportsWeekly: { enabled: true, weekday: 1, hourUtc: 8 },
    reportsMonthly: { enabled: true, dayOfMonth: 2, hourUtc: 8 },
  },
  weights: { searchOpportunity: 30, rankingOpportunity: 20, relevance: 20, qualityGap: 15, trend: 10, effort: 5 },
  thresholds: {
    lowCtrMinImpressions: 200,
    lowCtrRatio: 0.6,
    strikingMinImpressions: 100,
    strikingPositionMin: 5,
    strikingPositionMax: 20,
    decayMinClicks: 20,
    decayDropRatio: 0.3,
    gapMinImpressions: 50,
    maxLinksPerPage: 5,
    bandHigh: 0.66,
    bandMedium: 0.4,
    brandTerms: ["jithendar"],
  },
  crawler: { requestsPerSecond: 1, maxPages: 500, timeoutMs: 10_000, maxBytes: 2_000_000, maxRedirects: 5 },
  llm: { enabled: false, timeoutMs: 30_000, maxOutputTokens: 900, dailyRequestLimit: 100 },
  reports: { emailEnabled: false, recipients: [], subjectTemplate: "{title} · {period}", introText: "", attachPdf: true, attachMaxMb: 0, linkHours: 0, keepDays: 0 },
  drafts: {
    enabled: true,
    maxOutputTokens: 16_000,
    maxRewriteRatio: 0.25,
    autoEligible: { title_meta: true, striking_expansion: true, freshness: true, internal_links: true, alt_text: true, faq_headings: true, new_article: false },
    news: { enabled: true, categories: ["title_meta", "alt_text", "internal_links"] },
    weekly: { enabled: true, weekday: 2, hourUtc: 4, maxArticles: 20 },
    digest: { enabled: true, weekday: 6, hourUtc: 5, recipients: [] },
  },
  links: {
    enabled: true,
    maxNewPerDraft: 3,
    wordsPerLink: 250,
    minWordsBetween: 100,
    maxInboundPerTargetPerRun: 5,
    minRelevance: 0.12,
    anchorMinWords: 2,
    anchorMaxWords: 6,
    auto: { enabled: true, weekday: 2, hourUtc: 9, maxArticlesPerRun: 5, maxExternalPerArticle: 2, cooldownDays: 30 },
    check: { enabled: true, weekday: 3, hourUtc: 4, maxExternalPerRun: 400, recheckDays: 7 },
  },
  submission: { indexNow: true, googleSitemap: true, urlInspection: true, inspectionDelayHours: 60 },
  keywords: { brandRegex: "jithendar", risingMinGrowth: 0.5, decliningPositions: 3, trackedAlertPositions: 3, classifyWithLlm: true, clusterSimilarity: 0.5 },
  dataforseo: {
    enabled: false,
    locationCode: 2840,
    languageCode: "en",
    monthlyBudgetUsd: 5,
    keywordMetrics: { enabled: true, maxKeywords: 1000, refreshDays: 30 },
    rankTracking: { enabled: true, weekday: 3, hourUtc: 5, depth: 30 },
    backlinks: { enabled: false, weekday: 0, hourUtc: 5 },
  },
  aiVisibility: {
    enabled: false,
    weekday: 4,
    hourUtc: 6,
    maxPrompts: 25,
    brandNames: [],
    providers: { claude: true, chatgpt: false, perplexity: false, gemini: false, google_ai_overview: false },
    aliases: { claude: "moks-cms-visibility-claude", chatgpt: "moks-cms-visibility-chatgpt", perplexity: "moks-cms-visibility-perplexity", gemini: "moks-cms-visibility-gemini" },
  },
  runHistory: { transcripts: true, logs: true, stepIo: true, logRetentionDays: 90, transcriptRetentionDays: 14 },
};

type Stored = Partial<{ [K in keyof SeoSettings]: Partial<SeoSettings[K]> }>;

/** A section over its defaults, without keys it no longer has (D-110 retired the LLM provider, model and key fields). */
function known<T extends object>(d: T, s: Partial<T> | undefined): T {
  return { ...d, ...Object.fromEntries(Object.entries(s ?? {}).filter(([k]) => k in d)) } as T;
}

function merge(stored: Stored | undefined): SeoSettings {
  const s = stored ?? {};
  const d = DEFAULT_SEO_SETTINGS;
  return {
    google: { ...d.google, ...s.google },
    sync: { ...d.sync, ...s.sync },
    schedules: { ...d.schedules, ...s.schedules } as SeoSettings["schedules"],
    weights: { ...d.weights, ...s.weights },
    thresholds: { ...d.thresholds, ...s.thresholds },
    crawler: { ...d.crawler, ...s.crawler },
    llm: known(d.llm, s.llm),
    reports: { ...d.reports, ...s.reports },
    drafts: {
      ...known(d.drafts, s.drafts),
      autoEligible: { ...d.drafts.autoEligible, ...s.drafts?.autoEligible },
      news: { ...d.drafts.news, ...s.drafts?.news },
      weekly: { ...d.drafts.weekly, ...s.drafts?.weekly },
      digest: { ...d.drafts.digest, ...s.drafts?.digest },
    },
    links: { ...d.links, ...s.links, auto: { ...d.links.auto, ...(s.links?.auto as Partial<SeoSettings["links"]["auto"]> | undefined) }, check: { ...d.links.check, ...(s.links?.check as Partial<SeoSettings["links"]["check"]> | undefined) } },
    submission: { ...d.submission, ...s.submission },
    keywords: { ...d.keywords, ...s.keywords },
    dataforseo: {
      ...d.dataforseo,
      ...s.dataforseo,
      keywordMetrics: { ...d.dataforseo.keywordMetrics, ...s.dataforseo?.keywordMetrics },
      rankTracking: { ...d.dataforseo.rankTracking, ...s.dataforseo?.rankTracking },
      backlinks: { ...d.dataforseo.backlinks, ...s.dataforseo?.backlinks },
    },
    aiVisibility: {
      ...known(d.aiVisibility, s.aiVisibility),
      providers: { ...d.aiVisibility.providers, ...s.aiVisibility?.providers },
      aliases: { ...d.aiVisibility.aliases, ...s.aiVisibility?.aliases },
    },
    runHistory: { ...d.runHistory, ...s.runHistory },
  };
}

/** Property ids: saved settings win, then the deployment's environment (SEO_GSC_PROPERTY, SEO_GA4_PROPERTY_ID). */
export function withEnvDefaults(s: SeoSettings, env: Record<string, string | undefined> = process.env): SeoSettings {
  return {
    ...s,
    google: {
      ...s.google,
      gscProperty: s.google.gscProperty || env.SEO_GSC_PROPERTY?.trim() || "",
      ga4PropertyId: s.google.ga4PropertyId || env.SEO_GA4_PROPERTY_ID?.trim() || "",
    },
  };
}

export async function getSeoSettings(): Promise<SeoSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
  return withEnvDefaults(merge(row?.value as Stored | undefined));
}

export class SettingsError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/**
 * The document a save validates. A body with `only: [section, …]` (one area of AI & SEO settings saving on its own)
 * is those sections laid over the stored document, which is what the whole-document form would have sent had it
 * been loaded just now; any other body is the whole document, as before.
 */
async function documentToSave(raw: unknown): Promise<SeoSettingsInput> {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(body.only)) return body as SeoSettingsInput;
  const stored = { ...(publicSettings(await getSeoSettings()) as unknown as Record<string, unknown>) };
  const names = body.only.filter((s): s is string => typeof s === "string" && s in stored);
  if (names.length === 0 || names.length !== body.only.length) throw new SettingsError("The settings are not valid.", ["only: name the sections to save"]);
  const missing = names.filter((n) => body[n] === undefined || body[n] === null);
  if (missing.length) throw new SettingsError("The settings are not valid.", missing.map((n) => `${n}: send the section named in only`));
  return { ...stored, ...Object.fromEntries(names.map((n) => [n, body[n]])) } as unknown as SeoSettingsInput;
}

/** Validate and save. Returns the before/after (without secrets) for the audit log. */
export async function saveSeoSettings(raw: unknown, actorId: string): Promise<{ before: PublicSeoSettings; after: PublicSeoSettings }> {
  const input = await documentToSave(raw);
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new SettingsError("The settings are not valid.", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const v = parsed.data;
  if (v.thresholds.strikingPositionMin >= v.thresholds.strikingPositionMax) throw new SettingsError("The settings are not valid.", ["thresholds: striking-distance minimum must be below the maximum"]);
  if (v.thresholds.bandMedium >= v.thresholds.bandHigh) throw new SettingsError("The settings are not valid.", ["thresholds: the medium band must start below the high band"]);
  if (v.links.anchorMinWords > v.links.anchorMaxWords) throw new SettingsError("The settings are not valid.", ["links: the shortest anchor must not be longer than the longest"]);
  if (v.keywords.brandRegex) {
    try {
      new RegExp(v.keywords.brandRegex, "i");
    } catch {
      throw new SettingsError("The settings are not valid.", ["keywords.brandRegex: not a valid regular expression"]);
    }
  }
  if (Object.values(v.weights).every((w) => w === 0)) throw new SettingsError("The settings are not valid.", ["weights: at least one weight must be above 0"]);
  const current = await getSeoSettings();
  const next: SeoSettings = v;
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return { before: publicSettings(current), after: publicSettings(withEnvDefaults(next)) };
}

/** What the admin UI and API may see: the whole document (it holds no secret since D-110). */
export type PublicSeoSettings = SeoSettings;
export function publicSettings(s: SeoSettings): PublicSeoSettings {
  return s;
}

/** Kill switch for search-engine submission: SEO_SUBMISSION_ENABLED=true|false; unset → on only in production. */
export function submissionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.SEO_SUBMISSION_ENABLED?.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return env.APP_ENV === "production";
}
