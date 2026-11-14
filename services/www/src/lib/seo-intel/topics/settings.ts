import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";

/**
 * Topic discovery settings (docs/seo/TOPICS.md): one JSON document in the `setting` table (key "topics"), validated
 * with zod and merged over the defaults. No credential is stored here: the X bearer token and the DataForSEO login are
 * saved in Admin → Advanced settings (sealed) or come from the deployment.
 */
const KEY = "topics";

export const SOURCE_IDS = ["searchConsole", "hackernews", "devto", "github", "reddit", "x"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];
export const SOURCE_LABELS: Record<SourceId, string> = {
  searchConsole: "Search Console queries",
  hackernews: "Hacker News",
  devto: "dev.to",
  github: "GitHub (new repositories gaining stars)",
  reddit: "Reddit (threads collected by Promotion)",
  x: "X (needs an API bearer token)",
};

const term = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9 +#.-]{1,39}$/, "Use 2 to 40 letters, digits, spaces, + # . or -");
const weight = z.number().min(0).max(100);

export const topicsSchema = z
  .object({
    /** Master switch: off = the discovery job does nothing. */
    enabled: z.boolean(),
    sources: z.object({ searchConsole: z.boolean(), hackernews: z.boolean(), devto: z.boolean(), github: z.boolean(), reddit: z.boolean(), x: z.boolean() }),
    /** Real keyword difficulty from DataForSEO instead of the proxy (needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD). */
    dataForSeo: z.object({ enabled: z.boolean(), locationCode: z.number().int().min(1).max(99_999), languageCode: z.string().regex(/^[a-z]{2}$/, "Two letters, e.g. en") }),
    /** What the site writes about. A trend item or query must contain one of these to be considered. */
    terms: z.array(term).min(1).max(40),
    /** How much each part counts in the score. */
    weights: z.object({ demand: weight, trend: weight, fit: weight, ease: weight }).refine((w) => w.demand + w.trend + w.fit + w.ease > 0, "At least one weight must be above 0"),
    /** Candidates below this are not stored. */
    minScore: z.number().min(0).max(100),
    /** A Search Console query needs at least this many impressions in 28 days. */
    minImpressions: z.number().int().min(1).max(100_000),
    /** A Hacker News story needs at least this many points. */
    hnMinPoints: z.number().int().min(0).max(10_000),
    /** Candidates kept per run. */
    maxCandidates: z.number().int().min(5).max(200),
  })
  .strict();

export type TopicsSettings = z.infer<typeof topicsSchema>;

export const DEFAULT_TOPICS_SETTINGS: TopicsSettings = {
  enabled: true,
  sources: { searchConsole: true, hackernews: true, devto: true, github: true, reddit: true, x: false },
  dataForSeo: { enabled: false, locationCode: 2840, languageCode: "en" },
  terms: ["kubernetes", "eks", "aws", "terraform", "devops", "sre", "istio", "kong", "docker", "helm", "argocd", "github actions", "prometheus", "opentelemetry", "platform engineering", "mcp", "ai agents", "llm", "crewai", "rag"],
  weights: { demand: 30, trend: 25, fit: 20, ease: 25 },
  minScore: 40,
  minImpressions: 20,
  hnMinPoints: 30,
  maxCandidates: 60,
};

export class TopicsSettingsError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
  }
}

/** Stored document over the defaults; anything invalid in storage falls back to the defaults rather than failing. */
export function mergeTopicsSettings(stored: unknown): TopicsSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<TopicsSettings>;
  const d = DEFAULT_TOPICS_SETTINGS;
  const candidate = { ...d, ...s, sources: { ...d.sources, ...(s.sources ?? {}) }, dataForSeo: { ...d.dataForSeo, ...(s.dataForSeo ?? {}) }, weights: { ...d.weights, ...(s.weights ?? {}) } };
  const parsed = topicsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : d;
}

export async function getTopicsSettings(): Promise<TopicsSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
  return mergeTopicsSettings(row?.value);
}

export async function saveTopicsSettings(raw: unknown, actorId: string): Promise<{ before: TopicsSettings; after: TopicsSettings }> {
  const parsed = topicsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new TopicsSettingsError("The settings are not valid.", parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`));
  const next = { ...parsed.data, terms: [...new Set(parsed.data.terms)] };
  const before = await getTopicsSettings();
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return { before, after: next };
}
