import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { seal, unseal, type Sealed } from "../secrets";

/**
 * Settings of the SEO intelligence platform: one JSON document in the `setting` table (key "seo"), validated
 * with zod, merged over defaults. Read from the database on every call (no per-process cache): production runs
 * two replicas without Redis, so a cached copy could not be invalidated on the other replica (docs/seo/DECISIONS.md).
 *
 * No Google credential is ever stored here: the service-account key comes only from the environment
 * (GOOGLE_SEO_SERVICE_ACCOUNT_JSON). The optional LLM key is sealed with SETTINGS_ENCRYPTION_KEY.
 */
const KEY = "seo";

export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
<<<<<<< HEAD
export const LLM_PROVIDERS = ["openai", "gemini", "bedrock", "anthropic"] as const;
/** Draft change categories Claude may work on automatically (each togglable in Settings → Drafts). */
export const DRAFT_CATEGORIES = ["title_meta", "striking_expansion", "freshness", "internal_links", "alt_text", "faq_headings", "new_article"] as const;
export type DraftCategory = (typeof DRAFT_CATEGORIES)[number];
const modelId = z.string().trim().max(120).regex(/^[A-Za-z0-9._:\-/@]*$/, "Use the provider's model id.");
=======
export const LLM_PROVIDERS = ["openai", "gemini", "bedrock"] as const;
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd

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
  llm: z.object({
    enabled: z.boolean(),
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().trim().max(120).regex(/^[A-Za-z0-9._:\-/@]*$/, "Use the provider's model id."),
    baseUrl: z.union([z.literal(""), z.string().trim().url().startsWith("https://"), z.string().trim().regex(/^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+(\.[a-z0-9-]+)*\.svc(\.cluster\.local)?)(:\d+)?(\/.*)?$/, "Plain http is only allowed for localhost or in-cluster services (e.g. Ollama).")]),
    region: z.string().trim().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
    timeoutMs: num(2000, 120_000),
    maxOutputTokens: num(100, 4000),
    dailyRequestLimit: num(0, 5000),
  }),
  reports: z.object({
    emailEnabled: z.boolean(),
    recipients: z.array(z.string().trim().toLowerCase().email()).max(10),
  }),
<<<<<<< HEAD
  /** v2: Claude-drafted change sets (docs/seo/REVIEW_WORKFLOW.md). Automation stops at "ready for review". */
  drafts: z.object({
    enabled: z.boolean(),
    /** Empty = SEO_DRAFT_MODEL / SEO_CLASSIFY_MODEL from the environment, else the built-in defaults. */
    draftModel: modelId,
    classifyModel: modelId,
    /** Empty/0 = SEO_LLM_MONTHLY_BUDGET_USD. The environment value is a ceiling the setting cannot raise. */
    monthlyBudgetUsd: num(0, 10_000),
    effort: z.enum(["low", "medium", "high"]),
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
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
});

export type SeoSettings = z.infer<typeof settingsSchema> & { llmKey: Sealed | null };
export type SeoSettingsInput = z.input<typeof settingsSchema> & { llmApiKey?: string; clearLlmKey?: boolean };

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
  llm: { enabled: false, provider: "openai", model: "", baseUrl: "", region: "us-east-1", timeoutMs: 30_000, maxOutputTokens: 900, dailyRequestLimit: 100 },
  reports: { emailEnabled: false, recipients: [] },
<<<<<<< HEAD
  drafts: {
    enabled: true,
    draftModel: "",
    classifyModel: "",
    monthlyBudgetUsd: 0,
    effort: "medium",
    maxOutputTokens: 16_000,
    maxRewriteRatio: 0.25,
    autoEligible: { title_meta: true, striking_expansion: true, freshness: true, internal_links: true, alt_text: true, faq_headings: true, new_article: false },
    news: { enabled: true, categories: ["title_meta", "alt_text", "internal_links"] },
    weekly: { enabled: true, weekday: 2, hourUtc: 4, maxArticles: 20 },
    digest: { enabled: true, weekday: 6, hourUtc: 5, recipients: [] },
  },
  links: { enabled: true, maxNewPerDraft: 3, wordsPerLink: 250, minWordsBetween: 100, maxInboundPerTargetPerRun: 5, minRelevance: 0.12, anchorMinWords: 2, anchorMaxWords: 6 },
  submission: { indexNow: true, googleSitemap: true, urlInspection: true, inspectionDelayHours: 60 },
  keywords: { brandRegex: "jithendar", risingMinGrowth: 0.5, decliningPositions: 3, trackedAlertPositions: 3, classifyWithLlm: true, clusterSimilarity: 0.5 },
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
  llmKey: null,
};

type Stored = Partial<{ [K in keyof SeoSettings]: Partial<SeoSettings[K]> }>;

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
    llm: { ...d.llm, ...s.llm },
    reports: { ...d.reports, ...s.reports },
<<<<<<< HEAD
    drafts: {
      ...d.drafts,
      ...s.drafts,
      autoEligible: { ...d.drafts.autoEligible, ...s.drafts?.autoEligible },
      news: { ...d.drafts.news, ...s.drafts?.news },
      weekly: { ...d.drafts.weekly, ...s.drafts?.weekly },
      digest: { ...d.drafts.digest, ...s.drafts?.digest },
    },
    links: { ...d.links, ...s.links },
    submission: { ...d.submission, ...s.submission },
    keywords: { ...d.keywords, ...s.keywords },
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
    llmKey: (s.llmKey as Sealed | null | undefined) ?? null,
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

/** Validate and save. Returns the before/after (without secrets) for the audit log. */
export async function saveSeoSettings(raw: unknown, actorId: string): Promise<{ before: PublicSeoSettings; after: PublicSeoSettings }> {
  const input = (raw ?? {}) as SeoSettingsInput;
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new SettingsError("The settings are not valid.", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const v = parsed.data;
  if (v.thresholds.strikingPositionMin >= v.thresholds.strikingPositionMax) throw new SettingsError("The settings are not valid.", ["thresholds: striking-distance minimum must be below the maximum"]);
  if (v.thresholds.bandMedium >= v.thresholds.bandHigh) throw new SettingsError("The settings are not valid.", ["thresholds: the medium band must start below the high band"]);
<<<<<<< HEAD
  if (v.links.anchorMinWords > v.links.anchorMaxWords) throw new SettingsError("The settings are not valid.", ["links: the shortest anchor must not be longer than the longest"]);
  if (v.keywords.brandRegex) {
    try {
      new RegExp(v.keywords.brandRegex, "i");
    } catch {
      throw new SettingsError("The settings are not valid.", ["keywords.brandRegex: not a valid regular expression"]);
    }
  }
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
  if (Object.values(v.weights).every((w) => w === 0)) throw new SettingsError("The settings are not valid.", ["weights: at least one weight must be above 0"]);
  const current = await getSeoSettings();
  let llmKey = current.llmKey;
  if (input.clearLlmKey) llmKey = null;
  if (typeof input.llmApiKey === "string" && input.llmApiKey.trim()) {
    if (input.llmApiKey.trim().length > 400) throw new SettingsError("The settings are not valid.", ["llmApiKey: too long"]);
    llmKey = seal(input.llmApiKey.trim());
  }
  const next: SeoSettings = { ...v, llmKey };
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return { before: publicSettings(current), after: publicSettings(withEnvDefaults(next)) };
}

/** What the admin UI and API may see: everything except the sealed key (replaced by a flag). */
export type PublicSeoSettings = Omit<SeoSettings, "llmKey"> & { llmKeySet: boolean };
export function publicSettings(s: SeoSettings): PublicSeoSettings {
  const { llmKey, ...rest } = s;
  return { ...rest, llmKeySet: Boolean(llmKey) };
}

/** The LLM API key: saved (sealed) key, else the provider's environment variable. Bedrock uses pod credentials. */
export function seoLlmKey(s: SeoSettings, env: Record<string, string | undefined> = process.env): string | null {
  if (s.llm.provider === "bedrock") return null;
<<<<<<< HEAD
  // Claude: the key is a secret reference only (Kubernetes Secret → env), never stored in the database.
  if (s.llm.provider === "anthropic") return env.ANTHROPIC_API_KEY?.trim() || null;
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
  if (s.llmKey) return unseal(s.llmKey);
  const v = s.llm.provider === "gemini" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;
  return v?.trim() || null;
}

export function llmConfigured(s: SeoSettings): boolean {
  if (!s.llm.enabled || !s.llm.model) return false;
  if (s.llm.provider === "bedrock") return true;
  // Ollama and other local OpenAI-compatible servers need no key.
  if (s.llm.provider === "openai" && s.llm.baseUrl.startsWith("http://")) return true;
  return Boolean(seoLlmKey(s));
}
<<<<<<< HEAD

// --- v2: Claude drafting configuration -------------------------------------------------------------------------

export const DEFAULT_DRAFT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_CLASSIFY_MODEL = "claude-haiku-5-5";
/** Used when neither the setting nor SEO_LLM_MONTHLY_BUDGET_USD is set. */
export const DEFAULT_MONTHLY_BUDGET_USD = 10;

export type ClaudeConfig = { apiKey: string | null; draftModel: string; classifyModel: string; monthlyBudgetUsd: number; budgetSource: "env" | "settings" | "default" };

/** Models, key and budget for Claude drafting. The env budget is a hard ceiling; the setting may only lower it. */
export function claudeConfig(s: SeoSettings, env: Record<string, string | undefined> = process.env): ClaudeConfig {
  const envBudget = Number(env.SEO_LLM_MONTHLY_BUDGET_USD);
  const hasEnv = Number.isFinite(envBudget) && envBudget >= 0 && env.SEO_LLM_MONTHLY_BUDGET_USD?.trim() !== "" && env.SEO_LLM_MONTHLY_BUDGET_USD !== undefined;
  const fromSettings = s.drafts.monthlyBudgetUsd > 0 ? s.drafts.monthlyBudgetUsd : null;
  let monthlyBudgetUsd = DEFAULT_MONTHLY_BUDGET_USD;
  let budgetSource: ClaudeConfig["budgetSource"] = "default";
  if (hasEnv && fromSettings !== null) {
    monthlyBudgetUsd = Math.min(envBudget, fromSettings);
    budgetSource = fromSettings < envBudget ? "settings" : "env";
  } else if (hasEnv) {
    monthlyBudgetUsd = envBudget;
    budgetSource = "env";
  } else if (fromSettings !== null) {
    monthlyBudgetUsd = fromSettings;
    budgetSource = "settings";
  }
  return {
    apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    draftModel: s.drafts.draftModel || env.SEO_DRAFT_MODEL?.trim() || DEFAULT_DRAFT_MODEL,
    classifyModel: s.drafts.classifyModel || env.SEO_CLASSIFY_MODEL?.trim() || DEFAULT_CLASSIFY_MODEL,
    monthlyBudgetUsd,
    budgetSource,
  };
}

/** Kill switch for search-engine submission: SEO_SUBMISSION_ENABLED=true|false; unset → on only in production. */
export function submissionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.SEO_SUBMISSION_ENABLED?.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return env.APP_ENV === "production";
}
=======
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
