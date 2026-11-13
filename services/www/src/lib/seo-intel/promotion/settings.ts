import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";

/**
 * Promotion settings (docs/seo/PROMOTION.md): one JSON document in the `setting` table (key "promotion"), validated
 * with zod and merged over the defaults. Read from the database on every call, like the SEO settings (two replicas, no
 * shared cache). No credential is stored here: the Reddit API client id and secret come only from the environment
 * (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET).
 */
const KEY = "promotion";

export const CHANNEL_IDS = ["linkedin", "reddit", "hackernews", "facebook", "x", "devto", "hashnode", "newsletter"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

const subreddit = z.string().trim().regex(/^[A-Za-z0-9_]{2,21}$/, "Use the subreddit name without r/ (letters, digits, underscore)");
const slug = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, "Use lower-case letters, digits, - or _");

export const promotionSchema = z
  .object({
    /** Master switch: off = the flows do nothing and the page says so. */
    enabled: z.boolean(),
    /** Channels that get opportunities and drafts. */
    channels: z.object({
      linkedin: z.boolean(),
      reddit: z.boolean(),
      hackernews: z.boolean(),
      facebook: z.boolean(),
      x: z.boolean(),
      devto: z.boolean(),
      hashnode: z.boolean(),
      newsletter: z.boolean(),
    }),
    /** Subreddits read for threads (top of the week). Read-only: nothing is ever posted to Reddit by the system. */
    subreddits: z.array(subreddit).max(15),
    /** A thread needs at least this many upvotes to count as a signal. */
    redditMinScore: z.number().int().min(0).max(100_000),
    utmMedium: slug,
    utmCampaign: slug,
    /** Articles without opportunities picked up per scheduled run (newest first). */
    articlesPerRun: z.number().int().min(1).max(10),
    /** Content ideas asked for per weekly run. */
    ideasPerRun: z.number().int().min(1).max(15),
    /** Channels scoring below this get no draft (they are still listed). */
    minScore: z.number().min(0).max(100),
  })
  .strict();

export type PromotionSettings = z.infer<typeof promotionSchema>;

export const DEFAULT_PROMOTION_SETTINGS: PromotionSettings = {
  enabled: true,
  channels: { linkedin: true, reddit: true, hackernews: true, facebook: true, x: true, devto: true, hashnode: true, newsletter: true },
  subreddits: ["kubernetes", "devops", "sre", "aws", "Terraform", "mlops", "platformengineering"],
  redditMinScore: 10,
  utmMedium: "social",
  utmCampaign: "promotion",
  articlesPerRun: 3,
  ideasPerRun: 8,
  minScore: 40,
};

/** Stored document over the defaults; anything invalid in storage falls back to the defaults rather than failing. */
export function mergePromotionSettings(stored: unknown): PromotionSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<PromotionSettings>;
  const candidate = { ...DEFAULT_PROMOTION_SETTINGS, ...s, channels: { ...DEFAULT_PROMOTION_SETTINGS.channels, ...(s.channels ?? {}) } };
  const parsed = promotionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_PROMOTION_SETTINGS;
}

export async function getPromotionSettings(): Promise<PromotionSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
  return mergePromotionSettings(row?.value);
}

export class PromotionSettingsError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** Validate and save the whole document. Returns before/after for the audit log (there is no secret in it). */
export async function savePromotionSettings(raw: unknown, actorId: string): Promise<{ before: PromotionSettings; after: PromotionSettings }> {
  const parsed = promotionSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new PromotionSettingsError("The settings are not valid.", parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`));
  const next = { ...parsed.data, subreddits: [...new Set(parsed.data.subreddits)] };
  const before = await getPromotionSettings();
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return { before, after: next };
}

export const enabledChannels = (s: PromotionSettings): ChannelId[] => CHANNEL_IDS.filter((c) => s.channels[c]);
